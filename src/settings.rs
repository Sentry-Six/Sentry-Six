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
    /// Dialogs on a solid dark surface instead of frosted glass
    /// (`dialogStyle`: "frosted", the default, or "solid"). New in this
    /// version.
    pub solid_dialogs: bool,
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
    /// The AI support conversation to continue (`aiSupportConversation`;
    /// its token opens it, so diagnostics never include it).
    pub support_chat: Option<SavedChat>,
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
    /// Where the last export was saved (`lastExportFolder`), and its
    /// quality (`exportLastQuality`: mobile, medium, high, max).
    pub last_export_folder: Option<PathBuf>,
    pub export_quality: String,
    /// The export's video format (`exportFormat`: h264, hevc, av1). New in
    /// this version; earlier ones always wrote H.264 (HEVC past 4096).
    pub export_format: String,
    /// The export's timestamp (`exportIncludeTimestamp`, on by default) and
    /// time-lapse (`exportEnableTimelapse`, `exportTimelapseSpeed` "8").
    pub export_timestamp: bool,
    pub export_timelapse: bool,
    pub export_speed: f64,
    /// The export's dashboard (`exportIncludeDashboard`, off by default),
    /// its place (`exportDashboardPosition`) and size (`exportDashboardSize`).
    pub export_dashboard: bool,
    pub export_dash_position: String,
    pub export_dash_size: String,
    /// `exportDashboardStyle` ("compact", "tesla-mobile") and Tesla
    /// Mobile's bar (`exportDashboardPositionTeslaMobile`: bottom or top).
    pub export_dash_style: String,
    pub export_dash_tm_top: bool,
    /// The export's GPS minimap (`exportIncludeMinimap`, off by default),
    /// its corner (`exportMinimapPosition`) and size (`exportMinimapSize`).
    pub export_minimap: bool,
    pub export_minimap_position: String,
    pub export_minimap_size: String,
    /// `exportMinimapRenderMode`: "ass" (Static Map) or "leaflet" (Live Map).
    pub export_minimap_live: bool,
    /// The compact dashboard and the map dragged to a place of their own in
    /// the export preview (`exportDashboardFree`, `exportMinimapFree`: the
    /// top-left as shares of the frame, [x, y]; null for the corner). New
    /// in this version.
    pub export_dash_free: Option<(f32, f32)>,
    /// Clips shared from this computer (`sharedClips`, as earlier versions
    /// kept it: code, link, delete token, expiry), newest first.
    pub shared_clips: Vec<crate::share::SharedClip>,
    /// The Sentry Six watermark on exports (`exportWatermark`, on by
    /// default), its corner (`exportWatermarkPosition`) and dragged place
    /// (`exportWatermarkFree`). New in this version.
    pub export_watermark: bool,
    pub export_watermark_position: String,
    pub export_watermark_free: Option<(f32, f32)>,
    pub export_map_free: Option<(f32, f32)>,
    /// Sizes set by resizing in the export preview, as shares
    /// (`exportDashboardScale`, `exportMinimapScale`,
    /// `exportWatermarkScale`); without, the size keys above. New in this
    /// version.
    pub export_dash_scale: Option<f64>,
    pub export_map_scale: Option<f64>,
    pub export_watermark_scale: Option<f64>,
    /// The last export's blur zones (`exportLastBlurZones`: camera and
    /// coordinates, as earlier versions saved them), offered again.
    pub export_blur_zones: Vec<crate::export::blur::BlurZone>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            metric: false,
            time_24h: false,
            date_format: DateFormat::Ymd,
            glass_blur: 13.0,
            solid_dialogs: false,
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
            support_chat: None,
            no_startup_check: false,
            map_enabled: true,
            map_dark: false,
            show_fsd_events: true,
            dashboard_enabled: true,
            dashboard_compact: false,
            compact_fixed: true,
            accel_mode: crate::dashboard::AccelMode::IconBar,
            last_export_folder: None,
            export_quality: "high".into(),
            export_format: "h264".into(),
            export_timestamp: true,
            export_timelapse: false,
            export_speed: 8.0,
            export_dashboard: false,
            export_dash_position: "bottom-center".into(),
            export_dash_size: "medium".into(),
            export_dash_style: "compact".into(),
            export_dash_tm_top: false,
            export_minimap: false,
            export_minimap_position: "top-right".into(),
            export_minimap_size: "small".into(),
            export_minimap_live: false,
            export_dash_free: None,
            shared_clips: Vec::new(),
            export_watermark: true,
            export_watermark_position: "bottom-right".into(),
            export_watermark_free: None,
            export_map_free: None,
            export_dash_scale: None,
            export_map_scale: None,
            export_watermark_scale: None,
            export_blur_zones: Vec::new(),
        }
    }
}

/// The AI support conversation kept between launches (as earlier versions
/// kept it, so theirs continues here).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedChat {
    pub id: String,
    pub auth_token: String,
    /// Milliseconds since 1970 (forgotten after 90 days).
    pub stored_at: i64,
    pub disclosure_version: String,
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
    let v = to_json(s);
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

/// The settings as saved (studio-settings.json's keys).
pub fn to_json(s: &Settings) -> Value {
    let mut v = serde_json::json!({
        "useMetric": s.metric,
        "timeFormat": if s.time_24h { "24h" } else { "12h" },
        "dateFormat": s.date_format.key(),
        "glassBlur": s.glass_blur,
        "dialogStyle": if s.solid_dialogs { "solid" } else { "frosted" },
        "mirrorCameras": s.mirror_cameras,
        "skipDuration": s.skip_seconds,
        "placeNameLookup": s.place_names,
        "customCameraOrdersByProfile": { "tesla": order_json(&s.camera_order) },
        "language": s.language,
        "showDriveStats": s.show_drive_stats,
        "acceptedPrivacyVersion": s.privacy_accepted,
        "updateChannel": if s.prerelease { "prerelease" } else { "stable" },
        "aiSupportConversation": s.support_chat.as_ref().map(|c| serde_json::json!({
            "id": c.id, "authToken": c.auth_token, "storedAt": c.stored_at, "disclosureVersion": c.disclosure_version,
        })),
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
        // Saved as text, as earlier versions did ("8", "0.5").
        // As earlier versions saved it: action -> { display, identifier }.
        "keybinds": s.keybinds.iter().map(|(action, id)| {
            (action.clone(), serde_json::json!({ "display": crate::shortcuts::display(id), "identifier": id }))
        }).collect::<serde_json::Map<_, _>>(),
    });
    // (Outside the json! above, which is at the macro's depth limit.)
    let zones: Vec<Value> = s
        .export_blur_zones
        .iter()
        .map(|z| {
            let points: Vec<Value> = z.points.iter().map(|(x, y)| serde_json::json!({ "x": x, "y": y })).collect();
            serde_json::json!({ "camera": z.camera.key(), "coordinates": points })
        })
        .collect();
    v["exportLastBlurZones"] = Value::Array(zones);
    // The export's choices.
    v["lastExportFolder"] = serde_json::json!(s.last_export_folder.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
    v["exportLastQuality"] = serde_json::json!(s.export_quality);
    v["exportFormat"] = serde_json::json!(s.export_format);
    v["exportIncludeTimestamp"] = serde_json::json!(s.export_timestamp);
    v["exportEnableTimelapse"] = serde_json::json!(s.export_timelapse);
    v["exportTimelapseSpeed"] = serde_json::json!(s.export_speed.to_string());
    v["exportIncludeDashboard"] = serde_json::json!(s.export_dashboard);
    v["exportDashboardPosition"] = serde_json::json!(s.export_dash_position);
    v["exportDashboardSize"] = serde_json::json!(s.export_dash_size);
    v["exportDashboardStyle"] = serde_json::json!(s.export_dash_style);
    v["exportDashboardPositionTeslaMobile"] = serde_json::json!(if s.export_dash_tm_top { "top-center" } else { "bottom-center" });
    v["exportIncludeMinimap"] = serde_json::json!(s.export_minimap);
    v["exportMinimapPosition"] = serde_json::json!(s.export_minimap_position);
    v["exportMinimapSize"] = serde_json::json!(s.export_minimap_size);
    v["exportMinimapRenderMode"] = serde_json::json!(if s.export_minimap_live { "leaflet" } else { "ass" });
    let pair = |p: Option<(f32, f32)>| p.map(|(x, y)| serde_json::json!([x, y])).unwrap_or(Value::Null);
    v["exportDashboardFree"] = pair(s.export_dash_free);
    v["sharedClips"] = serde_json::to_value(&s.shared_clips).unwrap_or(Value::Array(Vec::new()));
    v["exportWatermark"] = serde_json::json!(s.export_watermark);
    v["exportWatermarkPosition"] = serde_json::json!(s.export_watermark_position);
    v["exportWatermarkFree"] = pair(s.export_watermark_free);
    v["exportMinimapFree"] = pair(s.export_map_free);
    let scale = |x: Option<f64>| x.map(|x| serde_json::json!(x)).unwrap_or(Value::Null);
    v["exportDashboardScale"] = scale(s.export_dash_scale);
    v["exportMinimapScale"] = scale(s.export_map_scale);
    v["exportWatermarkScale"] = scale(s.export_watermark_scale);
    v
}

/// A dragged overlay's place: [x, y], each 0-1.
fn free_pair(v: Option<&Value>) -> Option<(f32, f32)> {
    let a = v?.as_array()?;
    let (x, y) = (a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32);
    ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((x, y))
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
    if let Some(style) = v.get("dialogStyle").and_then(Value::as_str) {
        s.solid_dialogs = style == "solid";
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
    if v.get("lastExportFolder").is_some() {
        s.last_export_folder = path("lastExportFolder");
    }
    if let Some(b) = v.get("exportIncludeTimestamp").and_then(Value::as_bool) {
        s.export_timestamp = b;
    }
    if let Some(st) = v.get("exportDashboardStyle").and_then(Value::as_str).filter(|k| crate::export::overlay::DashStyle::from_key(k).is_some()) {
        s.export_dash_style = st.to_string();
    }
    if let Some(p) = v.get("exportDashboardPositionTeslaMobile").and_then(Value::as_str) {
        s.export_dash_tm_top = p.starts_with("top");
    }
    if let Some(b) = v.get("exportIncludeDashboard").and_then(Value::as_bool) {
        s.export_dashboard = b;
    }
    if let Some(p) = v.get("exportDashboardPosition").and_then(Value::as_str).filter(|p| crate::export::overlay::Corner::from_key(p).is_some()) {
        s.export_dash_position = p.to_string();
    }
    if let Some(z) = v.get("exportDashboardSize").and_then(Value::as_str).filter(|z| crate::export::overlay::DashSize::from_key(z).is_some()) {
        s.export_dash_size = z.to_string();
    }
    if let Some(zones) = v.get("exportLastBlurZones").and_then(Value::as_array) {
        s.export_blur_zones = zones
            .iter()
            .filter_map(|z| {
                let camera = Camera::from_suffix(z.get("camera")?.as_str()?)?;
                let points: Vec<(f32, f32)> = z
                    .get("coordinates")?
                    .as_array()?
                    .iter()
                    .filter_map(|p| Some((p.get("x")?.as_f64()? as f32, p.get("y")?.as_f64()? as f32)))
                    .filter(|(x, y)| (0.0..=1.0).contains(x) && (0.0..=1.0).contains(y))
                    .collect();
                (points.len() >= 3).then_some(crate::export::blur::BlurZone { camera, points })
            })
            .collect();
    }
    if let Some(m) = v.get("exportMinimapRenderMode").and_then(Value::as_str) {
        s.export_minimap_live = m == "leaflet";
    }
    if let Some(b) = v.get("exportWatermark").and_then(Value::as_bool) {
        s.export_watermark = b;
    }
    if let Some(p) = v.get("exportWatermarkPosition").and_then(Value::as_str) {
        s.export_watermark_position = p.to_string();
    }
    if v.get("exportWatermarkFree").is_some() {
        s.export_watermark_free = free_pair(v.get("exportWatermarkFree"));
    }
    if let Some(list) = v.get("sharedClips").and_then(Value::as_array) {
        s.shared_clips = list.iter().filter_map(|c| serde_json::from_value(c.clone()).ok()).collect();
    }
    if v.get("exportDashboardFree").is_some() {
        s.export_dash_free = free_pair(v.get("exportDashboardFree"));
    }
    let scale = |k: &str| v.get(k).and_then(Value::as_f64).filter(|x| *x > 0.0 && *x < 1.0);
    s.export_dash_scale = scale("exportDashboardScale");
    s.export_map_scale = scale("exportMinimapScale");
    s.export_watermark_scale = scale("exportWatermarkScale");
    if v.get("exportMinimapFree").is_some() {
        s.export_map_free = free_pair(v.get("exportMinimapFree"));
    }
    if let Some(b) = v.get("exportIncludeMinimap").and_then(Value::as_bool) {
        s.export_minimap = b;
    }
    if let Some(p) = v.get("exportMinimapPosition").and_then(Value::as_str).filter(|p| crate::export::overlay::Corner::from_key(p).is_some()) {
        s.export_minimap_position = p.to_string();
    }
    if let Some(z) = v.get("exportMinimapSize").and_then(Value::as_str).filter(|z| crate::export::overlay::DashSize::from_key(z).is_some()) {
        s.export_minimap_size = z.to_string();
    }
    if let Some(b) = v.get("exportEnableTimelapse").and_then(Value::as_bool) {
        s.export_timelapse = b;
    }
    let speed = v.get("exportTimelapseSpeed").and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|t| t.parse().ok())));
    if let Some(n) = speed.filter(|n| [0.5, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0].contains(n)) {
        s.export_speed = n;
    }
    if let Some(f) = v.get("exportFormat").and_then(Value::as_str).filter(|f| ["h264", "hevc", "av1"].contains(f)) {
        s.export_format = f.to_string();
    }
    if let Some(q) = v.get("exportLastQuality").and_then(Value::as_str).filter(|q| ["mobile", "medium", "high", "max"].contains(q)) {
        s.export_quality = q.to_string();
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
    // A key that is there but null was cleared (a deleted chat).
    if let Some(c) = v.get("aiSupportConversation") {
        let f = |k: &str| c.get(k).and_then(Value::as_str).map(str::to_string);
        s.support_chat = match (f("id"), f("authToken")) {
            (Some(id), Some(auth_token)) => Some(SavedChat {
                id,
                auth_token,
                stored_at: c.get("storedAt").and_then(Value::as_i64).unwrap_or(0),
                disclosure_version: f("disclosureVersion").unwrap_or_default(),
            }),
            _ => None,
        };
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

    #[test]
    fn export_choices_round_trip() {
        let mut s = Settings::default();
        // As earlier versions saved them (with the mask image, ignored here).
        apply(&mut s, &serde_json::json!({
            "exportLastBlurZones": [{ "camera": "back", "coordinates": [{ "x": 0.1, "y": 0.2 }, { "x": 0.5, "y": 0.2 }, { "x": 0.3, "y": 0.6 }], "maskImageBase64": "...", "maskWidth": 640 }],
            "exportTimelapseSpeed": "16",
            "exportDashboardSize": "large",
            "exportMinimapPosition": "bottom-left",
        }));
        assert_eq!(s.export_blur_zones.len(), 1);
        assert_eq!(s.export_blur_zones[0].camera, Camera::Back);
        assert_eq!(s.export_speed, 16.0);
        let mut again = Settings::default();
        apply(&mut again, &to_json(&s));
        assert_eq!(again.export_blur_zones, s.export_blur_zones);
        assert_eq!((again.export_speed, again.export_dash_size.as_str(), again.export_minimap_position.as_str()), (16.0, "large", "bottom-left"));
    }

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
