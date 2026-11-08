//! Share Clip: an exported video uploaded to Sentry Six's clip server, as
//! earlier versions of Sentry Studio shared them, and the list of clips
//! shared from this computer.
//!
//! The server (api.sentry-six.com) keeps a clip for the hours asked (half
//! an hour to a week) at https://clip.sentry-six.com/<code>. There is no
//! account: the server goes by the computer's address (five shares an
//! hour), and a clip is deleted with the token its upload returned, kept in
//! the settings (`sharedClips`, the same list earlier versions kept).
//!
//! A share is two calls: a reservation, which gives the link at once (the
//! page says the clip is on its way until it arrives), then the upload of
//! the MP4, streamed from disk with its progress counted.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

const SERVER: &str = "https://api.sentry-six.com";
const MAX_RESPONSE_BYTES: u64 = 1 << 20;

/// The longest export that can be shared (earlier versions' limit).
pub const MAX_SECONDS: f64 = 600.0;
/// The largest file the server takes.
pub const MAX_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// How long a link can last, in hours (the server takes 0.5 to 168).
pub const HOURS: [f64; 8] = [0.5, 1.0, 6.0, 12.0, 24.0, 48.0, 72.0, 168.0];
pub const DEFAULT_HOURS: f64 = 72.0;
/// The most clips kept in the list (as earlier versions).
const KEPT: usize = 50;

/// A clip shared from this computer (the settings' `sharedClips`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedClip {
    pub code: String,
    pub url: String,
    pub delete_token: String,
    pub expires_at: String,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub uploaded_at: String,
}

impl SharedClip {
    /// Seconds until it expires (negative once it has).
    pub fn seconds_left(&self, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
        let at = chrono::DateTime::parse_from_rfc3339(&self.expires_at).ok()?;
        Some((at.with_timezone(&chrono::Utc) - now).num_seconds())
    }
}

/// A new clip goes first; at most 50 are kept.
pub fn remember(list: &mut Vec<SharedClip>, clip: SharedClip) {
    list.retain(|c| c.code != clip.code);
    list.insert(0, clip);
    list.truncate(KEPT);
}

/// A link reserved before the upload.
#[derive(Debug, Clone)]
pub struct Reserved {
    pub code: String,
    pub url: String,
}

/// What the server says about a clip.
#[derive(Debug, Clone, Default)]
pub struct Status {
    pub deleted: bool,
    pub expires_at: Option<String>,
}

fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_global(timeout)
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

/// The server's answer: its JSON when the status is 2xx and it says
/// success, else its `error` (or the status).
fn answer(mut resp: ureq::http::Response<ureq::Body>) -> Result<Value, String> {
    let status = resp.status().as_u16();
    let text = resp.body_mut().with_config().limit(MAX_RESPONSE_BYTES).read_to_string().unwrap_or_default();
    let data: Option<Value> = serde_json::from_str(&text).ok();
    if (200..300).contains(&status) {
        if let Some(v) = data.filter(|v| v.get("success").and_then(Value::as_bool) == Some(true)) {
            return Ok(v);
        }
        return Err("the clip server gave an answer Sentry Studio didn't expect".into());
    }
    Err(data.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("the clip server answered {status}")))
}

fn post_json(server: &str, path: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    let resp = agent(Some(timeout))
        .post(&format!("{server}{path}"))
        .header("Accept", "application/json")
        .header("User-Agent", crate::USER_AGENT)
        .content_type("application/json")
        .send(body.to_string().as_bytes())
        .map_err(|e| match e {
            ureq::Error::Timeout(_) => "the clip server didn't answer in time".to_string(),
            _ => "can't reach the clip server".to_string(),
        })?;
    answer(resp)
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Reserves a link (shown at once, while the clip uploads).
pub fn reserve(hours: f64) -> Result<Reserved, String> {
    let v = post_json(SERVER, "/share/reserve", &json!({ "expirationHours": hours }), Duration::from_secs(10))?;
    let (code, url) = (text(&v, "code"), text(&v, "url"));
    if code.is_empty() || !url.starts_with("https://") {
        return Err("the clip server gave an answer Sentry Studio didn't expect".into());
    }
    Ok(Reserved { code, url })
}

/// The file, counting what has been read and stopping when cancelled.
struct Counted<R> {
    inner: R,
    sent: std::sync::Arc<AtomicU64>,
    cancel: std::sync::Arc<AtomicBool>,
}

impl<R: Read> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        let n = self.inner.read(buf)?;
        self.sent.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// The multipart form around the file: what comes before it and after.
fn form(boundary: &str, file_name: &str, hours: f64, reserved: Option<&str>) -> (Vec<u8>, Vec<u8>) {
    let mut head = Vec::new();
    let mut field = |name: &str, value: &str| head.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    if let Some(code) = reserved {
        field("reserveCode", code);
    }
    field("expirationHours", &hours.to_string());
    // The name as the file part's filename: quotes and line breaks out.
    let safe: String = file_name.chars().filter(|c| !matches!(c, '"' | '\r' | '\n' | '\\')).collect();
    head.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"video\"; filename=\"{safe}\"\r\nContent-Type: video/mp4\r\n\r\n").as_bytes());
    (head, format!("\r\n--{boundary}--\r\n").into_bytes())
}

/// Uploads the MP4 (to the reserved link, if there is one). `sent` counts
/// its bytes as they go; `cancel` stops it. Blocking.
pub fn upload(path: &Path, hours: f64, reserved: Option<&str>, sent: std::sync::Arc<AtomicU64>, cancel: std::sync::Arc<AtomicBool>) -> Result<SharedClip, String> {
    upload_to(SERVER, path, hours, reserved, sent, cancel)
}

fn upload_to(server: &str, path: &Path, hours: f64, reserved: Option<&str>, sent: std::sync::Arc<AtomicU64>, cancel: std::sync::Arc<AtomicBool>) -> Result<SharedClip, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("can't open the video: {e}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err("the video is over 3 GB, the most a shared clip can be".into());
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "clip.mp4".into());
    let boundary = format!("----SentryStudio{}", uuid::Uuid::new_v4().simple());
    let (head, tail) = form(&boundary, &file_name, hours, reserved);
    let length = head.len() as u64 + size + tail.len() as u64;
    let body = std::io::Cursor::new(head).chain(Counted { inner: std::io::BufReader::with_capacity(1 << 18, file), sent, cancel: cancel.clone() }).chain(std::io::Cursor::new(tail));
    // No limit on the whole (a slow uplink takes as long as it takes), but
    // the answer must come within two minutes of the last byte.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into();
    let resp = agent
        .post(&format!("{server}/share/upload"))
        .header("Accept", "application/json")
        .header("User-Agent", crate::USER_AGENT)
        .header("Content-Length", length.to_string())
        .content_type(format!("multipart/form-data; boundary={boundary}"))
        .send(ureq::SendBody::from_owned_reader(body))
        .map_err(|e| {
            if cancel.load(Ordering::Relaxed) {
                "cancelled".to_string()
            } else {
                match e {
                    ureq::Error::Timeout(_) => "the clip server didn't answer in time".to_string(),
                    _ => "the upload was cut off".to_string(),
                }
            }
        })?;
    let v = answer(resp)?;
    let clip = SharedClip {
        code: text(&v, "code"),
        url: text(&v, "url"),
        delete_token: text(&v, "deleteToken"),
        expires_at: text(&v, "expiresAt"),
        file_size: v.get("fileSize").and_then(Value::as_u64).unwrap_or(size),
        file_name,
        uploaded_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    if clip.code.is_empty() || !clip.url.starts_with("https://") {
        return Err("the clip server gave an answer Sentry Studio didn't expect".into());
    }
    Ok(clip)
}

/// Asks which of these clips are still up (at most 50).
pub fn check(codes: &[String]) -> Result<HashMap<String, Status>, String> {
    let codes: Vec<&String> = codes.iter().take(KEPT).collect();
    let v = post_json(SERVER, "/share/check-codes", &json!({ "codes": codes }), Duration::from_secs(10))?;
    let mut out = HashMap::new();
    if let Some(statuses) = v.get("statuses").and_then(Value::as_object) {
        for (code, s) in statuses {
            out.insert(
                code.clone(),
                Status {
                    deleted: s.get("deleted").and_then(Value::as_bool).unwrap_or(false),
                    expires_at: s.get("expiresAt").and_then(Value::as_str).map(str::to_string),
                },
            );
        }
    }
    Ok(out)
}

/// The list as the server sees it: clips it no longer has are dropped,
/// expiry times updated.
pub fn apply_statuses(list: &mut Vec<SharedClip>, statuses: &HashMap<String, Status>) {
    list.retain(|c| statuses.get(&c.code).is_some_and(|s| !s.deleted));
    for c in list.iter_mut() {
        if let Some(at) = statuses.get(&c.code).and_then(|s| s.expires_at.clone()) {
            c.expires_at = at;
        }
    }
}

/// Deletes a clip from the server.
pub fn delete(code: &str, token: &str) -> Result<(), String> {
    post_json(SERVER, "/share/delete", &json!({ "code": code, "deleteToken": token }), Duration::from_secs(15)).map(|_| ())
}

/// A link's lifetime in words ("30 minutes", "1 hour", "3 days").
pub fn hours_label(hours: f64) -> String {
    use crate::i18n::{t, tf};
    if hours < 1.0 {
        return tf("ui.share.minutes", &[("count", &format!("{:.0}", hours * 60.0))]);
    }
    if hours >= 24.0 && hours % 24.0 == 0.0 {
        let days = (hours / 24.0) as u32;
        return if days == 1 { t("ui.share.oneDay").to_string() } else { tf("ui.share.days", &[("count", &days.to_string())]) };
    }
    if hours == 1.0 {
        return t("ui.share.oneHour").to_string();
    }
    tf("ui.share.hours", &[("count", &format!("{hours:.0}"))])
}

/// What's left of a clip's life ("12m left", "5h left", "2d left", "Expired").
pub fn time_left(clip: &SharedClip, now: chrono::DateTime<chrono::Utc>) -> String {
    use crate::i18n::{t, tf};
    match clip.seconds_left(now) {
        Some(s) if s > 0 => {
            let (m, h) = (s / 60, s / 3600);
            if h >= 24 {
                tf("ui.share.daysLeft", &[("count", &(h / 24).to_string())])
            } else if h >= 1 {
                tf("ui.share.hoursLeft", &[("count", &h.to_string())])
            } else {
                tf("ui.share.minutesLeft", &[("count", &m.max(1).to_string())])
            }
        }
        _ => t("ui.share.expired").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_form_wraps_the_file() {
        let (head, tail) = form("XYZ", "Tesla \"a\".mp4", 72.0, Some("AbCd2345"));
        let head = String::from_utf8(head).unwrap();
        assert!(head.contains("name=\"reserveCode\"\r\n\r\nAbCd2345\r\n"));
        assert!(head.contains("name=\"expirationHours\"\r\n\r\n72\r\n"));
        assert!(head.ends_with("name=\"video\"; filename=\"Tesla a.mp4\"\r\nContent-Type: video/mp4\r\n\r\n"));
        assert_eq!(tail, b"\r\n--XYZ--\r\n");
    }

    /// The upload against a stand-in server on this computer: the form
    /// arrives whole, with its length, fields and the file's bytes, and the
    /// answer becomes the clip.
    #[test]
    fn uploads_the_file_as_a_form() {
        use std::io::{BufRead, BufReader, Write};
        let dir = std::env::temp_dir().join(format!("sentry-share-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Tesla 2026-11-07 08-23-55.mp4");
        let mut video = b"\0\0\0\x18ftypisom".to_vec();
        video.extend((0..300_000u32).map(|i| (i % 251) as u8));
        std::fs::write(&path, &video).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let reply = r#"{"success":true,"code":"AbCd2345","url":"https://clip.sentry-six.com/AbCd2345","deleteToken":"tok","expiresAt":"2026-11-10T00:00:00.000Z","fileSize":300012}"#;
            let mut out = stream;
            write!(out, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            (head, body)
        });
        let sent = std::sync::Arc::new(AtomicU64::new(0));
        let clip = upload_to(&format!("http://127.0.0.1:{port}"), &path, 6.0, Some("AbCd2345"), sent.clone(), std::sync::Arc::new(AtomicBool::new(false))).unwrap();
        let (head, body) = server.join().unwrap();
        assert!(head.starts_with("POST /share/upload "));
        assert!(head.to_ascii_lowercase().contains("content-type: multipart/form-data; boundary=----sentrystudio"));
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"reserveCode\"\r\n\r\nAbCd2345\r\n"));
        assert!(text.contains("name=\"expirationHours\"\r\n\r\n6\r\n"));
        assert!(text.contains("name=\"video\"; filename=\"Tesla 2026-11-07 08-23-55.mp4\""));
        let start = body.windows(4).position(|w| w == b"\r\n\r\n" ).unwrap();
        assert!(body.windows(video.len()).any(|w| w == &video[..]), "the file's bytes aren't in the form whole");
        assert!(start > 0);
        assert_eq!(sent.load(Ordering::Relaxed), video.len() as u64);
        assert_eq!((clip.code.as_str(), clip.delete_token.as_str(), clip.file_size), ("AbCd2345", "tok", 300012));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_list_keeps_fifty_newest_first() {
        let clip = |c: &str| SharedClip { code: c.into(), url: String::new(), delete_token: String::new(), expires_at: String::new(), file_size: 0, file_name: String::new(), uploaded_at: String::new() };
        let mut list = Vec::new();
        for i in 0..60 {
            remember(&mut list, clip(&format!("c{i}")));
        }
        assert_eq!(list.len(), 50);
        assert_eq!(list[0].code, "c59");
        remember(&mut list, clip("c30"));
        assert_eq!(list[0].code, "c30");
        assert_eq!(list.iter().filter(|c| c.code == "c30").count(), 1);
        // Earlier versions' entries read as they were saved.
        let old: SharedClip = serde_json::from_str(r#"{"code":"ab","url":"https://clip.sentry-six.com/ab","deleteToken":"t","expiresAt":"2026-11-10T00:00:00.000Z","fileSize":5,"fileName":"x.mp4","uploadedAt":"2026-11-07T00:00:00.000Z"}"#).unwrap();
        assert_eq!((old.delete_token.as_str(), old.file_size), ("t", 5));
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-09T22:00:00Z").unwrap().with_timezone(&chrono::Utc);
        assert_eq!(old.seconds_left(now), Some(7200));
    }
}
