//! The diagnostics report: plain text for AI support (and people) to read
//! when something goes wrong, uploaded only when the user approves it.
//!
//! It is laid out for a reader with a bounded view (the AI reads up to
//! 200,000 characters: the start and the end): a summary first (versions,
//! the computer, the decoder, problem counts, playback health and whether
//! the last session crashed), then the folder, the playback, the settings,
//! and the log, newest last, followed by earlier sessions'. The whole is
//! kept under `MAX_CHARS`, dropping the oldest ordinary log lines first and
//! keeping errors and warnings.
//!
//! Privacy: user names in paths become [user], volume and server names
//! [volume] / [server], and coordinates are removed. The app never logs
//! footage, locations or place names in the first place.

use crate::applog::{self, stats};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Well under the AI's 200,000-character view: diagnostics analyses are
/// the costly part of AI support, and the summary and recent logs are what
/// matter.
pub const MAX_CHARS: usize = 100_000;

/// What the app knows at the moment the report is asked for (gathered on
/// the UI thread; the rest is read when the report is made).
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// From the running app (false: the --diagnostics command, which has
    /// no window, so only earlier sessions' logs).
    pub live: bool,
    pub settings: Option<crate::settings::Settings>,
    /// The folder open, if any.
    pub folder: Option<PathBuf>,
    /// What's in it: layout, days, clips (no names).
    pub folder_lines: Vec<String>,
    /// Where playback is and how each camera is doing.
    pub playback_lines: Vec<String>,
    /// Other app state: window, tab, dialogs, drives, map.
    pub app_lines: Vec<String>,
}

/// The report. Blocking (it runs a few small system commands); call it off
/// the UI thread.
pub fn report(snap: &Snapshot) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Sentry Studio diagnostics");
    let _ = writeln!(
        out,
        "(User, volume and server names in paths are replaced with [user], [volume] and [server]; no footage, locations or place names are included.)"
    );

    // --- Summary -----------------------------------------------------------
    let mut summary = Vec::new();
    let channel = snap.settings.as_ref().map_or("unknown", |s| if s.prerelease { "pre-release" } else { "stable" });
    summary.push(format!("App: Sentry Studio {} ({channel} updates), {} build", env!("CARGO_PKG_VERSION"), build_kind()));
    if snap.live {
        summary.push(format!("Running for: {}", duration(applog::uptime())));
    } else {
        summary.push("Made by the --diagnostics command (no window open): see the earlier sessions below".into());
    }
    summary.push(format!("OS: {}", system::os()));
    summary.push(format!("CPU: {}", system::cpu()));
    summary.push(format!("Memory: {}", system::memory()));
    for gpu in system::gpus() {
        summary.push(format!("Graphics: {gpu}"));
    }
    let decoder = applog::decoder();
    summary.push(format!("Video decoding: {}", if decoder.is_empty() { "nothing decoded yet this session".to_string() } else { decoder }));
    if let Some(extra) = system::session() {
        summary.push(format!("Desktop: {extra}"));
    }
    summary.push(format!("Language: app {}, system {}", snap.settings.as_ref().map_or("?", |s| s.language.as_str()), system::locale()));
    let (errors, warnings) = applog::problem_counts();
    summary.push(format!("This session: {errors} errors, {warnings} warnings logged"));
    let earlier = earlier_sessions();
    if let Some(last) = earlier.last() {
        summary.push(format!("Previous session ({}): {}", last.started, last.ending()));
    }
    summary.push(format!("Playback this session: {}", stats::summary()));
    if let Some(last) = earlier.last().and_then(|s| s.lines.iter().rev().find_map(|l| l.split_once("playback this session: ").or_else(|| l.split_once("playback so far: ")))) {
        summary.push(format!("Playback, previous session: {}", last.1));
    }
    section(&mut out, "Summary", &summary);

    // --- Folder, playback, app ----------------------------------------------
    let mut folder = Vec::new();
    match &snap.folder {
        Some(path) => {
            folder.push(format!("Path: {}", redact(&path.display().to_string())));
            folder.push(format!("Drive: {}", system::volume(path)));
            folder.extend(snap.folder_lines.iter().cloned());
        }
        None => folder.push("No folder open".into()),
    }
    section(&mut out, "Folder", &folder);
    if !snap.playback_lines.is_empty() {
        section(&mut out, "Playback", &snap.playback_lines);
    }
    if !snap.app_lines.is_empty() {
        section(&mut out, "App", &snap.app_lines);
    }

    // --- Settings ----------------------------------------------------------
    if let Some(s) = &snap.settings {
        section(&mut out, "Settings", &settings_lines(s));
    }

    // --- Logs --------------------------------------------------------------
    let mut budget = MAX_CHARS.saturating_sub(out.len() + 2_000);
    // Earlier sessions get up to a quarter; this session the rest.
    let earlier_text = earlier_logs(&earlier, budget / 4);
    budget = budget.saturating_sub(earlier_text.len());
    let _ = writeln!(out, "\n== Log: this session (seconds since launch; newest last) ==");
    out.push_str(&this_session_log(budget));
    out.push_str(&earlier_text);
    out
}

fn build_kind() -> String {
    let profile = if cfg!(debug_assertions) { "development" } else { "release" };
    format!("{profile}, {}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn duration(secs: f64) -> String {
    let s = secs as u64;
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min {} s", s / 60, s % 60),
        _ => format!("{} h {} min", s / 3600, s / 60 % 60),
    }
}

fn section(out: &mut String, title: &str, lines: &[String]) {
    let _ = writeln!(out, "\n== {title} ==");
    for l in lines {
        let _ = writeln!(out, "{}", redact(l));
    }
}

fn settings_lines(s: &crate::settings::Settings) -> Vec<String> {
    let v = crate::settings::to_json(s);
    let mut lines = Vec::new();
    if let Some(map) = v.as_object() {
        for (key, value) in map {
            let shown = match key.as_str() {
                // Where, not what: a path says only what kind of drive.
                "defaultFolder" | "sentryUsbDataPath" => match value.as_str().filter(|p| !p.is_empty()) {
                    Some(p) => format!("set, on {}", system::volume(Path::new(p))),
                    None => "not set".into(),
                },
                // Its token opens the chat: never in a report.
                "aiSupportConversation" => if value.is_null() { "none".into() } else { "a chat is saved".into() },
                "keybinds" => {
                    let changed: Vec<&String> = value.as_object().map(|m| m.keys().collect()).unwrap_or_default();
                    if changed.is_empty() { "defaults".into() } else { format!("changed: {}", changed.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", ")) }
                }
                _ => value.to_string(),
            };
            lines.push(format!("{key}: {shown}"));
        }
    }
    lines.push(format!("devDisableApiRequests: {}", s.no_startup_check));
    lines
}

/// This session's lines within `budget` characters: the newest, plus every
/// earlier error and warning that fits.
fn this_session_log(budget: usize) -> String {
    let lines = applog::lines();
    let rendered: Vec<String> = lines.iter().map(|l| redact(&l.render())).collect();
    let mut keep = vec![false; rendered.len()];
    let mut used = 0;
    // Newest first, until three quarters of the budget.
    for i in (0..rendered.len()).rev() {
        if used + rendered[i].len() + 1 > budget * 3 / 4 {
            break;
        }
        used += rendered[i].len() + 1;
        keep[i] = true;
    }
    // Then earlier errors and warnings, newest first.
    for i in (0..rendered.len()).rev() {
        if keep[i] || lines[i].level > log::Level::Warn {
            continue;
        }
        if used + rendered[i].len() + 1 > budget {
            break;
        }
        used += rendered[i].len() + 1;
        keep[i] = true;
    }
    let mut out = String::new();
    let mut skipped = 0;
    for (i, line) in rendered.iter().enumerate() {
        if keep[i] {
            if skipped > 0 {
                let _ = writeln!(out, "          [{skipped} earlier lines left out]");
                skipped = 0;
            }
            let _ = writeln!(out, "{line}");
        } else {
            skipped += 1;
        }
    }
    if rendered.is_empty() {
        out.push_str("(nothing logged)\n");
    }
    out
}

/// An earlier session, from its log file.
struct Earlier {
    started: String,
    lines: Vec<String>,
    clean: bool,
    panic: Option<String>,
    errors: usize,
    warnings: usize,
}

impl Earlier {
    fn ending(&self) -> String {
        let counts = format!("{} errors, {} warnings", self.errors, self.warnings);
        match (&self.panic, self.clean) {
            (Some(p), _) => format!("CRASHED: {}; {counts}", redact(p.trim())),
            (None, true) => format!("quit normally; {counts}"),
            (None, false) => format!("did not quit normally (crash, force quit, sleep/shutdown or still running); {counts}"),
        }
    }
}

fn earlier_sessions() -> Vec<Earlier> {
    let this = applog::this_session_file();
    applog::session_files()
        .into_iter()
        .filter(|f| Some(f) != this)
        .filter_map(|f| {
            let text = std::fs::read_to_string(&f).ok()?;
            let lines: Vec<String> = text.lines().map(str::to_string).collect();
            let level = |l: &str, c: &str| l.split_whitespace().nth(1) == Some(c);
            let name = f.file_stem()?.to_string_lossy().trim_start_matches("session-").to_string();
            let started = chrono::NaiveDateTime::parse_from_str(&name, "%Y%m%d-%H%M%S").map(|d| d.format("%Y-%m-%d %H:%M").to_string()).unwrap_or(name);
            Some(Earlier {
                started,
                clean: lines.iter().any(|l| l.ends_with(applog::CLEAN_EXIT)),
                panic: lines.iter().rev().find(|l| l.contains(" panic: ")).cloned(),
                errors: lines.iter().filter(|l| level(l, "E")).count(),
                warnings: lines.iter().filter(|l| level(l, "W")).count(),
                lines,
            })
        })
        .collect()
}

/// Earlier sessions, newest first: how each ended, then the last one's
/// errors, warnings and final lines within `budget`.
fn earlier_logs(sessions: &[Earlier], budget: usize) -> String {
    if sessions.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n== Earlier sessions ==\n");
    for s in sessions.iter().rev() {
        let _ = writeln!(out, "{}: {}", s.started, s.ending());
    }
    let last = &sessions[sessions.len() - 1];
    let _ = writeln!(out, "\n== Log: previous session ({}; newest last) ==", last.started);
    let mut picked: Vec<usize> = Vec::new();
    let mut used = out.len();
    // Its last lines (how it ended), then its errors and warnings.
    for i in (0..last.lines.len()).rev().take(300) {
        if used + last.lines[i].len() + 1 > budget * 2 / 3 {
            break;
        }
        used += last.lines[i].len() + 1;
        picked.push(i);
    }
    for i in (0..last.lines.len()).rev() {
        let l = &last.lines[i];
        let problem = matches!(l.split_whitespace().nth(1), Some("E" | "W"));
        if !problem || picked.contains(&i) {
            continue;
        }
        if used + l.len() + 1 > budget {
            break;
        }
        used += l.len() + 1;
        picked.push(i);
    }
    picked.sort_unstable();
    let mut prev = None;
    for i in picked {
        if prev.is_some_and(|p: usize| i > p + 1) || (prev.is_none() && i > 0) {
            let _ = writeln!(out, "          [{} lines left out]", i - prev.map_or(0, |p| p + 1));
        }
        let _ = writeln!(out, "{}", redact(&last.lines[i]));
        prev = Some(i);
    }
    out
}

/// Removes user, volume and server names from paths, and coordinates.
pub fn redact(s: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            // Home folders: /Users/name, /home/name, /media/name, C:\Users\name
            // (also JSON-escaped; Windows names may have spaces).
            (r"(?i)(/Users/|/home/)[^/\s\x22]+", "${1}[user]"),
            (r"((?:/run)?/media/)[^/\s\x22]+", "${1}[user]"),
            (r"(?i)([A-Z]:(?:\\\\|\\)Users(?:\\\\|\\))[^\\\n\x22]+", "${1}[user]"),
            // Volume names (macOS; may have spaces) and the volume after a
            // Linux mount's user.
            (r"/Volumes/[^/\n\x22]+", "/Volumes/[volume]"),
            (r"((?:/run)?/media/\[user\]/)[^/\n\x22]+", "${1}[volume]"),
            // Network shares: \\server\share (at the start of a path), and
            // smb://server/share.
            (r"(^|[\s'\x22(])(\\\\)[^\\\s\x22]+", "${1}${2}[server]"),
            (r"(?i)((?:smb|afp|nfs|ftp|webdav)://)[^/\s'\x22]+", "${1}[server]"),
            // Coordinate pairs.
            (r"-?\d{1,3}\.\d{3,}\s*[, ]\s*-?\d{1,3}\.\d{3,}", "[coordinates]"),
        ]
        .into_iter()
        .filter_map(|(p, r)| Regex::new(p).ok().map(|re| (re, r)))
        .collect()
    });
    let mut s = s.to_string();
    for (re, with) in rules {
        s = re.replace_all(&s, *with).into_owned();
    }
    s
}

/// Facts about this computer.
mod system {
    use std::path::Path;
    use std::process::Command;

    /// A command's trimmed output.
    #[allow(dead_code)]
    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(cmd).args(args).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    }

    fn cores() -> String {
        std::thread::available_parallelism().map(|n| format!("{n} threads")).unwrap_or_default()
    }

    fn gib(bytes: u64) -> String {
        format!("{:.1} GB", bytes as f64 / (1u64 << 30) as f64)
    }

    #[cfg(target_os = "macos")]
    pub fn os() -> String {
        let v = run("/usr/bin/sw_vers", &["-productVersion"]).unwrap_or_default();
        let b = run("/usr/bin/sw_vers", &["-buildVersion"]).unwrap_or_default();
        format!("macOS {v} ({b})")
    }

    #[cfg(target_os = "macos")]
    pub fn cpu() -> String {
        let name = run("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"]).unwrap_or_else(|| "unknown".into());
        let translated = run("/usr/sbin/sysctl", &["-n", "sysctl.proc_translated"]).is_some_and(|v| v == "1");
        format!("{name}, {}{}", cores(), if translated { " (running under Rosetta)" } else { "" })
    }

    #[cfg(target_os = "macos")]
    pub fn memory() -> String {
        run("/usr/sbin/sysctl", &["-n", "hw.memsize"]).and_then(|v| v.parse().ok()).map(gib).unwrap_or_else(|| "unknown".into())
    }

    #[cfg(target_os = "macos")]
    pub fn session() -> Option<String> {
        None
    }

    #[cfg(target_os = "macos")]
    pub fn locale() -> String {
        run("/usr/bin/defaults", &["read", "-g", "AppleLocale"]).unwrap_or_else(|| "unknown".into())
    }

    #[cfg(windows)]
    fn reg_string(key: windows::core::PCWSTR, value: windows::core::PCWSTR) -> Option<String> {
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY};
        let mut buf = [0u16; 256];
        let mut len = std::mem::size_of_val(&buf) as u32;
        let ok = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, key, value, RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)) };
        if ok.is_err() {
            return None;
        }
        let chars = (len as usize / 2).saturating_sub(1).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..chars]).trim().to_string()).filter(|s| !s.is_empty())
    }

    #[cfg(windows)]
    fn reg_dword(key: windows::core::PCWSTR, value: windows::core::PCWSTR) -> Option<u32> {
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY};
        let mut v = 0u32;
        let mut len = 4u32;
        let ok = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, key, value, RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, None, Some((&mut v as *mut u32).cast()), Some(&mut len)) };
        ok.is_ok().then_some(v)
    }

    #[cfg(windows)]
    pub fn os() -> String {
        use windows::core::w;
        let key = w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
        let build: u32 = reg_string(key, w!("CurrentBuildNumber")).and_then(|b| b.parse().ok()).unwrap_or(0);
        let ubr = reg_dword(key, w!("UBR")).unwrap_or(0);
        let mut name = reg_string(key, w!("ProductName")).unwrap_or_else(|| "Windows".into());
        // ProductName still says Windows 10 on Windows 11.
        if build >= 22000 {
            name = name.replace("Windows 10", "Windows 11");
        }
        let display = reg_string(key, w!("DisplayVersion")).unwrap_or_default();
        format!("{name} {display} (build {build}.{ubr})")
    }

    #[cfg(windows)]
    pub fn cpu() -> String {
        use windows::core::w;
        let name = reg_string(w!("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0"), w!("ProcessorNameString")).unwrap_or_else(|| "unknown".into());
        format!("{name}, {}", cores())
    }

    #[cfg(windows)]
    pub fn memory() -> String {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if unsafe { GlobalMemoryStatusEx(&mut m) }.is_ok() {
            format!("{} ({} free)", gib(m.ullTotalPhys), gib(m.ullAvailPhys))
        } else {
            "unknown".into()
        }
    }

    #[cfg(windows)]
    pub fn session() -> Option<String> {
        None
    }

    #[cfg(windows)]
    pub fn locale() -> String {
        std::env::var("LANG").ok().unwrap_or_else(|| sys_locale().unwrap_or_else(|| "unknown".into()))
    }

    #[cfg(windows)]
    fn sys_locale() -> Option<String> {
        use windows::Win32::Globalization::GetUserDefaultLocaleName;
        let mut buf = [0u16; 85];
        let n = unsafe { GetUserDefaultLocaleName(&mut buf) };
        (n > 1).then(|| String::from_utf16_lossy(&buf[..n as usize - 1]))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn read_field(path: &str, key: &str) -> Option<String> {
        std::fs::read_to_string(path).ok()?.lines().find_map(|l| {
            let (k, v) = l.split_once([':', '='])?;
            (k.trim() == key).then(|| v.trim().trim_matches('"').to_string())
        })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    pub fn os() -> String {
        let name = read_field("/etc/os-release", "PRETTY_NAME").unwrap_or_else(|| "Linux".into());
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|k| k.trim().to_string()).unwrap_or_default();
        format!("{name} (kernel {kernel})")
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    pub fn cpu() -> String {
        format!("{}, {}", read_field("/proc/cpuinfo", "model name").unwrap_or_else(|| "unknown".into()), cores())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    pub fn memory() -> String {
        let kb = |k: &str| read_field("/proc/meminfo", k).and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok());
        match (kb("MemTotal"), kb("MemAvailable")) {
            (Some(t), Some(a)) => format!("{} ({} available)", gib(t * 1024), gib(a * 1024)),
            (Some(t), None) => gib(t * 1024),
            _ => "unknown".into(),
        }
    }

    /// Wayland or X11, and the desktop: much of Linux's video and window
    /// behaviour depends on them.
    #[cfg(all(unix, not(target_os = "macos")))]
    pub fn session() -> Option<String> {
        let kind = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown session".into());
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_else(|_| "unknown desktop".into());
        Some(format!("{kind}, {desktop}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    pub fn locale() -> String {
        std::env::var("LC_ALL").or_else(|_| std::env::var("LANG")).unwrap_or_else(|_| "unknown".into())
    }

    /// The graphics adapters wgpu sees: name, kind, driver and API.
    pub fn gpus() -> Vec<String> {
        use iced::wgpu;
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends: wgpu::Backends::PRIMARY, ..Default::default() });
        let mut seen = Vec::new();
        for adapter in instance.enumerate_adapters(wgpu::Backends::PRIMARY) {
            let i = adapter.get_info();
            let driver = [i.driver.as_str(), i.driver_info.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
            let line = format!(
                "{} ({:?}, {:?}{})",
                i.name,
                i.device_type,
                i.backend,
                if driver.is_empty() { String::new() } else { format!(", driver {driver}") }
            );
            if !seen.contains(&line) {
                seen.push(line);
            }
        }
        if seen.is_empty() {
            seen.push("no adapter found".into());
        }
        seen
    }

    /// What kind of drive a path is on: local, external or network (and
    /// its file system), which explains most slow or stalling playback.
    pub fn volume(path: &Path) -> String {
        imp_volume(path)
    }

    #[cfg(windows)]
    fn imp_volume(path: &Path) -> String {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;
        let s = path.to_string_lossy();
        if s.starts_with("\\\\") {
            return "a network share".into();
        }
        let root: Vec<u16> = std::ffi::OsStr::new(&s.chars().take(3).collect::<String>()).encode_wide().chain([0]).collect();
        let kind = unsafe { GetDriveTypeW(windows::core::PCWSTR(root.as_ptr())) };
        match kind {
            2 => "a removable drive",
            3 => "a local disk",
            4 => "a network drive",
            5 => "an optical disc",
            6 => "a RAM disk",
            _ => "an unknown kind of drive",
        }
        .into()
    }

    /// The mount (from mount / /proc/mounts) that holds the path: the
    /// longest mount point it's under.
    #[cfg(unix)]
    fn imp_volume(path: &Path) -> String {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let mounts: Vec<(String, String)> = if cfg!(target_os = "macos") {
            // "//user@server/share on /Volumes/x (smbfs, nodev, …)"
            run("/sbin/mount", &[])
                .unwrap_or_default()
                .lines()
                .filter_map(|l| {
                    let (_, rest) = l.split_once(" on ")?;
                    let (point, flags) = rest.rsplit_once(" (")?;
                    Some((point.to_string(), flags.split(',').next()?.trim().to_string()))
                })
                .collect()
        } else {
            std::fs::read_to_string("/proc/mounts")
                .unwrap_or_default()
                .lines()
                .filter_map(|l| {
                    let mut f = l.split_whitespace();
                    let (_, point, fs) = (f.next()?, f.next()?, f.next()?);
                    Some((point.replace("\\040", " "), fs.to_string()))
                })
                .collect()
        };
        let Some((point, fs)) = mounts.iter().filter(|(p, _)| path.starts_with(p)).max_by_key(|(p, _)| p.len()) else {
            return "an unknown kind of drive".into();
        };
        let network = ["smbfs", "cifs", "smb3", "nfs", "nfs4", "afpfs", "webdav", "fuse.sshfs", "9p"];
        let removable = ["exfat", "msdos", "vfat", "fat32", "ntfs", "fuseblk", "ntfs3"];
        let kind = if network.contains(&fs.as_str()) {
            "a network share"
        } else if removable.contains(&fs.as_str()) {
            "an external or removable drive"
        } else if point.starts_with("/Volumes") || point.starts_with("/media") || point.starts_with("/run/media") {
            "an external drive"
        } else {
            "a local disk"
        };
        format!("{kind} ({fs})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_parts_of_paths_are_removed() {
        assert_eq!(redact("/Users/alice/Movies/TeslaCam"), "/Users/[user]/Movies/TeslaCam");
        assert_eq!(redact(r"C:\Users\Alice Example\Videos"), r"C:\Users\[user]\Videos");
        assert_eq!(redact(r"C:\\Users\\alice\\x"), r"C:\\Users\\[user]\\x");
        assert_eq!(redact("/Volumes/Alice's NAS/TeslaCam"), "/Volumes/[volume]/TeslaCam");
        assert_eq!(redact("/run/media/alice/USB/TeslaCam"), "/run/media/[user]/[volume]/TeslaCam");
        assert_eq!(redact(r"\\nas-home\teslacam\RecentClips"), r"\\[server]\teslacam\RecentClips");
        assert_eq!(redact("smb://nas.local/share"), "smb://[server]/share");
        assert_eq!(redact("near 40.1234, -100.4321 at 10:00"), "near [coordinates] at 10:00");
        // Times, versions and sizes stay.
        assert_eq!(redact("2026-11-07_10-12-00-front.mp4 2896x1876 v2026.45.40 12.5 ms"), "2026-11-07_10-12-00-front.mp4 2896x1876 v2026.45.40 12.5 ms");
    }

    #[test]
    fn the_report_fits_and_starts_with_the_summary() {
        crate::applog::start_in_memory();
        for i in 0..20_000 {
            log::info!("line {i} with some words to fill the log up");
        }
        let r = report(&Snapshot::default());
        assert!(r.len() <= MAX_CHARS, "{}", r.len());
        assert!(r.contains("== Summary =="));
        assert!(r.contains("line 19999"));
    }
}
