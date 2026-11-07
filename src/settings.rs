//! Settings. The starting point is the settings.json of earlier versions of
//! Sentry Studio, read (never written) so their choices carry over: units,
//! time format, glass blur, mirroring, shortcuts, skip length, folders.
//! Changes made in Settings are saved in this version's own
//! studio-settings.json (same keys) and win over the earlier file. Missing
//! keys use the earlier defaults, except glass blur (13 px) and place names
//! (on, like Sentry Drive).

use crate::library::{Camera, GRID, SLOT_KEYS};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Settings {
    /// km/h instead of mph (`useMetric`, default off).
    pub metric: bool,
    /// 24-hour recording time (`timeFormat` "24h"; default 12h).
    pub time_24h: bool,
    /// How dates of clips are written (`dateFormat`).
    pub date_format: DateFormat,
    /// Glass blur in px (`glassBlur`).
    pub glass_blur: f32,
    /// Mirror the back and repeater cameras (`mirrorCameras`, default on).
    pub mirror_cameras: bool,
    /// Shortcuts (`keybinds`): action name -> key identifier.
    pub keybinds: std::collections::HashMap<String, String>,
    /// Seconds per skip (`skipDuration`; default 5).
    pub skip_seconds: f64,
    /// The folder opened at startup (`defaultFolder`).
    pub default_folder: Option<PathBuf>,
    /// The drive-data.json to load (`sentryUsbDataPath`).
    pub drive_data: Option<PathBuf>,
    /// Look up drive start/end names (`placeNameLookup`; on by default).
    pub place_names: bool,
    /// The language (`language`: en, es, fr, de, zh, ja, ko, pt, ru, it, nl,
    /// pl, tr).
    pub language: String,
    /// The dashboard: shown at all (`dashboardEnabled`), the compact
    /// strip instead of the full panel (`dashboardLayout` "compact"),
    /// the compact one fixed to the front camera (`compactDashboardFixed`),
    /// and how the accelerator is drawn (`accelPedMode`).
    pub dashboard_enabled: bool,
    pub dashboard_compact: bool,
    pub compact_fixed: bool,
    pub accel_mode: crate::dashboard::AccelMode,
    /// The GPS map: shown (`mapEnabled`, on by default), dark style
    /// (`mapDarkMode`), and FSD event markers on it (`showFsdEvents`).
    pub map_enabled: bool,
    pub map_dark: bool,
    pub show_fsd_events: bool,
    /// The privacy notice version accepted (its own key: what this version
    /// sends differs from earlier versions').
    pub privacy_accepted: u32,
    /// Pre-release updates (`updateChannel`: "prerelease" or "stable").
    pub prerelease: bool,
    /// `devDisableApiRequests`: no update check at startup.
    pub no_startup_check: bool,
    /// Glow on the camera that triggered a Sentry / Saved event
    /// (`sentryCameraHighlight` / `savedCameraHighlight`, on by default).
    pub sentry_glow: bool,
    pub saved_glow: bool,
    /// Show the accelerator-push count on drive cards (`showDriveStats`; on
    /// by default). Earlier versions kept it in browser storage, not in
    /// settings.json, so it does not carry over.
    pub show_drive_stats: bool,
    /// Which camera each grid slot shows, row by row
    /// (`customCameraOrdersByProfile.tesla`, changed by dragging a camera
    /// onto another).
    pub camera_order: [Camera; 6],
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            metric: false,
            time_24h: false,
            date_format: DateFormat::Ymd,
            glass_blur: 13.0,
            mirror_cameras: true,
            keybinds: Default::default(),
            skip_seconds: 5.0,
            default_folder: None,
            drive_data: None,
            place_names: true,
            camera_order: GRID,
            language: "en".into(),
            show_drive_stats: true,
            sentry_glow: true,
            saved_glow: true,
            privacy_accepted: 0,
            prerelease: false,
            no_startup_check: false,
            map_enabled: true,
            map_dark: false,
            show_fsd_events: true,
            dashboard_enabled: true,
            dashboard_compact: false,
            compact_fixed: true,
            accel_mode: crate::dashboard::AccelMode::IconBar,
        }
    }
}

/// Settings › Display › Date Format: 2026-11-07, 11/07/2026 or 07/11/2026.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateFormat {
    Ymd,
    Mdy,
    Dmy,
}

impl DateFormat {
    pub const ALL: [DateFormat; 3] = [DateFormat::Mdy, DateFormat::Dmy, DateFormat::Ymd];

    pub fn key(self) -> &'static str {
        match self {
            DateFormat::Ymd => "ymd",
            DateFormat::Mdy => "mdy",
            DateFormat::Dmy => "dmy",
        }
    }

    pub fn from_key(k: &str) -> Option<Self> {
        DateFormat::ALL.into_iter().find(|f| f.key() == k)
    }

    /// The label key in Settings.
    pub fn label_key(self) -> &'static str {
        match self {
            DateFormat::Ymd => "ui.settings.ymdFormat",
            DateFormat::Mdy => "ui.settings.mdyFormat",
            DateFormat::Dmy => "ui.settings.dmyFormat",
        }
    }

    /// A YYYY-MM-DD date in this format (anything else unchanged).
    pub fn show(self, iso: &str) -> String {
        let parts: Vec<&str> = iso.splitn(3, '-').collect();
        match (self, parts.as_slice()) {
            (DateFormat::Mdy, [y, m, d]) => format!("{m}/{d}/{y}"),
            (DateFormat::Dmy, [y, m, d]) => format!("{d}/{m}/{y}"),
            _ => iso.to_string(),
        }
    }
}

/// The per-user app data folder (Application Support, %APPDATA%, ~/.config).
fn app_data() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"))
    })
}

/// The data folders earlier versions of Sentry Studio used: "Sentry Studio"
/// (installed), "sentry-six-revamped" (run from source) and "Sentry-Studio"
/// (the name before that). Only ever read.
pub fn earlier_dirs() -> Vec<PathBuf> {
    let Some(base) = app_data() else { return Vec::new() };
    ["Sentry Studio", "sentry-six-revamped", "Sentry-Studio"].iter().map(|d| base.join(d)).collect()
}

/// Sentry Drive's place-name caches (its current and older data
/// folders), read to start from.
pub fn sentry_drive_caches() -> Vec<PathBuf> {
    let Some(base) = app_data() else { return Vec::new() };
    ["com.jefffromtheirs.sentry-drive", "sentry-drive"].iter().map(|d| base.join(d).join("geocode-cache.json")).collect()
}

/// This version's data folder: the same "Sentry Studio" folder installed
/// earlier versions use. Its files have names of their own, so the earlier
/// settings.json there is only ever read.
pub fn data_dir() -> Option<PathBuf> {
    app_data().map(|b| b.join("Sentry Studio"))
}

/// Earlier versions' settings.json files, the most recently saved first.
fn earlier_settings_paths() -> Vec<PathBuf> {
    let mut paths: Vec<(std::time::SystemTime, PathBuf)> = earlier_dirs()
        .into_iter()
        .map(|d| d.join("settings.json"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    paths.sort_by_key(|p| std::cmp::Reverse(p.0));
    paths.into_iter().map(|(_, p)| p).collect()
}

fn own_settings_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("studio-settings.json"))
}

fn read_json(p: &std::path::Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

pub fn load() -> Settings {
    let mut s = Settings::default();
    if let Some(v) = earlier_settings_paths().into_iter().find_map(|p| read_json(&p)) {
        apply(&mut s, &v);
        // Earlier versions had place names opt-in; this version has them
        // on by default, so only its own setting turns them off.
        s.place_names = true;
    }
    if let Some(v) = own_settings_path().and_then(|p| read_json(&p)) {
        apply(&mut s, &v);
        if let Some(b) = v.get("placeNameLookup").and_then(Value::as_bool) {
            s.place_names = b;
        }
        // Read from this file only: earlier versions' acceptedPrivacyVersion
        // counts a different notice.
        if let Some(n) = v.get("acceptedPrivacyVersion").and_then(Value::as_u64) {
            s.privacy_accepted = n as u32;
        }
    }
    s
}

/// Saves what the Settings window changes, to this version's own
/// studio-settings.json.
pub fn save(s: &Settings) {
    let Some(path) = own_settings_path() else { return };
    let v = serde_json::json!({
        "useMetric": s.metric,
        "timeFormat": if s.time_24h { "24h" } else { "12h" },
        "dateFormat": s.date_format.key(),
        "glassBlur": s.glass_blur,
        "mirrorCameras": s.mirror_cameras,
        "skipDuration": s.skip_seconds,
        "placeNameLookup": s.place_names,
        "customCameraOrdersByProfile": { "tesla": order_json(&s.camera_order) },
        "language": s.language,
        "showDriveStats": s.show_drive_stats,
        "acceptedPrivacyVersion": s.privacy_accepted,
        "updateChannel": if s.prerelease { "prerelease" } else { "stable" },
        "mapEnabled": s.map_enabled,
        "mapDarkMode": s.map_dark,
        "showFsdEvents": s.show_fsd_events,
        "dashboardEnabled": s.dashboard_enabled,
        "dashboardLayout": if s.dashboard_compact { "compact" } else { "default" },
        "compactDashboardFixed": s.compact_fixed,
        "accelPedMode": s.accel_mode.key(),
        "sentryCameraHighlight": s.sentry_glow,
        "savedCameraHighlight": s.saved_glow,
        "defaultFolder": s.default_folder.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "sentryUsbDataPath": s.drive_data.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        // As earlier versions saved it: action -> { display, identifier }.
        "keybinds": s.keybinds.iter().map(|(action, id)| {
            (action.clone(), serde_json::json!({ "display": crate::shortcuts::display(id), "identifier": id }))
        }).collect::<serde_json::Map<_, _>>(),
    });
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Written aside and renamed over, so a crash mid-write can't leave a
    // broken file (which would reset every setting).
    if let Ok(text) = serde_json::to_string_pretty(&v) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn apply(s: &mut Settings, v: &Value) {
    if let Some(b) = v.get("useMetric").and_then(Value::as_bool) {
        s.metric = b;
    }
    if let Some(f) = v.get("dateFormat").and_then(Value::as_str).and_then(DateFormat::from_key) {
        s.date_format = f;
    }
    if let Some(f) = v.get("timeFormat").and_then(Value::as_str) {
        s.time_24h = f == "24h";
    }
    if let Some(px) = v.get("glassBlur").and_then(Value::as_f64) {
        // The Settings slider's range.
        s.glass_blur = px.clamp(0.0, 30.0) as f32;
    }
    if let Some(b) = v.get("mirrorCameras").and_then(Value::as_bool) {
        s.mirror_cameras = b;
    }
    if let Some(n) = v.get("skipDuration").and_then(Value::as_f64).filter(|n| *n > 0.0 && *n <= 600.0) {
        s.skip_seconds = n;
    }
    // Only keys that are there: a settings file without the folders must
    // not clear the ones from earlier versions' settings.
    let path = |k: &str| v.get(k).and_then(Value::as_str).filter(|p| !p.is_empty()).map(PathBuf::from);
    // A key that is there but empty was cleared in Settings.
    if v.get("defaultFolder").is_some() {
        s.default_folder = path("defaultFolder");
    }
    if v.get("sentryUsbDataPath").is_some() {
        s.drive_data = path("sentryUsbDataPath");
    }
    if let Some(order) = v.pointer("/customCameraOrdersByProfile/tesla").and_then(parse_order) {
        s.camera_order = order;
    }
    if let Some(lang) = v.get("language").and_then(Value::as_str).filter(|l| !l.is_empty()) {
        s.language = lang.to_string();
    }
    if let Some(b) = v.get("showDriveStats").and_then(Value::as_bool) {
        s.show_drive_stats = b;
    }
    // The channel, or (before there was one) a branch other than main.
    match v.get("updateChannel").and_then(Value::as_str) {
        Some(c @ ("prerelease" | "stable")) => s.prerelease = c == "prerelease",
        _ => {
            if let Some(b) = v.get("updateBranch").and_then(Value::as_str).filter(|b| !b.is_empty()) {
                s.prerelease = b != "main";
            }
        }
    }
    if let Some(b) = v.get("devDisableApiRequests").and_then(Value::as_bool) {
        s.no_startup_check = b;
    }
    if let Some(b) = v.get("mapEnabled").and_then(Value::as_bool) {
        s.map_enabled = b;
    }
    if let Some(b) = v.get("mapDarkMode").and_then(Value::as_bool) {
        s.map_dark = b;
    }
    if let Some(b) = v.get("showFsdEvents").and_then(Value::as_bool) {
        s.show_fsd_events = b;
    }
    if let Some(b) = v.get("dashboardEnabled").and_then(Value::as_bool) {
        s.dashboard_enabled = b;
    }
    if let Some(l) = v.get("dashboardLayout").and_then(Value::as_str) {
        s.dashboard_compact = l == "compact";
    }
    if let Some(b) = v.get("compactDashboardFixed").and_then(Value::as_bool) {
        s.compact_fixed = b;
    }
    if let Some(m) = v.get("accelPedMode").and_then(Value::as_str).and_then(crate::dashboard::AccelMode::from_key) {
        s.accel_mode = m;
    }
    if let Some(b) = v.get("sentryCameraHighlight").and_then(Value::as_bool) {
        s.sentry_glow = b;
    }
    if let Some(b) = v.get("savedCameraHighlight").and_then(Value::as_bool) {
        s.saved_glow = b;
    }
    if let Some(map) = v.get("keybinds").and_then(Value::as_object) {
        // A later file's shortcuts replace an earlier one's (cleared ones too).
        s.keybinds.clear();
        for (action, binding) in map {
            if let Some(id) = binding.get("identifier").and_then(Value::as_str) {
                s.keybinds.insert(action.clone(), id.to_string());
            }
        }
    }
}

/// A slot -> camera map, used only if it shows each camera once.
fn parse_order(v: &Value) -> Option<[Camera; 6]> {
    let mut order = GRID;
    for (slot, key) in SLOT_KEYS.iter().enumerate() {
        order[slot] = Camera::from_suffix(v.get(*key)?.as_str()?)?;
    }
    GRID.iter().all(|c| order.contains(c)).then_some(order)
}

fn order_json(order: &[Camera; 6]) -> Value {
    let mut m = serde_json::Map::new();
    for (key, camera) in SLOT_KEYS.iter().zip(order) {
        m.insert(key.to_string(), Value::String(camera.key().to_string()));
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_earlier_keys_and_keeps_defaults() {
        let mut s = Settings::default();
        apply(&mut s, &serde_json::json!({ "glassBlur": 13, "useMetric": true, "language": "en", "mirrorCameras": true }));
        assert!(s.metric && s.mirror_cameras && !s.time_24h);
        assert_eq!(s.glass_blur, 13.0);
        let mut d = Settings::default();
        apply(&mut d, &serde_json::json!({ "timeFormat": "24h", "glassBlur": 0 }));
        assert!(d.time_24h && !d.metric);
        assert_eq!(d.glass_blur, 0.0);
    }

    #[test]
    fn dates_follow_the_format() {
        assert_eq!(DateFormat::Ymd.show("2026-11-07"), "2026-11-07");
        assert_eq!(DateFormat::Mdy.show("2026-11-07"), "11/07/2026");
        assert_eq!(DateFormat::Dmy.show("2026-11-07"), "07/11/2026");
        assert_eq!(DateFormat::Dmy.show("Continuous"), "Continuous");
        let mut s = Settings::default();
        apply(&mut s, &serde_json::json!({ "dateFormat": "dmy" }));
        assert_eq!(s.date_format, DateFormat::Dmy);
    }

    #[test]
    fn camera_order_round_trips_and_rejects_duplicates() {
        let mut s = Settings::default();
        let mut order = GRID;
        order.swap(1, 4);
        apply(&mut s, &serde_json::json!({ "customCameraOrdersByProfile": { "tesla": order_json(&order) } }));
        assert_eq!(s.camera_order, order);
        let dup = serde_json::json!({ "tl": "front", "tc": "front", "tr": "right_pillar", "bl": "left_repeater", "bc": "back", "br": "right_repeater" });
        assert!(parse_order(&dup).is_none());
    }

    #[test]
    fn own_settings_keep_earlier_folders() {
        let mut s = Settings::default();
        apply(&mut s, &serde_json::json!({ "defaultFolder": "/footage" }));
        apply(&mut s, &serde_json::json!({ "useMetric": true }));
        assert_eq!(s.default_folder, Some(PathBuf::from("/footage")));
        apply(&mut s, &serde_json::json!({ "defaultFolder": "" }));
        assert_eq!(s.default_folder, None);
    }
}
