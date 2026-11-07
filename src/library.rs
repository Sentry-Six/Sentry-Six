//! Finding Tesla footage: a TeslaCam folder (RecentClips, SavedClips,
//! SentryClips), one of those folders, or a single event folder.
//!
//! Listing is two-step so a big share opens fast: `scan` lists only folder
//! names (days and events), and `load_segments` lists one collection's
//! clips when it is opened.

use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Camera {
    Front,
    Back,
    LeftPillar,
    RightPillar,
    LeftRepeater,
    RightRepeater,
}

impl Camera {
    pub fn from_suffix(s: &str) -> Option<Self> {
        Some(match s {
            "front" => Camera::Front,
            "back" => Camera::Back,
            "left_pillar" => Camera::LeftPillar,
            "right_pillar" => Camera::RightPillar,
            "left_repeater" => Camera::LeftRepeater,
            "right_repeater" => Camera::RightRepeater,
            _ => return None,
        })
    }

    /// Mirrored by default, so they read like the car's mirrors.
    pub fn mirrored(self) -> bool {
        matches!(self, Camera::Back | Camera::LeftRepeater | Camera::RightRepeater)
    }

    /// The name in clip files and in the settings ("left_pillar").
    pub fn key(self) -> &'static str {
        match self {
            Camera::Front => "front",
            Camera::Back => "back",
            Camera::LeftPillar => "left_pillar",
            Camera::RightPillar => "right_pillar",
            Camera::LeftRepeater => "left_repeater",
            Camera::RightRepeater => "right_repeater",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Camera::Front => crate::i18n::t("ui.cameras.front"),
            Camera::Back => crate::i18n::t("ui.cameras.back"),
            Camera::LeftPillar => crate::i18n::t("ui.cameras.leftPillar"),
            Camera::RightPillar => crate::i18n::t("ui.cameras.rightPillar"),
            Camera::LeftRepeater => crate::i18n::t("ui.cameras.leftRepeater"),
            Camera::RightRepeater => crate::i18n::t("ui.cameras.rightRepeater"),
        }
    }
}

/// The grid slots, row by row (the keys of `customCameraOrdersByProfile`).
pub const SLOT_KEYS: [&str; 6] = ["tl", "tc", "tr", "bl", "bc", "br"];

/// The default six-camera layout, row by row.
pub const GRID: [Camera; 6] = [
    Camera::LeftPillar,
    Camera::Front,
    Camera::RightPillar,
    Camera::LeftRepeater,
    Camera::Back,
    Camera::RightRepeater,
];

/// Local wall-clock time as seconds since 1970-01-01 (no time zone: Tesla
/// names files in the car's local time).
pub type LocalSecs = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Recent,
    Saved,
    Sentry,
    Folder,
    /// A day of GM Surround Vision recordings (listed as "Continuous").
    Continuous,
}

#[derive(Debug, Clone)]
pub struct Collection {
    pub kind: Kind,
    /// Day (YYYY-MM-DD) for RecentClips, folder name for events.
    pub name: String,
    pub dir: PathBuf,
    /// Only for old firmware, whose RecentClips has no day folders: keep the
    /// files of this day.
    pub date_filter: Option<String>,
}

impl Collection {
    /// Sort key, newest first in the list.
    fn sort_key(&self) -> String {
        self.name.clone()
    }

    /// The day this collection belongs to (YYYY-MM-DD), for the date picker.
    pub fn day(&self) -> String {
        match self.name.get(..10) {
            Some(d) if parse_stamp(&format!("{d}_00-00-00")).is_some() => d.to_string(),
            _ => self.name.clone(),
        }
    }

    /// The title shown in the clip list.
    pub fn list_title(&self) -> String {
        let time = || self.name.get(11..19).map(|t| t.replace('-', ":")).unwrap_or_else(|| self.name.clone());
        match self.kind {
            Kind::Recent => crate::i18n::t("app.recentClips").to_string(),
            Kind::Sentry => format!("{} · {}", crate::i18n::t("ui.clipBrowser.sentry"), time()),
            Kind::Saved => format!("{} · {}", crate::i18n::t("ui.clipBrowser.saved"), time()),
            Kind::Folder => crate::i18n::tf("app.folderClips", &[("name", &self.name)]),
            Kind::Continuous => crate::i18n::t("app.continuous").to_string(),
        }
    }
}

/// One entry in the clip list for a day.
#[derive(Debug, Clone)]
pub struct ClipItem {
    pub collection: Collection,
    pub segments: Vec<Segment>,
    /// Most cameras in any one minute.
    pub cameras: usize,
    /// event.json `reason`, for Saved and Sentry events.
    pub reason: Option<String>,
    pub event_time: Option<LocalSecs>,
    /// event.json `camera`: the camera that triggered the event (for the
    /// Sentry/Saved camera glow).
    pub camera: Option<Camera>,
}

/// The days that have footage, newest first.
pub fn days(collections: &[Collection]) -> Vec<String> {
    let mut d: Vec<String> = collections.iter().map(|c| c.day()).collect();
    d.sort_by(|a, b| b.cmp(a));
    d.dedup();
    d
}

/// Lists one day's clips, a few folders at a time, in this order:
/// Recent Clips first, then Sentry and Saved events, newest first.
pub fn load_day(collections: &[Collection], day: &str) -> Vec<ClipItem> {
    let mut wanted: Vec<&Collection> = collections.iter().filter(|c| c.day() == day).collect();
    let rank = |k: Kind| match k {
        Kind::Recent => 0,
        Kind::Sentry => 1,
        Kind::Saved => 2,
        Kind::Folder => 3,
        Kind::Continuous => 0,
    };
    wanted.sort_by(|a, b| rank(a.kind).cmp(&rank(b.kind)).then(b.name.cmp(&a.name)));
    let mut out: Vec<Option<ClipItem>> = vec![None; wanted.len()];
    for (chunk, slots) in wanted.chunks(4).zip(out.chunks_mut(4)) {
        std::thread::scope(|scope| {
            for (c, slot) in chunk.iter().zip(slots.iter_mut()) {
                scope.spawn(move || *slot = load_item(c));
            }
        });
    }
    out.into_iter().flatten().collect()
}

fn load_item(c: &Collection) -> Option<ClipItem> {
    let segments = load_segments(c).ok()?;
    if segments.is_empty() {
        return None;
    }
    let cameras = segments.iter().map(|s| s.files.len()).max().unwrap_or(0);
    let (reason, event_time, camera) = match c.kind {
        Kind::Saved | Kind::Sentry => {
            let text = std::fs::read_to_string(c.dir.join("event.json")).unwrap_or_default();
            (
                json_str(&text, "reason"),
                json_str(&text, "timestamp").and_then(|t| parse_iso_local(&t)),
                json_value(&text, "camera").and_then(|v| event_camera(&v)),
            )
        }
        _ => (None, None, None),
    };
    Some(ClipItem { collection: c.clone(), segments, cameras, reason, event_time, camera })
}

/// Tesla's camera numbers in event.json: 0-2 are the front cameras.
pub fn event_camera(index: &str) -> Option<Camera> {
    Some(match index.trim() {
        "0" | "1" | "2" => Camera::Front,
        "3" => Camera::LeftPillar,
        "4" => Camera::RightPillar,
        "5" => Camera::LeftRepeater,
        "6" => Camera::RightRepeater,
        "7" => Camera::Back,
        _ => return None,
    })
}

/// A field from event.json as text, whether written as a string or a number.
fn json_value(text: &str, key: &str) -> Option<String> {
    if let Some(s) = json_str(text, key) {
        return Some(s);
    }
    let at = text.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = &text[at..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    (end > 0).then(|| rest[..end].to_string())
}

/// A string field from Tesla's small, flat event.json.
fn json_str(text: &str, key: &str) -> Option<String> {
    let at = text.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = &text[at..];
    let colon = rest.find(':')?;
    let rest = rest[colon + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// The label for an event reason, and whether it is an alert (red)
/// rather than a warning (amber).
pub fn reason_label(reason: &str) -> (String, bool) {
    let label = match reason {
        "sentry_aware_object_detection" => crate::i18n::t("ui.eventTypes.objectDetected").to_string(),
        "vehicle_auto_emergency_braking" => crate::i18n::t("ui.eventTypes.emergencyBraking").to_string(),
        "user_interaction_dashcam_icon_tapped"
        | "user_interaction_dashcam_panel_save"
        | "user_interaction_dashcam_launcher_action_tapped"
        | "user_interaction_dashcam" => crate::i18n::t("ui.eventTypes.manualSave").to_string(),
        "user_interaction_honk" => crate::i18n::t("ui.eventTypes.honk").to_string(),
        "sentry_aware_accel" => crate::i18n::t("ui.eventTypes.accelerationDetected").to_string(),
        "collision" => crate::i18n::t("ui.eventTypes.collisionDetected").to_string(),
        other => other
            .split('_')
            .filter(|w| !w.is_empty())
            .map(|w| {
                let mut c = w.chars();
                c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    };
    (label, reason.contains("emergency") || reason.contains("collision"))
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub start: LocalSecs,
    pub files: BTreeMap<Camera, PathBuf>,
}

/// Parses "YYYY-MM-DD_HH-MM-SS" (the start of a Tesla file name).
pub fn parse_stamp(s: &str) -> Option<LocalSecs> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'_' || b[13] != b'-' || b[16] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se)
}

/// Parses an event.json timestamp, "YYYY-MM-DDTHH:MM:SS".
pub fn parse_iso_local(s: &str) -> Option<LocalSecs> {
    // (get: byte 19 may fall inside a character in a damaged file.)
    let t: String = s.get(..19)?.chars().map(|c| if c == 'T' { '_' } else if c == ':' { '-' } else { c }).collect();
    parse_stamp(&t)
}

// Howard Hinnant's days_from_civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The clip key for a start time: "YYYY-MM-DD_HH-MM-SS".
pub fn stamp_key(t: LocalSecs) -> String {
    let s = format_local(t);
    format!("{}_{}", &s[..10], s[11..].replace(':', "-"))
}

pub fn format_local(t: LocalSecs) -> String {
    let days = t.div_euclid(86400);
    let secs = t.rem_euclid(86400);
    // civil_from_days
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

fn clip_name(name: &str) -> Option<(LocalSecs, Camera)> {
    tesla_clip_name(name).or_else(|| gm_clip_name(name).map(|(start, cam, _)| (start, cam)))
}

fn tesla_clip_name(name: &str) -> Option<(LocalSecs, Camera)> {
    let stem = name.strip_suffix(".mp4")?;
    let start = parse_stamp(stem.get(..19)?)?;
    let cam = Camera::from_suffix(stem.get(20..)?)?;
    Some((start, cam))
}

/// A GM Surround Vision file, "FRONT_2026_01_31_T_14_05_00.mp4": its start,
/// the grid slot its camera takes (the GM layout: Left, Front, Right on
/// top, Interior and Rear below), and its day.
fn gm_clip_name(name: &str) -> Option<(LocalSecs, Camera, String)> {
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".mp4")?;
    let (camera, rest) = stem.split_once('_')?;
    let slot = match camera {
        "left" => Camera::LeftPillar,
        "front" => Camera::Front,
        "right" => Camera::RightPillar,
        "interior" => Camera::LeftRepeater,
        "rear" => Camera::Back,
        _ => return None,
    };
    let p: Vec<&str> = rest.split('_').collect();
    if p.len() != 7 || p[3] != "t" || p.iter().enumerate().any(|(i, f)| i != 3 && (f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()))) {
        return None;
    }
    let day = format!("{}-{}-{}", p[0], p[1], p[2]);
    let start = parse_stamp(&format!("{day}_{}-{}-{}", p[4], p[5], p[6]))?;
    Some((start, slot, day))
}

/// GM's camera names for the grid slots its cameras take.
pub fn gm_label(slot_camera: Camera) -> &'static str {
    match slot_camera {
        Camera::LeftPillar => crate::i18n::t("app.gmLeft"),
        Camera::Front => crate::i18n::t("ui.cameras.front"),
        Camera::RightPillar => crate::i18n::t("app.gmRight"),
        Camera::LeftRepeater => crate::i18n::t("app.gmInterior"),
        Camera::Back => crate::i18n::t("ui.cameras.back"),
        Camera::RightRepeater => "",
    }
}

fn is_date(name: &str) -> bool {
    name.len() == 10 && parse_stamp(&format!("{name}_00-00-00")).is_some()
}

fn has_gm_clips(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.file_name().to_str().and_then(gm_clip_name).is_some()))
        .unwrap_or(false)
}

/// Adds `root`'s GM footage to `out`; true if there was any.
fn found_gm(root: &Path, out: &mut Vec<Collection>) -> bool {
    let before = out.len();
    scan_gm(root, out);
    out.len() > before
}

/// GM footage layouts: a day folder, a
/// Continuous folder of days (also inside Recordings), or the car's flat
/// SurroundVisionRecorder folder.
fn scan_gm(root: &Path, out: &mut Vec<Collection>) {
    let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    if is_date(&name) && has_gm_clips(root) {
        out.push(Collection { kind: Kind::Continuous, name, dir: root.to_path_buf(), date_filter: None });
        return;
    }
    let child = |dir: &Path, wanted: &str| -> Option<PathBuf> {
        subdirs(dir).into_iter().find(|n| n.eq_ignore_ascii_case(wanted)).map(|n| dir.join(n))
    };
    let continuous = if name.eq_ignore_ascii_case("continuous") {
        Some(root.to_path_buf())
    } else {
        child(root, "Continuous").or_else(|| {
            let recordings = if name.eq_ignore_ascii_case("recordings") { Some(root.to_path_buf()) } else { child(root, "Recordings") };
            recordings.and_then(|r| child(&r, "Continuous"))
        })
    };
    if let Some(dir) = continuous {
        let before = out.len();
        for day in subdirs(&dir).into_iter().filter(|d| is_date(d)) {
            if has_gm_clips(&dir.join(&day)) {
                out.push(Collection { kind: Kind::Continuous, dir: dir.join(&day), name: day, date_filter: None });
            }
        }
        if out.len() > before {
            return;
        }
    }
    let recorder = if name.eq_ignore_ascii_case("surroundvisionrecorder") {
        Some(root.to_path_buf())
    } else {
        child(root, "SurroundVisionRecorder").or_else(|| {
            ["Android", "media", "com.gm.ultifi.gmconnectedcameraservice", "Recordings", "SurroundVisionRecorder"]
                .iter()
                .skip(usize::from(name.eq_ignore_ascii_case("android")))
                .try_fold(root.to_path_buf(), |dir, part| child(&dir, part))
        })
    };
    if let Some(dir) = recorder {
        let mut days: Vec<String> = std::fs::read_dir(&dir)
            .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str().and_then(gm_clip_name)).map(|c| c.2).collect())
            .unwrap_or_default();
        days.sort();
        days.dedup();
        for day in days {
            out.push(Collection { kind: Kind::Continuous, name: day.clone(), dir: dir.clone(), date_filter: Some(day) });
        }
    }
}

fn subdirs(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn has_clips(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.file_name().to_str().and_then(clip_name).is_some()))
        .unwrap_or(false)
}

/// Lists the collections under `root`, newest first. Reads folder names
/// only, except for old firmware's flat RecentClips.
pub fn scan(root: &Path) -> Result<Vec<Collection>> {
    let mut out = Vec::new();
    let named = |n: &str| root.join(n);
    let is_teslacam = ["RecentClips", "SavedClips", "SentryClips"].iter().any(|n| named(n).is_dir());
    if is_teslacam {
        scan_recent(&named("RecentClips"), &mut out);
        for (folder, kind) in [("SavedClips", Kind::Saved), ("SentryClips", Kind::Sentry)] {
            for name in subdirs(&named(folder)) {
                out.push(Collection { kind, dir: named(folder).join(&name), name, date_filter: None });
            }
        }
    } else if found_gm(root, &mut out) {
        // GM Surround Vision.
    } else if has_clips(root) {
        let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("Folder").to_string();
        let kind = if root.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("SentryClips") {
            Kind::Sentry
        } else if root.join("event.json").is_file() {
            Kind::Saved
        } else {
            Kind::Folder
        };
        out.push(Collection { kind, name, dir: root.to_path_buf(), date_filter: None });
    } else {
        let parent_name = root.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if parent_name == "RecentClips" {
            scan_recent(root, &mut out);
        } else {
            let kind = match parent_name {
                "SavedClips" => Kind::Saved,
                "SentryClips" => Kind::Sentry,
                _ => Kind::Folder,
            };
            for name in subdirs(root) {
                out.push(Collection { kind, dir: root.join(&name), name, date_filter: None });
            }
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.sort_key()));
    if out.is_empty() {
        anyhow::bail!("no Tesla or GM footage found in {}", root.display());
    }
    Ok(out)
}

fn scan_recent(recent: &Path, out: &mut Vec<Collection>) {
    let days: Vec<String> = subdirs(recent).into_iter().filter(|n| parse_stamp(&format!("{n}_00-00-00")).is_some()).collect();
    if !days.is_empty() {
        for name in days {
            out.push(Collection { kind: Kind::Recent, dir: recent.join(&name), name, date_filter: None });
        }
        return;
    }
    // Old firmware: clips directly in RecentClips; one collection per day.
    let mut dates: Vec<String> = std::fs::read_dir(recent)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| clip_name(n).is_some())
                // Tesla's names start with the date ("2026-01-02_…").
                .filter_map(|n| n.get(..10).filter(|d| is_date(d)).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    dates.sort();
    dates.dedup();
    for d in dates {
        out.push(Collection { kind: Kind::Recent, dir: recent.to_path_buf(), name: d.clone(), date_filter: Some(d) });
    }
}

/// The collection's one-minute segments, oldest first.
pub fn load_segments(c: &Collection) -> Result<Vec<Segment>> {
    let mut by_start: BTreeMap<LocalSecs, BTreeMap<Camera, PathBuf>> = BTreeMap::new();
    for e in std::fs::read_dir(&c.dir).with_context(|| format!("listing {}", c.dir.display()))? {
        let Ok(e) = e else { continue };
        let Ok(name) = e.file_name().into_string() else { continue };
        let day = gm_clip_name(&name).map(|c| c.2).or_else(|| name.get(..10).map(str::to_string));
        if c.date_filter.as_deref().is_some_and(|d| day.as_deref() != Some(d)) {
            continue;
        }
        if let Some((start, cam)) = clip_name(&name) {
            by_start.entry(start).or_default().insert(cam, e.path());
        }
    }
    Ok(by_start.into_iter().map(|(start, files)| Segment { start, files }).collect())
}


#[cfg(test)]
mod tests {
    #[test]
    fn damaged_timestamps_are_refused() {
        assert!(super::parse_iso_local("2026-01-02T03:04:05").is_some());
        // A multi-byte character across byte 19, and a short string.
        assert_eq!(super::parse_iso_local("2026-01-02T03:04:0é"), None);
        assert_eq!(super::parse_iso_local("2026-01-02"), None);
    }

    #[test]
    fn event_camera_from_event_json() {
        let text = r#"{"timestamp":"2026-07-08T10:46:52","reason":"sentry_aware_object_detection","camera":"5"}"#;
        assert_eq!(json_value(text, "camera").and_then(|v| event_camera(&v)), Some(Camera::LeftRepeater));
        let number = r#"{"camera": 0, "reason":"user_interaction_honk"}"#;
        assert_eq!(json_value(number, "camera").and_then(|v| event_camera(&v)), Some(Camera::Front));
        assert_eq!(event_camera("9"), None);
    }

    use super::*;

    #[test]
    fn stamps_round_trip() {
        let t = parse_stamp("2026-10-16_10-02-50").unwrap();
        assert_eq!(format_local(t), "2026-10-16 10:02:50");
        assert_eq!(parse_iso_local("2026-10-16T10:03:34").unwrap() - t, 44);
        assert_eq!(format_local(parse_stamp("2024-02-29_23-59-59").unwrap() + 1), "2024-03-01 00:00:00");
        assert_eq!(stamp_key(t), "2026-10-16_10-02-50");
    }

    #[test]
    fn event_json_fields() {
        let j = r#"{ "camera": "0", "reason": "trick_or_treat", "timestamp": "2026-10-16T10:03:34" }"#;
        assert_eq!(json_str(j, "reason").as_deref(), Some("trick_or_treat"));
        assert_eq!(json_str(j, "timestamp").as_deref(), Some("2026-10-16T10:03:34"));
        assert_eq!(json_str(j, "street"), None);
        assert_eq!(reason_label("trick_or_treat"), ("Trick Or Treat".to_string(), false));
        assert_eq!(reason_label("vehicle_auto_emergency_braking"), ("Emergency Braking".to_string(), true));
    }

    #[test]
    fn days_and_titles() {
        let c = |kind, name: &str| Collection { kind, name: name.into(), dir: PathBuf::new(), date_filter: None };
        let all = vec![c(Kind::Recent, "2026-10-16"), c(Kind::Saved, "2026-10-16_10-02-50"), c(Kind::Recent, "2026-10-17")];
        assert_eq!(days(&all), vec!["2026-10-17", "2026-10-16"]);
        assert_eq!(all[1].list_title(), "Saved · 10:02:50");
        assert_eq!(all[0].list_title(), "Recent Clips");
    }

    #[test]
    fn gm_names_and_folders() {
        let c = gm_clip_name("FRONT_2026_01_31_T_14_05_00.mp4").unwrap();
        assert_eq!((c.1, c.2.as_str()), (Camera::Front, "2026-01-31"));
        assert_eq!(gm_clip_name("interior_2026_01_31_T_14_05_00.MP4").map(|c| c.1), Some(Camera::LeftRepeater));
        assert!(gm_clip_name("FRONT_2026_01_31_14_05_00.mp4").is_none());
        assert!(gm_clip_name("2026-01-31_14-05-00-front.mp4").is_none());
        // A Continuous folder of days, and the flat recorder folder.
        let root = std::env::temp_dir().join(format!("gm-scan-test-{}", std::process::id()));
        let day = root.join("Recordings/Continuous/2026-01-31");
        std::fs::create_dir_all(&day).unwrap();
        for cam in ["FRONT", "LEFT", "REAR"] {
            std::fs::write(day.join(format!("{cam}_2026_01_31_T_14_05_00.mp4")), b"").unwrap();
        }
        let found = scan(&root).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].kind, found[0].name.as_str()), (Kind::Continuous, "2026-01-31"));
        let segs = load_segments(&found[0]).unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].files.len(), 3);
        let flat = root.join("SurroundVisionRecorder");
        std::fs::create_dir_all(&flat).unwrap();
        for stamp in ["2026_02_01_T_08_00_00", "2026_02_02_T_09_00_00"] {
            std::fs::write(flat.join(format!("FRONT_{stamp}.mp4")), b"").unwrap();
        }
        let found = scan(&flat).unwrap();
        assert_eq!(found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["2026-02-02", "2026-02-01"]);
        assert_eq!(load_segments(&found[1]).unwrap().len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn clip_names() {
        assert_eq!(clip_name("2026-10-16_10-02-50-left_pillar.mp4").map(|c| c.1), Some(Camera::LeftPillar));
        assert!(clip_name("2026-10-16_10-02-50-thumb.mp4").is_none());
        assert!(clip_name("event.json").is_none());
    }
}
