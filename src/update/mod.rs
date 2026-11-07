//! Updates, from the same places and files as earlier versions of Sentry
//! Studio, so one release serves both.
//!
//! A check first asks api.sentry-six.com, which can hold back a version
//! that must be replaced by hand (the killswitch) and counts which versions
//! are in use. It is sent the install ID (`install_id`), the app version,
//! the OS and the CPU architecture. Then version.json on the channel's
//! branch names the newest version, and that version's GitHub release has
//! a manifest for each platform (latest-mac.yml, latest.yml,
//! latest-linux.yml, as electron-builder writes them) with the file to
//! install and its SHA-512. A version whose manifest isn't up yet is still
//! being built, so it isn't offered.
//!
//! Installing: on macOS the new app replaces this one in place (signed by
//! the same team); on Windows the installer (signed by one of the
//! publishers in `imp::PUBLISHERS`) runs silently and starts the app again; a .deb install
//! asks for the password and installs the package. Anywhere else (the
//! portable zip and tarball, a copy run from the disk image) the release
//! page opens instead.

mod install_id;

use base64::Engine;
use sha2::{Digest, Sha512};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub use install_id::install_id;

const OWNER: &str = "Sentry-Six";
const REPO: &str = "Sentry-Six";
const API_URL: &str = "https://api.sentry-six.com/update-check";
pub const RELEASES_URL: &str = "https://github.com/Sentry-Six/Sentry-Six/releases";

/// The version of this app.
pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Stable follows `main`; pre-release follows `Dev-SEI`, whose releases
/// are marked pre-release on GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Prerelease,
}

impl Channel {
    fn branch(self) -> &'static str {
        match self {
            Channel::Stable => "main",
            Channel::Prerelease => "Dev-SEI",
        }
    }
}

/// One version's changelog entry.
#[derive(Debug, Clone)]
pub struct Note {
    pub version: String,
    pub date: String,
    pub title: String,
    /// (type: feature, improvement, fix or another word; description)
    pub changes: Vec<(String, String)>,
}

/// The file to install, as the release's manifest lists it.
#[derive(Debug, Clone)]
pub struct Asset {
    pub url: String,
    pub file: String,
    /// Base64, as electron-builder writes it.
    pub sha512: String,
    pub size: u64,
}

/// How this copy of the app can be updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    /// Downloaded and installed by the app.
    InApp,
    /// The release page opens (portable copies, a copy run from the disk
    /// image, development builds).
    Page,
}

#[derive(Debug, Clone)]
pub struct Offer {
    pub version: String,
    /// The changelog entries after this version, newest first.
    pub notes: Vec<Note>,
    pub asset: Asset,
    pub how: How,
    /// The release page.
    pub page: String,
}

#[derive(Debug, Clone)]
pub enum Outcome {
    UpToDate,
    Offer(Offer),
    /// The server says this version must be replaced by hand.
    Critical { version: String, message: String, url: String },
    Failed(String),
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(15))).timeout_global(Some(timeout)).build().into()
}

/// A text file, or its HTTP status (0: no answer).
fn get_text(agent: &ureq::Agent, url: &str) -> Result<String, u16> {
    let mut resp = match agent.get(url).header("User-Agent", crate::USER_AGENT).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => return Err(code),
        Err(_) => return Err(0),
    };
    resp.body_mut().with_config().limit(4 << 20).read_to_string().map_err(|_| 0)
}

/// A file on the channel's branch. The query keeps caches from answering
/// with an older copy.
fn raw(channel: Channel, file: &str) -> String {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("https://raw.githubusercontent.com/{OWNER}/{REPO}/{}/{file}?cb={stamp}", channel.branch())
}

/// A file attached to a version's release.
fn release_file(version: &str, file: &str) -> String {
    format!("https://github.com/{OWNER}/{REPO}/releases/download/v{version}/{file}")
}

/// Only plain dotted versions, so one can't reach outside the release URLs.
fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    (2..=4).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| v.trim_start_matches(['v', 'V']).split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parse(a), parse(b));
    (0..a.len().max(b.len())).map(|i| a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0))).find(|o| o.is_ne()).unwrap_or(std::cmp::Ordering::Equal)
}

/// "macos", "windows" or "linux", as earlier versions report it.
pub fn platform() -> &'static str {
    std::env::consts::OS
}

/// Node's names: x64, arm64.
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// The server's answer, as far as the check uses it.
struct Api {
    force_manual: bool,
    new_version: String,
    message: String,
    download_url: String,
}

fn ask_api(agent: &ureq::Agent) -> Option<Api> {
    let body = serde_json::json!({
        "fingerprint": install_id(),
        "current_version": format!("v{}", current()),
        "platform": platform(),
        "arch": arch(),
    });
    let mut resp = agent
        .post(API_URL)
        .header("User-Agent", &format!("Sentry-Studio/{}", current()))
        .content_type("application/json")
        .send(body.to_string())
        .ok()?;
    let v: serde_json::Value = serde_json::from_str(&resp.body_mut().with_config().limit(1 << 20).read_to_string().ok()?).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(Api {
        force_manual: v.get("force_manual").and_then(|x| x.as_bool()).unwrap_or(false),
        new_version: s("new_version"),
        message: s("message"),
        download_url: s("download_url"),
    })
}

/// This platform's manifest in a release.
fn manifest_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => Some("latest-mac.yml"),
        ("windows", _) => Some("latest.yml"),
        ("linux", "x86_64") => Some("latest-linux.yml"),
        _ => None,
    }
}

/// Whether a manifest's file is the one this platform installs.
fn wanted(file: &str, version: &str) -> bool {
    match std::env::consts::OS {
        "macos" => file.ends_with(".zip"),
        "windows" => file.ends_with(".exe"),
        _ => file == format!("SentryStudio-{version}-linux-amd64.deb"),
    }
}

/// The `files:` list of an electron-builder manifest: (url, sha512, size).
pub fn parse_manifest(text: &str) -> Vec<(String, String, u64)> {
    type Entry = (String, Option<String>, Option<u64>);
    fn finish(entry: Option<Entry>, out: &mut Vec<(String, String, u64)>) {
        if let Some((url, Some(sha), Some(size))) = entry {
            out.push((url, sha, size));
        }
    }
    let unquote = |s: &str| s.trim().trim_matches(|c| c == '\'' || c == '"').to_string();
    let mut out = Vec::new();
    let mut entry: Option<Entry> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(url) = t.strip_prefix("- url:") {
            finish(entry.take(), &mut out);
            entry = Some((unquote(url), None, None));
        } else if !line.starts_with(' ') {
            // A top-level key ends the list.
            finish(entry.take(), &mut out);
        } else if let Some(e) = entry.as_mut() {
            if let Some(sha) = t.strip_prefix("sha512:") {
                e.1 = Some(unquote(sha));
            } else if let Some(size) = t.strip_prefix("size:") {
                e.2 = unquote(size).parse().ok();
            }
        }
    }
    finish(entry, &mut out);
    out
}

/// The changelog entries after `current`, up to `latest`, newest first.
fn notes(agent: &ureq::Agent, channel: Channel, current: &str, latest: &str) -> Vec<Note> {
    let Ok(text) = get_text(agent, &raw(channel, "changelog.json")) else { return Vec::new() };
    parse_changelog(&text).into_iter().filter(|n| compare(&n.version, current).is_gt() && compare(&n.version, latest).is_le()).collect()
}

/// This version's changelog, as built into the app (Settings › View
/// Changelog).
pub fn changelog() -> Vec<Note> {
    parse_changelog(include_str!("../../changelog.json"))
}

/// changelog.json's entries, newest first.
fn parse_changelog(text: &str) -> Vec<Note> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return Vec::new() };
    let s = |e: &serde_json::Value, k: &str| e.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut out: Vec<Note> = v
        .get("versions")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
        .map(|e| Note {
            version: s(e, "version"),
            date: s(e, "date"),
            title: s(e, "title"),
            changes: e
                .get("changes")
                .and_then(|x| x.as_array())
                .into_iter()
                .flatten()
                .map(|c| (s(c, "type"), s(c, "description")))
                .filter(|c| !c.1.is_empty())
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| compare(&b.version, &a.version));
    out
}

/// Checks the channel for a newer version. `allow_downgrade`: offer the
/// channel's version when it is older too (going back to stable from a
/// pre-release). Blocking.
pub fn check(channel: Channel, allow_downgrade: bool) -> Outcome {
    // SENTRY_STUDIO_UPDATE_AS: check as an older version to see the dialog.
    // What it offers is never installed, only its page opened.
    if let Some(pretend) = std::env::var("SENTRY_STUDIO_UPDATE_AS").ok().filter(|v| valid_version(v)) {
        return match check_as(channel, allow_downgrade, &pretend, false) {
            Outcome::Offer(offer) => Outcome::Offer(Offer { how: How::Page, ..offer }),
            other => other,
        };
    }
    check_as(channel, allow_downgrade, current(), true)
}

/// `check` as if this were version `current`; `ask_server: false` leaves
/// out api.sentry-six.com (the --update-check command).
pub fn check_as(channel: Channel, allow_downgrade: bool, current: &str, ask_server: bool) -> Outcome {
    let agent = agent(Duration::from_secs(20));
    if let Some(api) = ask_server.then(|| ask_api(&agent)).flatten() {
        if api.force_manual {
            let url = if api.download_url.starts_with("https://") { api.download_url } else { format!("{RELEASES_URL}/latest") };
            return Outcome::Critical { version: api.new_version, message: api.message, url };
        }
    }
    // The server only knows the stable line, so the channel's own files
    // decide what is offered.
    let latest = match get_text(&agent, &raw(channel, "version.json")) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("version")?.as_str().map(str::to_string)) {
            Some(v) if valid_version(&v) => v,
            _ => return Outcome::Failed("version.json is unreadable".into()),
        },
        Err(0) => return Outcome::Failed("no connection".into()),
        Err(code) => return Outcome::Failed(format!("version.json: HTTP {code}")),
    };
    let order = compare(&latest, current);
    if !(order.is_gt() || (allow_downgrade && order.is_lt())) {
        return Outcome::UpToDate;
    }
    let Some(name) = manifest_name() else { return Outcome::UpToDate };
    let text = match get_text(&agent, &release_file(&latest, name)) {
        Ok(t) => t,
        // The release (or this platform's build) isn't up yet.
        Err(404) => return Outcome::UpToDate,
        Err(code) => return Outcome::Failed(format!("{name}: HTTP {code}")),
    };
    let Some((file, sha512, size)) = parse_manifest(&text).into_iter().find(|(f, _, _)| wanted(f, &latest)) else {
        return Outcome::Failed(format!("{name} lists no file for this computer"));
    };
    // Only a plain file name in the release, never a path or another site.
    if file.contains(['/', '\\', ':']) || file.starts_with('.') {
        return Outcome::Failed(format!("{name} names an unexpected file"));
    }
    Outcome::Offer(Offer {
        notes: notes(&agent, channel, current, &latest),
        asset: Asset { url: release_file(&latest, &file), file, sha512, size },
        how: how(),
        page: format!("{RELEASES_URL}/tag/v{latest}"),
        version: latest,
    })
}

/// Downloads the file and checks its size and SHA-512. `progress` counts
/// the bytes so far. Blocking.
pub fn download(asset: &Asset, progress: &AtomicU64) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("sentry-studio-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&asset.file);
    let agent = agent(Duration::from_secs(60 * 60));
    let mut resp = match agent.get(&asset.url).header("User-Agent", crate::USER_AGENT).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => return Err(format!("HTTP {code}")),
        Err(e) => return Err(e.to_string()),
    };
    let mut reader = resp.body_mut().with_config().limit(asset.size + 1).reader();
    let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut hash = Sha512::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hash.update(&buf[..n]);
        total += n as u64;
        progress.store(total, Ordering::Relaxed);
    }
    out.flush().map_err(|e| e.to_string())?;
    let sha = base64::engine::general_purpose::STANDARD.encode(hash.finalize());
    if total != asset.size || sha != asset.sha512 {
        let _ = std::fs::remove_file(&path);
        return Err("the download doesn't match the release".into());
    }
    Ok(path)
}

/// How this copy can be updated (see `How`).
pub fn how() -> How {
    if cfg!(debug_assertions) {
        return How::Page;
    }
    imp::how()
}

/// Installs a downloaded update and arranges for the new version to start
/// once this one quits. On success the caller quits.
pub fn install(file: &Path) -> Result<(), String> {
    imp::install(file)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::How;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// The .app this runs from.
    fn bundle() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        let app = exe.parent()?.parent()?.parent()?.to_path_buf();
        (app.extension()? == "app").then_some(app)
    }

    pub fn how() -> How {
        match bundle() {
            // Run from the disk image, or from the read-only copy macOS
            // runs a quarantined download from: it can't replace itself.
            Some(app) if !app.starts_with("/Volumes") && !app.to_string_lossy().contains("/AppTranslocation/") => How::InApp,
            _ => How::Page,
        }
    }

    /// The team an app is signed by (none for ad-hoc and unsigned builds).
    fn team(app: &Path) -> Option<String> {
        let out = Command::new("/usr/bin/codesign").arg("-dv").arg("--verbose=2").arg(app).output().ok()?;
        let text = String::from_utf8_lossy(&out.stderr).into_owned();
        let id = text.lines().find_map(|l| l.strip_prefix("TeamIdentifier="))?.trim().to_string();
        (id != "not set").then_some(id)
    }

    pub fn install(zip: &Path) -> Result<(), String> {
        let app = bundle().ok_or("not running from an app bundle")?;
        let parent = app.parent().ok_or("no folder")?.to_path_buf();
        // Unpacked next to the app, so the swap is a rename on one disk.
        let staging = parent.join(".sentry-studio-update");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir(&staging).map_err(|e| format!("can't write to {}: {e}", parent.display()))?;
        let fail = |e: String| {
            let _ = std::fs::remove_dir_all(&staging);
            Err(e)
        };
        let unpacked = Command::new("/usr/bin/ditto").arg("-x").arg("-k").arg(zip).arg(&staging).status().is_ok_and(|s| s.success());
        if !unpacked {
            return fail("couldn't unpack the update".into());
        }
        let Some(new_app) = std::fs::read_dir(&staging).ok().into_iter().flatten().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "app"))
        else {
            return fail("the update has no app in it".into());
        };
        // A signed app only takes an update signed by the same team.
        if let Some(team_now) = team(&app) {
            let valid = Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&new_app).status().is_ok_and(|s| s.success());
            if !valid || team(&new_app).as_deref() != Some(team_now.as_str()) {
                return fail("the update isn't signed by the same developer".into());
            }
        }
        let old = parent.join(".sentry-studio-previous.app");
        let _ = std::fs::remove_dir_all(&old);
        if let Err(e) = std::fs::rename(&app, &old) {
            return fail(format!("can't replace the app: {e}"));
        }
        if let Err(e) = std::fs::rename(&new_app, &app) {
            let _ = std::fs::rename(&old, &app);
            return fail(format!("can't replace the app: {e}"));
        }
        // Once this process has quit: tidy up and open the new version.
        let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf "$2" "$3"; /usr/bin/open "$4""#;
        Command::new("/bin/sh")
            .args(["-c", script, "sh", &std::process::id().to_string()])
            .args([&old, &staging, &app])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::How;
    use std::os::windows::process::CommandExt;
    use std::path::Path;

    /// The installer leaves its uninstaller next to the app; the portable
    /// zip has none.
    pub fn how() -> How {
        let installed = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("Uninstall Sentry Studio.exe").is_file())).unwrap_or(false);
        if installed {
            How::InApp
        } else {
            How::Page
        }
    }

    /// Who may sign the installer: the Azure Artifact Signing identity, and
    /// SignPath Foundation, so either can sign releases.
    const PUBLISHERS: [&str; 2] = ["Scott Vandereems", "SignPath Foundation"];

    /// The signer (the certificate's common name) of a file with a valid
    /// Authenticode signature.
    fn signer(file: &Path) -> Option<String> {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let powershell = std::env::var_os("SystemRoot")
            .map(|r| Path::new(&r).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))?;
        // The path goes in through the environment, never into the script.
        let script = "$s = Get-AuthenticodeSignature -LiteralPath $env:SENTRY_STUDIO_SIGNED_FILE; \
                      if ($s.Status -eq 'Valid') { $s.SignerCertificate.GetNameInfo('SimpleName', $false) }";
        let out = std::process::Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("SENTRY_STUDIO_SIGNED_FILE", file)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!name.is_empty()).then_some(name)
    }

    pub fn install(installer: &Path) -> Result<(), String> {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        // A signed app only runs an installer from the same publishers
        // (unsigned test builds take any that matches the release's hash).
        let app_signed = std::env::current_exe().ok().and_then(|e| signer(&e)).is_some();
        if app_signed && !signer(installer).is_some_and(|n| PUBLISHERS.contains(&n.as_str())) {
            return Err("the update isn't signed by Sentry Six".into());
        }
        // As electron-updater runs it: silently, starting the app after.
        std::process::Command::new(installer)
            .args(["--updated", "/S", "--force-run"])
            .creation_flags(DETACHED_PROCESS)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::How;
    use std::path::Path;
    use std::process::Command;

    const DEB_EXE: &str = "/usr/lib/sentry-studio/sentry-studio";

    /// Installed from the .deb (the tarball updates by hand).
    pub fn how() -> How {
        let from_deb = std::env::current_exe().ok().and_then(|e| e.canonicalize().ok()).is_some_and(|e| e == Path::new(DEB_EXE));
        if from_deb && Path::new("/usr/bin/pkexec").exists() {
            How::InApp
        } else {
            How::Page
        }
    }

    pub fn install(deb: &Path) -> Result<(), String> {
        // apt-get also installs dependencies a new version adds. Absolute
        // paths, so nothing on PATH stands in for them as root.
        let mut cmd = Command::new("/usr/bin/pkexec");
        if Path::new("/usr/bin/apt-get").exists() {
            cmd.args(["/usr/bin/apt-get", "install", "-y", "--allow-downgrades"]);
        } else {
            cmd.args(["/usr/bin/dpkg", "-i"]);
        }
        let status = cmd.arg(deb).status().map_err(|e| e.to_string())?;
        match status.code() {
            Some(0) => {}
            // pkexec: the password prompt was dismissed or refused.
            Some(126) | Some(127) => return Err("the password prompt was cancelled".into()),
            _ => return Err(format!("the package didn't install ({status})")),
        }
        let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/sentry-studio"#;
        Command::new("/bin/sh")
            .args(["-c", script, "sh", &std::process::id().to_string()])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_parse_as_electron_builder_writes_them() {
        let text = "version: 2026.45.40\nfiles:\n  - url: SentryStudio-2026.45.40-macOS.zip\n    sha512: abc+/=\n    size: 123\n  - url: 'SentryStudio-2026.45.40-macOS.dmg'\n    sha512: 'def'\n    size: 456\n    blockMapSize: 7\npath: SentryStudio-2026.45.40-macOS.zip\nsha512: abc+/=\nreleaseDate: '2026-11-07T00:00:00.000Z'\n";
        assert_eq!(
            parse_manifest(text),
            vec![
                ("SentryStudio-2026.45.40-macOS.zip".to_string(), "abc+/=".to_string(), 123),
                ("SentryStudio-2026.45.40-macOS.dmg".to_string(), "def".to_string(), 456)
            ]
        );
    }

    #[test]
    fn versions() {
        assert!(compare("2026.45.40", "2026.45.39").is_gt());
        assert!(compare("2026.9.1", "2026.45.1").is_lt());
        assert!(compare("v2026.45.40", "2026.45.40").is_eq());
        assert!(valid_version("2026.45.40"));
        assert!(!valid_version("2026.45.40/../x"));
        assert!(!valid_version("2026"));
    }

    #[test]
    fn the_built_in_changelog_reads() {
        let notes = changelog();
        assert!(notes.len() > 30);
        assert_eq!(notes[0].version, current());
        assert!(notes.windows(2).all(|w| compare(&w[0].version, &w[1].version).is_gt()));
    }
}
