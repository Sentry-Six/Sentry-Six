//! AI support chat (Sentry Assistant): the client for the Sentry Six AI
//! Support gateway, as earlier versions of Sentry Studio used it.
//!
//! The app supplies what the gateway treats as trusted client metadata (the
//! product, installed version, platform and the notice version); the user
//! supplies only their messages and decisions. Only the fixed
//! /ai-support/conversations routes are used, and redirects are refused.
//! Diagnostics are collected only after the user approves a request in the
//! chat, and uploaded once (src/diagnostics.rs).

use serde_json::{json, Value};
use std::time::Duration;

const SERVER: &str = "https://api.sentry-six.com";
const PRODUCT: &str = "sentry-studio";
/// The notice the user acknowledges (the gateway checks it).
pub const DISCLOSURE_VERSION: &str = "studio-ai-support-2026-10-31";
const FILE_CONSENT_VERSION: &str = "diagnostic-upload-v1";
const DIAGNOSTIC_FILE_NAME: &str = "sentry-studio-diagnostics.txt";
/// The longest message the gateway takes.
pub const MESSAGE_LIMIT: usize = 5000;
const MAX_RESPONSE_BYTES: u64 = 1 << 20;
/// The largest diagnostics upload, whatever a request asks for.
pub const DIAGNOSTIC_HARD_LIMIT: u64 = 2 << 20;
/// Answers can take a while (the model writes them).
const GENERATION_TIMEOUT: Duration = Duration::from_secs(120);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// A saved conversation is forgotten after this long.
pub const STORED_MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
pub const DISCORD_URL: &str = "https://discord.gg/9QZEzVwdnt";
pub const PRIVACY_URL: &str = "https://sentry-six.com/privacy";

/// A conversation on the server, and the token that opens it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub auth_token: String,
}

impl Conversation {
    /// Only well-formed IDs and tokens (they go into URLs and headers).
    pub fn valid(&self) -> bool {
        is_uuid(&self.id) && (16..=256).contains(&self.auth_token.len()) && self.auth_token.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.~-".contains(&b))
    }
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// The assistant asking for a file (only diagnostics are offered).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRequest {
    pub kind: String,
    pub label: String,
    pub file_name: String,
    pub max_bytes: u64,
    pub retention_days: u64,
}

impl FileRequest {
    /// Why it can't be approved, if it can't.
    pub fn issue(&self) -> Option<&'static str> {
        if self.kind != "diagnostics" {
            Some("This file type is not available to AI Support.")
        } else if self.retention_days != 7 {
            Some("This request does not match the required 7-day retention policy.")
        } else if self.max_bytes == 0 {
            Some("This request has an invalid size limit.")
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: String,
    pub from_user: bool,
    pub content: String,
    /// ISO 8601, as the server sends it.
    pub created_at: String,
    pub file_requests: Vec<FileRequest>,
    pub suggest_discord: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Generating,
    Closed,
}

/// The conversation as the server has it now.
#[derive(Debug, Clone)]
pub struct Reply {
    /// Set when it was just created.
    pub conversation: Option<Conversation>,
    pub status: Status,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub message: String,
    pub status: u16,
    pub code: Option<String>,
}

/// What an error means for the saved conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reset {
    /// Gone or no longer ours: start again.
    Unavailable,
    /// The notice changed: it must be acknowledged again, in a new chat.
    Disclosure,
}

impl ApiError {
    fn new(message: impl Into<String>, status: u16) -> Self {
        ApiError { message: message.into(), status, code: None }
    }

    pub fn reset(&self) -> Option<Reset> {
        match self.status {
            401 | 404 | 410 => Some(Reset::Unavailable),
            409 if self.code.as_deref() == Some("disclosure_required") || self.message.to_lowercase().contains("disclosure") => Some(Reset::Disclosure),
            _ => None,
        }
    }
}

/// A new ID for a message the user sends: also its idempotency key, so a
/// retry after a lost answer doesn't send it twice.
pub fn client_message_id() -> String {
    format!("client-{}", uuid::Uuid::new_v4())
}

/// The platform and CPU, in the names the gateway expects.
fn device_context() -> Value {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        _ => "unknown",
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => "unknown",
    };
    json!({ "platform": platform, "arch": arch })
}

struct Body {
    bytes: Vec<u8>,
    content_type: String,
}

fn json_body(v: &Value) -> Body {
    Body { bytes: v.to_string().into_bytes(), content_type: "application/json".into() }
}

fn request(method: &str, path: &str, body: Option<Body>, token: Option<&str>, idempotency: Option<&str>, timeout: Duration) -> Result<Value, ApiError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into();
    let url = format!("{SERVER}{path}");
    let headers = |r: ureq::RequestBuilder<ureq::typestate::WithBody>| {
        let mut r = r.header("X-Sentry-Product", PRODUCT).header("Accept", "application/json").header("User-Agent", crate::USER_AGENT);
        if let Some(t) = token {
            r = r.header("X-Auth-Token", t);
        }
        if let Some(k) = idempotency {
            r = r.header("Idempotency-Key", k);
        }
        r
    };
    let headers_nobody = |r: ureq::RequestBuilder<ureq::typestate::WithoutBody>| {
        let mut r = r.header("X-Sentry-Product", PRODUCT).header("Accept", "application/json").header("User-Agent", crate::USER_AGENT);
        if let Some(t) = token {
            r = r.header("X-Auth-Token", t);
        }
        if let Some(k) = idempotency {
            r = r.header("Idempotency-Key", k);
        }
        r
    };
    let result = match (method, body) {
        ("POST", Some(b)) => headers(agent.post(&url)).content_type(&b.content_type).send(&b.bytes[..]),
        ("GET", _) => headers_nobody(agent.get(&url)).call(),
        ("DELETE", _) => headers_nobody(agent.delete(&url)).call(),
        _ => return Err(ApiError::new("Unsupported AI Support request", 400)),
    };
    let mut resp = result.map_err(|e| match e {
        ureq::Error::Timeout(_) => ApiError::new("AI Support request timed out", 0),
        _ => ApiError::new("AI Support server is unavailable", 0),
    })?;
    let status = resp.status().as_u16();
    if (300..400).contains(&status) {
        return Err(ApiError::new("AI Support server returned an unexpected redirect", 502));
    }
    let text = resp
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(|_| ApiError::new("AI Support response exceeded the safety limit", 502))?;
    let data: Option<Value> = serde_json::from_str(&text).ok();
    if (200..300).contains(&status) {
        if let Some(v) = data.as_ref().filter(|v| v.is_object()) {
            return Ok(v.clone());
        }
    }
    let field = |k: &str| data.as_ref().and_then(|d| d.get(k)).and_then(Value::as_str).map(|s| s.chars().take(300).collect::<String>());
    Err(ApiError { message: field("error").unwrap_or_else(|| format!("AI Support server error ({status})")), status, code: field("code") })
}

fn parse_message(v: &Value) -> Option<ChatMessage> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let id = s("id");
    if id.is_empty() {
        return None;
    }
    let actions = v.get("actions");
    let file_requests = actions
        .and_then(|a| a.get("fileRequests"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| {
            let rs = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            FileRequest {
                kind: rs("kind"),
                label: rs("label"),
                file_name: rs("fileName"),
                max_bytes: r.get("maxBytes").and_then(Value::as_u64).unwrap_or(0),
                retention_days: r.get("retentionDays").and_then(Value::as_u64).unwrap_or(0),
            }
        })
        .collect();
    Some(ChatMessage {
        id,
        from_user: s("role") == "user",
        content: s("content"),
        created_at: s("createdAt"),
        file_requests,
        suggest_discord: actions.and_then(|a| a.get("suggestDiscord")).and_then(Value::as_bool).unwrap_or(false),
    })
}

fn parse_reply(v: &Value) -> Reply {
    let status = match v.get("status").and_then(Value::as_str) {
        Some("generating") => Status::Generating,
        Some("closed") => Status::Closed,
        _ => Status::Idle,
    };
    let conversation = match (v.get("id").and_then(Value::as_str), v.get("authToken").and_then(Value::as_str)) {
        (Some(id), Some(token)) => Some(Conversation { id: id.into(), auth_token: token.into() }).filter(Conversation::valid),
        _ => None,
    };
    let messages = v.get("messages").and_then(Value::as_array).into_iter().flatten().filter_map(parse_message).collect();
    Reply { conversation, status, messages }
}

fn require(c: &Conversation) -> Result<(), ApiError> {
    if c.valid() {
        Ok(())
    } else {
        Err(ApiError::new("A valid support conversation is required", 400))
    }
}

fn check_message(text: &str) -> Result<(), ApiError> {
    let n = text.chars().count();
    if text.trim().is_empty() || n > MESSAGE_LIMIT {
        Err(ApiError::new(format!("Messages must have 1 to {MESSAGE_LIMIT} characters"), 400))
    } else {
        Ok(())
    }
}

/// Starts a conversation with its first message.
pub fn create(message: &str, client_id: &str) -> Result<Reply, ApiError> {
    check_message(message)?;
    let body = json!({
        "productId": PRODUCT,
        "clientVersion": env!("CARGO_PKG_VERSION"),
        "deviceContext": device_context(),
        "message": message,
        "clientMessageId": client_id,
        "disclosureAccepted": true,
        "disclosureVersion": DISCLOSURE_VERSION,
    });
    let v = request("POST", "/ai-support/conversations", Some(json_body(&body)), None, Some(client_id), GENERATION_TIMEOUT)?;
    let reply = parse_reply(&v);
    if reply.conversation.is_none() {
        return Err(ApiError::new("The support server returned an incomplete conversation", 502));
    }
    Ok(reply)
}

pub fn fetch(c: &Conversation) -> Result<Reply, ApiError> {
    require(c)?;
    let v = request("GET", &format!("/ai-support/conversations/{}/messages", c.id), None, Some(&c.auth_token), None, READ_TIMEOUT)?;
    Ok(parse_reply(&v))
}

pub fn send(c: &Conversation, content: &str, client_id: &str) -> Result<Reply, ApiError> {
    require(c)?;
    check_message(content)?;
    let body = json!({ "content": content, "clientMessageId": client_id });
    let v = request(
        "POST",
        &format!("/ai-support/conversations/{}/messages", c.id),
        Some(json_body(&body)),
        Some(&c.auth_token),
        Some(client_id),
        GENERATION_TIMEOUT,
    )?;
    Ok(parse_reply(&v))
}

/// Deletes the conversation (and any diagnostics approved for it).
pub fn delete(c: &Conversation) -> Result<(), ApiError> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    require(c)?;
    // A stable key lets a lost answer be retried safely.
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(format!("delete\0{}", c.id)));
    request("DELETE", &format!("/ai-support/conversations/{}", c.id), None, Some(&c.auth_token), Some(&key), READ_TIMEOUT).map(|_| ())
}

/// The answer to a file request: (upload token, size limit) when approved.
pub fn decide(c: &Conversation, message_id: &str, index: usize, approved: bool) -> Result<Option<(String, u64)>, ApiError> {
    require(c)?;
    if !is_uuid(message_id) || index > 9 {
        return Err(ApiError::new("Invalid file request", 400));
    }
    let decision = if approved { "approved" } else { "denied" };
    let body = json!({ "messageId": message_id, "requestIndex": index, "decision": decision, "consentVersion": FILE_CONSENT_VERSION });
    let v = request(
        "POST",
        &format!("/ai-support/conversations/{}/file-decisions", c.id),
        Some(json_body(&body)),
        Some(&c.auth_token),
        Some(&format!("decision-{message_id}-{index}-{decision}")),
        READ_TIMEOUT,
    )?;
    if !approved {
        return Ok(None);
    }
    let token = v.get("uploadToken").and_then(Value::as_str).unwrap_or("").to_string();
    if !(32..=128).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(ApiError::new("No one-time upload token was returned", 502));
    }
    Ok(Some((token, v.get("maxBytes").and_then(Value::as_u64).unwrap_or(DIAGNOSTIC_HARD_LIMIT))))
}

/// Uploads the diagnostics report once: (file name, size) as stored.
pub fn upload(c: &Conversation, message_id: &str, index: usize, token: &str, report: &str) -> Result<(String, u64), ApiError> {
    require(c)?;
    if report.trim().is_empty() || report.len() as u64 > DIAGNOSTIC_HARD_LIMIT {
        return Err(ApiError::new("The diagnostics report is empty or too large", 400));
    }
    let boundary = format!("----SentryStudio{}", uuid::Uuid::new_v4().simple());
    let mut bytes = Vec::with_capacity(report.len() + 1024);
    for (name, value) in [
        ("uploadToken", token.to_string()),
        ("messageId", message_id.to_string()),
        ("requestIndex", index.to_string()),
        ("kind", "diagnostics".to_string()),
        ("consentVersion", FILE_CONSENT_VERSION.to_string()),
    ] {
        bytes.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    bytes.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{DIAGNOSTIC_FILE_NAME}\"\r\nContent-Type: text/plain\r\n\r\n").as_bytes(),
    );
    bytes.extend_from_slice(report.as_bytes());
    bytes.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let v = request(
        "POST",
        &format!("/ai-support/conversations/{}/files", c.id),
        Some(Body { bytes, content_type: format!("multipart/form-data; boundary={boundary}") }),
        Some(&c.auth_token),
        Some(&format!("upload-{message_id}-{index}")),
        GENERATION_TIMEOUT,
    )?;
    let name = v.get("fileName").and_then(Value::as_str).unwrap_or(DIAGNOSTIC_FILE_NAME).to_string();
    Ok((name, v.get("size").and_then(Value::as_u64).unwrap_or(report.len() as u64)))
}

/// Folds the server's messages into the ones shown: replaces by ID, and a
/// sent message (shown at once under its client ID) by the server's copy.
pub fn merge(current: &mut Vec<ChatMessage>, incoming: Vec<ChatMessage>) {
    for m in incoming {
        if let Some(i) = current.iter().position(|c| c.id == m.id) {
            current[i] = m;
        } else if let Some(i) = current.iter().position(|c| m.from_user && c.from_user && c.id.starts_with("client-") && c.content == m.content) {
            current[i] = m;
        } else {
            current.push(m);
        }
    }
    current.sort_by(|a, b| a.created_at.cmp(&b.created_at));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, user: bool, content: &str, at: &str) -> ChatMessage {
        ChatMessage { id: id.into(), from_user: user, content: content.into(), created_at: at.into(), file_requests: vec![], suggest_discord: false }
    }

    #[test]
    fn a_sent_message_is_replaced_by_the_servers_copy() {
        let mut shown = vec![msg("client-1", true, "hi", "2026-11-07T10:00:00.000Z")];
        merge(&mut shown, vec![msg("8f0c1a2b-0000-4000-8000-000000000001", true, "hi", "2026-11-07T10:00:00.100Z"), msg("a", false, "hello", "2026-11-07T10:00:05.000Z")]);
        assert_eq!(shown.len(), 2);
        assert!(!shown[0].id.starts_with("client-"));
        assert!(!shown[1].from_user);
    }

    #[test]
    fn replies_and_requests_parse() {
        let v = json!({
            "id": "8f0c1a2b-0000-4000-8000-000000000001", "authToken": "abcdefghijklmnopqrstuvwxyz012345",
            "status": "generating",
            "messages": [{ "id": "m1", "role": "assistant", "content": "x", "createdAt": "2026-11-07T10:00:00.000Z",
                "actions": { "fileRequests": [{ "kind": "diagnostics", "label": "L", "fileName": "f.txt", "maxBytes": 2097152, "retentionDays": 7 }], "suggestDiscord": true } }]
        });
        let r = parse_reply(&v);
        assert!(r.conversation.is_some());
        assert_eq!(r.status, Status::Generating);
        assert_eq!(r.messages[0].file_requests[0].issue(), None);
        assert!(r.messages[0].suggest_discord);
        assert!(!Conversation { id: "../x".into(), auth_token: "abcdefghijklmnopqrstuvwxyz".into() }.valid());
    }

    /// Against the real server (cargo test -- --ignored): an unknown
    /// conversation is refused in a way that starts a new chat. No AI call.
    #[test]
    #[ignore]
    fn the_server_refuses_an_unknown_conversation() {
        let c = Conversation { id: "00000000-0000-4000-8000-000000000000".into(), auth_token: "unknown-token-for-a-test-0000".into() };
        let e = fetch(&c).expect_err("an unknown conversation");
        println!("status {} code {:?}: {}", e.status, e.code, e.message);
        assert_eq!(e.reset(), Some(Reset::Unavailable));
    }

    #[test]
    fn errors_say_when_to_start_again() {
        assert_eq!(ApiError { message: "x".into(), status: 410, code: None }.reset(), Some(Reset::Unavailable));
        assert_eq!(ApiError { message: "x".into(), status: 409, code: Some("disclosure_required".into()) }.reset(), Some(Reset::Disclosure));
        assert_eq!(ApiError { message: "x".into(), status: 500, code: None }.reset(), None);
    }
}
