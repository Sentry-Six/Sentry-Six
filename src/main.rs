// Windows release builds open no console window (see win_console).
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
//! Sentry Studio: synced six-camera Tesla dashcam playback.
//!
//! The layout: the clip browser on the left (date
//! picker, then that day's Recent Clips and events), the six cameras in a
//! 3×2 grid, and the control bar along the bottom.

mod applog;
mod blur_editor;
mod checks;
mod dashboard;
mod diagnostics;
mod decode;
mod drive_list;
mod drives;
mod export;
mod export_view;
mod geocode;
mod i18n;
mod library;
mod map;
mod mp4;
mod native_menu;
mod player;
mod reader;
// The telemetry protobuf decoder, and the drive-data.json loader with its
// correctly rounded trig.
mod sei;
mod drive_data;
mod crmath;
mod crmath_tables;
mod settings;
mod settings_view;
mod share;
mod shortcuts;
mod spinner;
mod support;
mod sync;
mod support_view;
mod specular;
mod telemetry;
mod theme;
mod tile_input;
mod update;
mod update_view;
mod welcome;

/// The User-Agent for the map tile server and OpenStreetMap Nominatim,
/// which asks every app to identify itself.
pub const USER_AGENT: &str =
    concat!("Sentry-Studio/", env!("CARGO_PKG_VERSION"), " (Tesla Dashcam Viewer; https://sentry-six.com/sentry-studio)");
#[cfg(all(windows, not(debug_assertions)))]
mod win_console;
#[cfg(windows)]
mod win_icon;
mod timeline;
mod trace;
mod video;

use iced::widget::{button, column, container, mouse_area, pick_list, row, scrollable, sensor, shader, space, stack, text, text_input, Column};
use iced::alignment::{Horizontal, Vertical};
use iced::{Alignment, Element, Length, Padding, Rectangle, Size, Subscription, Task};
use library::{Camera, ClipItem, Collection, Kind, GRID};
use player::Player;
use std::path::PathBuf;
use theme::{bold, icon, semibold, INTER, MONO};

/// The map's re-centre icon (a crosshair) and its north-up compass.
const RECENTER_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>"#;
const COMPASS_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,2 16,10 12,8 8,10" fill="#5ce483"/><polygon points="12,22 8,14 12,16 16,14" fill="#b8bfcf"/></svg>"##;

/// The OS folder picker; `then` receives the folder (or None).
fn pick_folder(then: fn(Option<PathBuf>) -> Message) -> Task<Message> {
    Task::perform(
        async {
            rfd::AsyncFileDialog::new()
                .set_title(i18n::t("app.chooseFolderTitle"))
                .pick_folder()
                .await
                .map(|h| h.path().to_path_buf())
        },
        then,
    )
}

pub(crate) fn svg_icon<'a>(source: &'static str, size: f32, color: iced::Color) -> Element<'a, Message> {
    iced::widget::svg(iced::widget::svg::Handle::from_memory(source.as_bytes()))
        .width(size)
        .height(size)
        .style(move |_, _| iced::widget::svg::Style { color: Some(color) })
        .into()
}

/// Opens a web page in the default browser.
fn open_url(url: &str) {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(url).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if let Err(e) = result {
        log::warn!("could not open a link or file: {e}");
    }
}

/// A folder's layout for the log: what kinds of clips, how many days.
fn folder_summary(collections: &[Collection], days: usize) -> String {
    let count = |k: Kind| collections.iter().filter(|c| c.kind == k).count();
    format!(
        "{days} days; {} RecentClips days, {} SavedClips and {} SentryClips events, {} GM days, {} other folders",
        count(Kind::Recent),
        count(Kind::Saved),
        count(Kind::Sentry),
        count(Kind::Continuous),
        count(Kind::Folder)
    )
}

/// The support chat panel's distance from the window's top and right.
const CHAT_TOP: f32 = 80.0;
const CHAT_RIGHT: f32 = 20.0;

/// The support chat button's speech bubble.
const CHAT_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>"#;

/// A day in the day picker: its folder's date, shown in the date format.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DayOption {
    iso: String,
    label: String,
}

impl std::fmt::Display for DayOption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

/// Opens THIRD-PARTY-NOTICES.txt (the app's licence, then the fonts' and
/// crates'): the installed copy (next to the app; Resources in the macOS
/// bundle), or this version's on GitHub without one (a development build).
fn open_licences() {
    let dir = std::env::current_exe().ok().and_then(|e| e.canonicalize().ok()).and_then(|e| e.parent().map(PathBuf::from));
    let local = dir.and_then(|d| [d.join("THIRD-PARTY-NOTICES.txt"), d.join("../Resources/THIRD-PARTY-NOTICES.txt")].into_iter().find(|p| p.is_file()));
    match local {
        Some(notices) => open_url(&notices.to_string_lossy()),
        None => open_url(&format!("https://github.com/Sentry-Six/Sentry-Six/blob/v{}/THIRD-PARTY-NOTICES.txt", env!("CARGO_PKG_VERSION"))),
    }
}

/// Runs blocking work (file reads, sleeps, waits) on a thread of its own.
/// iced's executor threads also drive the frame clock and event streams,
/// so blocking them (a zoom badge timer per wheel step was enough) froze
/// playback.
fn off_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = T> {
    let (tx, rx) = iced::futures::channel::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    async move { rx.await.expect("background work stopped") }
}

/// Like `off_thread`, for work that reads the user's files: if it panics
/// (a file the parsers didn't expect), the answer is `fallback` instead of
/// a crash.
fn off_thread_or<T: Send + 'static>(fallback: T, f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = T> {
    off_thread(move || std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or(fallback))
}

fn main() -> iced::Result {
    // Starts the trace's clock (when SENTRY_STUDIO_TRACE is set).
    trace::on();
    #[cfg(all(windows, not(debug_assertions)))]
    win_console::attach_parent();
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let arg = |i: usize| args.get(i).and_then(|a| a.to_str());
    match arg(1) {
        // Decode every frame of one clip without a window.
        Some("--route-check") => {
            if let Some(p) = arg(2) {
                checks::route_check(std::path::Path::new(p));
            }
            return Ok(());
        }
        // An update check without the server ping, optionally as another
        // version and with the download.
        Some("--update-check") => {
            checks::update_check(arg(2) == Some("prerelease"), arg(3), arg(4) == Some("download"));
            return Ok(());
        }
        // The diagnostics report as this computer would send it (without a
        // running window's state: the earlier sessions' logs).
        Some("--diagnostics") => {
            applog::start_in_memory();
            let snap = diagnostics::Snapshot { settings: Some(settings::load()), ..Default::default() };
            print!("{}", diagnostics::report(&snap));
            return Ok(());
        }
        Some("--tiles-check") => {
            if let (Some(lat), Some(lon), Some(z)) = (arg(2), arg(3), arg(4)) {
                checks::tiles_check(lat.parse().unwrap_or(0.0), lon.parse().unwrap_or(0.0), z.parse().unwrap_or(14));
            }
            return Ok(());
        }
        Some("--order-check") => {
            if let Some(p) = arg(2) {
                checks::order_check(std::path::Path::new(p));
            }
            return Ok(());
        }
        Some("--keyframe-check") => {
            if let Some(p) = arg(2) {
                checks::keyframe_check(std::path::Path::new(p));
            }
            return Ok(());
        }
        #[cfg(unix)]
        Some("--gst-check") => {
            if let Some(p) = arg(2) {
                checks::gst_check(std::path::Path::new(p));
            }
            return Ok(());
        }
        Some("--decode-check") => {
            if let Some(p) = arg(2) {
                checks::decode_check(std::path::Path::new(p));
            }
            return Ok(());
        }
        // One place-name lookup.
        Some("--place-check") => {
            if let (Some(lat), Some(lon)) = (arg(2).and_then(|s| s.parse().ok()), arg(3).and_then(|s| s.parse().ok())) {
                checks::place_check(lat, lon);
            }
            return Ok(());
        }
        // Export a clip folder with every camera and time it.
        Some("--export-check") => {
            if let Some(d) = arg(2) {
                checks::export_check(std::path::Path::new(d), arg(3), arg(4).and_then(|s| s.parse().ok()), arg(5).map(std::path::Path::new));
            }
            return Ok(());
        }
        // Hold the skip key while playing and measure camera spread.
        Some("--hold-check") => {
            if let Some(d) = arg(2) {
                checks::hold_check(std::path::Path::new(d));
            }
            return Ok(());
        }
        // Load drive-data.json and match the newest drive to its clips.
        Some("--drives-compare") => {
            if let Some(f) = arg(2) {
                checks::drives_compare(std::path::Path::new(f));
            }
            return Ok(());
        }
        Some("--drives-check") => {
            if let (Some(f), Some(r)) = (arg(2), arg(3)) {
                checks::drives_check(std::path::Path::new(f), std::path::Path::new(r));
            }
            return Ok(());
        }
        // Time a jump to <seconds> in one clip.
        Some("--seek-check") => {
            if let (Some(p), Some(at)) = (arg(2), arg(3).and_then(|s| s.parse().ok())) {
                checks::seek_check(std::path::Path::new(p), at);
            }
            return Ok(());
        }
        // Play a day or event and press +10 s quickly, without a window.
        Some("--skip-check") => {
            if let Some(dir) = arg(2) {
                let start = arg(3).and_then(|s| s.parse().ok()).unwrap_or(2.0);
                let presses = arg(4).and_then(|s| s.parse().ok()).unwrap_or(4);
                checks::skip_check(std::path::Path::new(dir), start, presses);
            }
            return Ok(());
        }
        _ => {}
    }

    applog::start();
    log::info!(target: "app", "Sentry Studio {} started ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    let mut app = iced::application(App::boot, App::update, App::view)
        .title("Sentry Studio")
        .subscription(App::subscription)
        .theme(|_: &App| theme::theme())
        .default_font(INTER)
        .window(iced::window::Settings {
            size: Size::new(1440.0, 900.0),
            // The app's icon on the window (Linux). macOS takes the app
            // bundle's icon, Windows the .exe's (see win_icon).
            icon: if cfg!(any(target_os = "macos", windows)) {
                None
            } else {
                iced::window::icon::from_file_data(include_bytes!("../assets/icons/256x256.png"), None).ok()
            },
            // Linux: matches the .desktop file (tools/package-linux.sh), so
            // the desktop shows the launcher's name and icon for the window.
            #[cfg(target_os = "linux")]
            platform_specific: iced::window::settings::PlatformSpecific {
                application_id: "sentry-studio".into(),
                ..Default::default()
            },
            ..Default::default()
        });
    for font in theme::FONT_FILES {
        app = app.font(font);
    }
    let result = app.run();
    applog::end();
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Clips,
    Drives,
}

#[derive(Debug, Clone)]
pub(crate) enum Message {
    OpenFolder,
    FolderPicked(Option<PathBuf>),
    Scanned(PathBuf, Result<Vec<Collection>, String>),
    PickDay(String),
    DayLoaded(String, Vec<ClipItem>),
    SelectItem(usize),
    TogglePlay,
    Seek(f64),
    SeekDone,
    Skip(f64),
    Rate(Speed),
    Tick,
    ShowTab(Tab),
    TogglePanel,
    PanelSized(Size),
    /// The window (from the Settings overlay) and the Settings dialog.
    OverlaySized(Size),
    DialogSized(Size),
    SettingsSized(Size),
    /// Opens the OS's own popup menu for the speed or the date.
    SpeedMenu,
    DayMenu,
    // Camera tiles: click to focus, wheel to zoom, drag to pan.
    TileClick(usize),
    /// A camera being dragged from a slot: the pointer, then where it
    /// was let go (window coordinates).
    CameraDragTo(usize, iced::Point),
    CameraDrop(usize, iced::Point),
    TileWheel(i32),
    TilePan(f32, f32),
    GridSized(Size),
    ZoomBadgeTimeout,
    /// A key or mouse button, as a shortcut identifier, and whether
    /// it is a key repeat.
    Input(String, bool),
    /// Escape: leave the focused camera.
    Escape,
    // Drives
    DrivesLoaded(PathBuf, Result<std::sync::Arc<Vec<drives::DriveInfo>>, String>),
    PickDriveData,
    /// A toast's time is up.
    ToastExpire(u64),
    /// Accept & Continue on the first-run privacy notice.
    AcceptPrivacy,
    /// Updates: check (true: asked for in Settings), the answer, the
    /// dialog's buttons, the download and the install.
    UpdateCheck(bool),
    UpdateChecked(bool, update::Outcome),
    UpdateLater,
    UpdateNow,
    UpdateOpen(String),
    UpdateDownloaded(Result<PathBuf, String>),
    UpdateInstalled(Result<(), String>),
    /// Settings' Check Now button shows the answer for a while.
    UpdateCheckReset(u64),
    /// The answer to "Switch to pre-release builds?".
    PrereleaseAnswer(bool),
    ChangelogClose,
    /// The AI support chat.
    Chat(support_view::ChatMsg),
    Export(export_view::ExportMsg),
    /// Dragging a floating dashboard.
    DashDrag(f32, f32),
    /// The map: panned, zoomed, re-centred, turned, its panel dragged or
    /// hovered, a clip's route read, tiles arrived.
    MapPan(f32, f32),
    MapZoom(f32),
    MapRecenter,
    MapOrientation,
    MapDrag(f32, f32),
    MapHover(bool),
    ClipRoute(PathBuf, Vec<map::RoutePoint>),
    TilesUpdated(u64),
    /// The full dashboard's details drawer opened or closed.
    DashDetails,
    /// The window's size (also sent when it first shows).
    WindowSized(Size),
    /// A folder (or file) dragged over the window, gone, or dropped.
    FileHovered,
    FileHoverLeft,
    FileDropped(PathBuf),
    /// Redraw for an animation (spinner, camera glow) while paused.
    Animate,
    /// The pointer over a clip card (for its delete button).
    ClipHover(Option<usize>),
    /// Delete an event clip: ask, ask again, then do it.
    DeleteClip(usize),
    DeleteNext,
    DeleteCancel,
    DeleteConfirm,
    Deleted(PathBuf, Result<(), String>),
    DriveDataPicked(Option<PathBuf>),
    DefaultFolderPicked(Option<PathBuf>),
    SelectDrive(usize),
    DriveClips(u64, Result<Vec<library::Segment>, String>),
    DriveScroll(f32, f32),
    DriveFilter(String),
    /// A place name arrived (the count of answers so far).
    PlacesUpdated(u64),
    // Settings window
    OpenSettings,
    CloseSettings,
    SettingsSection(settings_view::Section),
    SettingsSubtab(settings_view::Subtab),
    SettingsSearch(String),
    Setting(settings_view::Change),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Speed(f64);

impl std::fmt::Display for Speed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}x", self.0)
    }
}

/// The playback speeds.
const SPEEDS: [Speed; 5] = [Speed(0.5), Speed(1.0), Speed(2.0), Speed(3.0), Speed(4.0)];
/// Where the floating clip browser sits (logical pixels from the window's
/// top left), and the glass: saturate(185%), 24 px corners. The blur comes
/// from the settings (13 px when none is set; earlier versions of Sentry
/// Studio defaulted to 7 px).
const PANEL_X: f32 = 18.0;
const PANEL_Y: f32 = 44.0;
const GLASS_SATURATE: f32 = 1.85;
const PANEL_RADIUS: f32 = 24.0;
const COLLAPSED_RADIUS: f32 = 12.0;
const DASH_RADIUS: f32 = 24.0;
/// The controls bar height: floating panels stay above it.
const CONTROLS_HEIGHT: f32 = 60.0;
/// Zoom: 1x-4x in 0.25x wheel steps; double-clicking a grid
/// camera opens it at 2x.
const ZOOM_MAX: f32 = 4.0;
const ZOOM_STEP: f32 = 0.25;
/// Two clicks this close are a double-click.
const DOUBLE_CLICK: std::time::Duration = std::time::Duration::from_millis(300);
const ZOOM_BADGE: std::time::Duration = std::time::Duration::from_millis(1500);

struct App {
    player: Player,
    root: Option<PathBuf>,
    collections: Vec<Collection>,
    days: Vec<String>,
    day: Option<String>,
    items: Vec<ClipItem>,
    loading_day: bool,
    selected: Option<usize>,
    /// The event's position on the timeline, for the red marker.
    event_offset: Option<f64>,
    error: Option<String>,
    /// Slider position while the user drags it.
    scrub: Option<f64>,
    tab: Tab,
    panel_open: bool,
    /// The floating panel's size, for the glass blur under it.
    panel_size: Option<Size>,
    /// The camera filling the grid, if one is focused, and its zoom/pan.
    focus: Option<usize>,
    zoom: f32,
    pan: (f32, f32),
    grid_size: Option<Size>,
    /// When the focused camera was focused: a second click soon after is a
    /// double-click (zoom in) instead of going back to the grid.
    focused_at: Option<std::time::Instant>,
    /// The slot a camera is being dragged from, and the pointer.
    camera_drag: Option<(usize, iced::Point)>,
    zoom_badge_until: Option<std::time::Instant>,
    zoom_badge_timer: bool,
    /// Units, time format, blur and mirroring: this version's settings over
    /// earlier versions' (see settings).
    settings: settings::Settings,
    /// Start of the blinker animation.
    epoch: std::time::Instant,
    shortcuts: shortcuts::Shortcuts,
    /// The steering wheel's shown angle, eased towards the telemetry's,
    /// and the G-force meter's last dot positions (newest first).
    steering: f32,
    last_frame: Option<std::time::Instant>,
    gforce_trail: Vec<(f32, f32)>,
    /// A floating dashboard's drag offset, and the full one's details drawer.
    dash_offset: iced::Vector,
    dash_details: bool,
    window_size: Option<Size>,
    /// Windows: the window's icons have been set (see win_icon).
    #[cfg_attr(not(windows), allow(dead_code))]
    window_icon: bool,
    /// The GPS map: tiles, zoom, how far it is panned from the car
    /// (world units), heading-up or north-up and the eased bearing, the
    /// panel's drag offset, whether the pointer is over it, and the playing
    /// clip's route (when no drive is selected).
    tiles: map::tiles::Tiles,
    map_zoom: f32,
    map_pan: (f64, f64),
    map_heading_up: bool,
    map_bearing: f32,
    map_offset: iced::Vector,
    map_hover: bool,
    clip_route: Vec<map::RoutePoint>,
    clip_route_file: Option<PathBuf>,
    arrow: iced::widget::image::Handle,
    // Drives tab
    drives: std::sync::Arc<Vec<drives::DriveInfo>>,
    drive_rows: Vec<drive_list::Row>,
    drive_tops: Vec<f32>,
    drive_total: f32,
    drives_loading: bool,
    drives_error: Option<String>,
    selected_drive: Option<u64>,
    drive_scroll: (f32, f32),
    /// Days with footage in the opened folder (for the Footage chip).
    footage_days: std::collections::HashSet<String>,
    /// The TAG filter, and the drives it lets through.
    drive_filter: String,
    drive_shown: Vec<usize>,
    /// Drive start/end names, on by default like Sentry Drive.
    places: Option<geocode::Geocoder>,
    /// The Settings window, when open, and its section.
    settings_open: bool,
    settings_ui: settings_view::Ui,
    /// Toasts (bottom left), newest last.
    toasts: Vec<(u64, String)>,
    next_toast: u64,
    /// The loading overlay while a folder is scanned.
    scanning: bool,
    /// A folder is being dragged over the window.
    file_hover: bool,
    hovered_clip: Option<usize>,
    /// The two-step delete confirmation: the clip, its folder, and
    /// whether the first question has been answered.
    delete_confirm: Option<(usize, PathBuf, bool)>,
    deleting: bool,
    /// The update dialog, and the bytes downloaded so far.
    update: Option<update_view::Dialog>,
    update_progress: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Back on stable after pre-releases: the stable version is offered
    /// even though it is older.
    update_downgrade: bool,
    /// "Switch to pre-release builds?" is up.
    prerelease_question: bool,
    /// Settings › View Changelog is open.
    changelog: Option<Vec<update::Note>>,
    /// The AI support chat panel.
    chat: support_view::Chat,
    /// Export markers, the Export Video dialog and a running export.
    export: export_view::Export,
    /// Which Check Now answer a reset is for.
    update_check_id: u64,
    /// The folder being scanned (a newer pick replaces it).
    scanning_path: Option<PathBuf>,
    /// The drive-data.json loaded or loading.
    drives_path: Option<PathBuf>,
    /// The units shortcut's choice, for this session only.
    metric_override: Option<bool>,
    overlay_size: Option<Size>,
    dialog_size: Option<Size>,
    /// Settings' size (other dialogs can open over it).
    settings_size: Option<Size>,
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let app = App {
            player: Player::new(),
            root: None,
            collections: Vec::new(),
            days: Vec::new(),
            day: None,
            items: Vec::new(),
            loading_day: false,
            selected: None,
            event_offset: None,
            error: None,
            scrub: None,
            tab: Tab::Clips,
            panel_open: true,
            panel_size: None,
            focus: None,
            zoom: 1.0,
            pan: (0.0, 0.0),
            grid_size: None,
            focused_at: None,
            camera_drag: None,
            zoom_badge_until: None,
            zoom_badge_timer: false,
            settings: settings::load(),
            epoch: std::time::Instant::now(),
            shortcuts: shortcuts::Shortcuts::default(),
            steering: 0.0,
            last_frame: None,
            gforce_trail: Vec::new(),
            dash_offset: iced::Vector::ZERO,
            dash_details: false,
            window_size: None,
            window_icon: false,
            tiles: map::tiles::Tiles::new(settings::data_dir().map(|d| d.join("map"))),
            map_zoom: map::DEFAULT_ZOOM,
            map_pan: (0.0, 0.0),
            map_heading_up: true,
            map_bearing: 0.0,
            map_offset: iced::Vector::ZERO,
            map_hover: false,
            clip_route: Vec::new(),
            clip_route_file: None,
            arrow: iced::widget::image::Handle::from_bytes(include_bytes!("../assets/dashboard/arrow.png").as_slice()),
            drives: Default::default(),
            drive_rows: Vec::new(),
            drive_tops: Vec::new(),
            drive_total: 0.0,
            drives_loading: false,
            drives_error: None,
            selected_drive: None,
            drive_scroll: (0.0, 600.0),
            footage_days: Default::default(),
            drive_filter: String::new(),
            drive_shown: Vec::new(),
            settings_open: false,
            settings_ui: Default::default(),
            toasts: Vec::new(),
            next_toast: 0,
            scanning: false,
            file_hover: false,
            hovered_clip: None,
            delete_confirm: None,
            deleting: false,
            update: None,
            update_progress: Default::default(),
            update_downgrade: false,
            prerelease_question: false,
            changelog: None,
            chat: Default::default(),
            export: Default::default(),
            update_check_id: 0,
            scanning_path: None,
            drives_path: None,
            metric_override: None,
            overlay_size: None,
            dialog_size: None,
            settings_size: None,
            places: settings::data_dir().map(|dir| {
                let seeds: Vec<PathBuf> = settings::sentry_drive_caches();
                geocode::Geocoder::new(dir.join("place-names.json"), &seeds)
            }),
        };
        let mut app = app;
        app.shortcuts = shortcuts::Shortcuts::new(&app.settings.keybinds);
        i18n::set_language(&app.settings.language);
        theme::set_solid_dialogs(app.settings.solid_dialogs);
        // A folder on the command line opens straight away; otherwise
        // the default folder from the settings.
        let folder = std::env::args_os()
            .nth(1)
            .filter(|a| !a.to_string_lossy().starts_with('-'))
            .map(PathBuf::from)
            .or_else(|| app.settings.default_folder.clone().filter(|p| p.is_dir()));
        let task = match folder {
            Some(p) => Task::done(Message::FolderPicked(Some(p))),
            None => Task::none(),
        };
        let watch = app.watch_places(0);
        let tiles = app.watch_tiles(0);
        if let Some(dir) = settings::data_dir() {
            map::tiles::prune_disk_cache(dir.join("map"));
        }
        let updates = app.startup_update_check();
        (app, Task::batch([task, watch, tiles, updates]))
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::OpenFolder => return pick_folder(Message::FolderPicked),
            Message::FolderPicked(Some(path)) => {
                self.error = None;
                self.scanning = true;
                // Only this scan's answer counts if another is still running.
                self.scanning_path = Some(path.clone());
                let p = path.clone();
                let failed = Err(i18n::t("app.unreadable").to_string());
                return Task::perform(off_thread_or(failed, move || library::scan(&p).map_err(|e| format!("{e:#}"))), move |r| {
                    Message::Scanned(path.clone(), r)
                });
            }
            Message::FolderPicked(None) => {}
            Message::Scanned(path, _) if self.scanning_path.as_ref() != Some(&path) => {}
            Message::Scanned(path, Ok(collections)) => {
                self.scanning = false;
                self.scanning_path = None;
                self.root = Some(path);
                self.days = library::days(&collections);
                log::info!("folder opened: {}", folder_summary(&collections, self.days.len()));
                if self.days.is_empty() {
                    // Nothing to show here: the last folder's clips go.
                    self.day = None;
                    self.items.clear();
                    self.selected = None;
                    self.hovered_clip = None;
                    self.player.load(Vec::new(), 0.0);
                    self.export.clear_markers();
                }
                let toast = if self.days.is_empty() {
                    self.notify(i18n::t("ui.notifications.noDashcamClipsFound").to_string(), false)
                } else {
                    self.notify(i18n::tf("ui.notifications.foundDatesWithClips", &[("count", &self.days.len().to_string())]), false)
                };
                self.footage_days = self.days.iter().cloned().collect();
                self.relayout_drives();
                self.collections = collections;
                let mut tasks = vec![toast];
                if let Some(day) = self.days.first().cloned() {
                    tasks.push(Task::done(Message::PickDay(day)));
                }
                // Drive history: the drive-data.json chosen before, or the one
                // SentryUSB keeps at the top of this drive.
                let candidate = self
                    .settings
                    .drive_data
                    .clone()
                    .filter(|p| p.is_file())
                    .or_else(|| self.root.as_ref().map(|r| r.join("drive-data.json")).filter(|p| p.is_file()));
                if candidate != self.drives_path {
                    match candidate {
                        Some(p) => tasks.push(self.load_drives(p)),
                        None => self.clear_drives(),
                    }
                }
                return Task::batch(tasks);
            }
            Message::Scanned(_, Err(e)) => {
                log::warn!("folder could not be opened: {e}");
                self.scanning = false;
                self.scanning_path = None;
                let toast = self.notify(i18n::tf("ui.notifications.failedToOpenFolder", &[("error", &e)]), true);
                self.error = Some(e);
                return toast;
            }
            Message::PickDay(day) => {
                self.day = Some(day.clone());
                self.items.clear();
                self.selected = None;
                self.loading_day = true;
                let collections = self.collections.clone();
                let fallback = (day.clone(), Vec::new());
                return Task::perform(
                    off_thread_or(fallback, move || {
                        let items = library::load_day(&collections, &day);
                        (day, items)
                    }),
                    |(day, items)| Message::DayLoaded(day, items),
                );
            }
            Message::DayLoaded(day, items) => {
                if self.day.as_deref() != Some(day.as_str()) {
                    return Task::none();
                }
                self.loading_day = false;
                self.items = items;
                self.hovered_clip = None;
                log::info!("day loaded: {} clips", self.items.len());
                if self.items.is_empty() {
                    let date = self.settings.date_format.show(&day);
                    return self.notify(i18n::tf("ui.notifications.noClipsFoundForDate", &[("date", &date)]), false);
                }
                let files: usize = self.items.iter().flat_map(|i| &i.segments).map(|s| s.files.len()).sum();
                let toast = self.notify(
                    i18n::tf("ui.notifications.loadedFilesForDate", &[("count", &files.to_string()), ("date", &self.settings.date_format.show(&day))]),
                    false,
                );
                // Open the day's first clip straight away.
                return Task::batch([toast, Task::done(Message::SelectItem(0))]);
            }
            Message::SelectItem(i) => {
                let Some(item) = self.items.get(i) else { return Task::none() };
                let cameras: std::collections::BTreeSet<_> = item.segments.iter().flat_map(|s| s.files.keys()).collect();
                log::info!("playing a {:?} clip: {} minutes, cameras {:?}", item.collection.kind, item.segments.len(), cameras);
                self.selected = Some(i);
                // A clip from the list: the map shows its own route, not a drive's.
                self.selected_drive = None;
                let event = item.event_time.map(|t| Player::offset_of(&item.segments, t));
                self.event_offset = event;
                // Events open 15 s before the event.
                let start = event.map(|e| (e - 15.0).max(0.0)).unwrap_or(0.0);
                self.player.load(item.segments.clone(), start);
                self.export.clear_markers();
                self.player.set_playing(true);
            }
            Message::TogglePlay => {
                let playing = self.player.is_playing();
                self.player.set_playing(!playing);
            }
            Message::Seek(t) => {
                self.scrub = Some(t);
                self.player.seek(t);
            }
            Message::SeekDone => self.scrub = None,
            Message::Skip(d) => {
                let t = (self.player.position() + d).clamp(0.0, self.player.total());
                self.player.seek(t);
            }
            Message::Rate(s) => self.player.set_rate(s.0),
            Message::Tick => {
                self.player.tick();
                self.animate_dashboard();
                let editor = self.export_tick();
                return Task::batch([self.follow_map(), editor]);
            }
            Message::DashDrag(dx, dy) => {
                self.dash_offset += iced::Vector::new(dx, dy);
                // Keep it on screen, above the controls.
                if let (Some(anchor), Some(rect)) = (self.dash_anchor(), self.floating_dash_rect()) {
                    let unclamped = Rectangle { x: anchor.x + self.dash_offset.x, y: anchor.y + self.dash_offset.y, ..rect };
                    self.dash_offset += iced::Vector::new(rect.x - unclamped.x, rect.y - unclamped.y);
                }
            }
            Message::DashDetails => self.dash_details = !self.dash_details,
            Message::MapPan(dx, dy) => {
                let world_px = 256.0 * 2f64.powf(self.map_zoom_effective() as f64);
                self.map_pan.0 -= dx as f64 / world_px;
                self.map_pan.1 -= dy as f64 / world_px;
            }
            Message::MapZoom(steps) => self.map_zoom = (self.map_zoom + steps).clamp(map::MIN_ZOOM, map::MAX_ZOOM),
            Message::MapRecenter => {
                self.map_pan = (0.0, 0.0);
                self.map_zoom = map::DEFAULT_ZOOM;
            }
            Message::MapOrientation => self.map_heading_up = !self.map_heading_up,
            Message::MapDrag(dx, dy) => {
                self.map_offset += iced::Vector::new(dx, dy);
                if let Some(rect) = self.map_rect() {
                    let anchor = self.map_anchor();
                    let unclamped = Rectangle { x: anchor.x + self.map_offset.x, y: anchor.y + self.map_offset.y, ..rect };
                    self.map_offset += iced::Vector::new(rect.x - unclamped.x, rect.y - unclamped.y);
                }
            }
            Message::MapHover(h) => self.map_hover = h,
            Message::ClipRoute(path, route) => {
                if self.clip_route_file.as_ref() == Some(&path) {
                    self.clip_route = route;
                }
            }
            Message::TilesUpdated(n) => return self.watch_tiles(n),
            Message::WindowSized(size) => {
                self.window_size = Some(size);
                #[cfg(windows)]
                if !self.window_icon {
                    self.window_icon = win_icon::apply();
                }
            }
            Message::ShowTab(tab) => self.tab = tab,
            Message::TogglePanel => self.panel_open = !self.panel_open,
            Message::PanelSized(size) => self.panel_size = Some(size),
            Message::OverlaySized(size) => self.overlay_size = Some(size),
            Message::DialogSized(size) => self.dialog_size = Some(size),
            Message::SettingsSized(size) => self.settings_size = Some(size),
            Message::CameraDragTo(slot, at) => {
                if self.focus.is_none() {
                    self.camera_drag = Some((slot, at));
                }
            }
            Message::CameraDrop(slot, at) => {
                self.camera_drag = None;
                // Dropped on another slot: the two slots swap cameras.
                if let Some(target) = self.slot_at(at).filter(|t| *t != slot) {
                    self.settings.camera_order.swap(slot, target);
                    settings::save(&self.settings);
                }
            }
            Message::TileClick(slot) => {
                if self.focus == Some(slot) {
                    let double = self.focused_at.take().is_some_and(|t| t.elapsed() < DOUBLE_CLICK);
                    if double {
                        // Double-click on a grid camera: open it at 2x.
                        self.zoom = 2.0;
                        self.pan = (0.0, 0.0);
                        return self.show_zoom_badge();
                    }
                    // Straight back to all cameras.
                    self.focus = None;
                    self.reset_zoom();
                } else {
                    self.focus = Some(slot);
                    self.focused_at = Some(std::time::Instant::now());
                    self.reset_zoom();
                }
            }
            Message::TileWheel(steps) => {
                if self.focus.is_some() {
                    self.zoom = (self.zoom + ZOOM_STEP * steps as f32).clamp(1.0, ZOOM_MAX);
                    if self.zoom <= 1.0 {
                        self.reset_zoom();
                    } else {
                        self.clamp_pan();
                    }
                    return self.show_zoom_badge();
                }
            }
            Message::TilePan(dx, dy) => {
                if self.focus.is_some() && self.zoom > 1.0 {
                    self.pan.0 += dx / self.zoom;
                    self.pan.1 += dy / self.zoom;
                    self.clamp_pan();
                }
            }
            Message::GridSized(size) => {
                self.grid_size = Some(size);
                self.clamp_pan();
            }
            Message::ZoomBadgeTimeout => {
                if self.zoom_badge_until.is_some_and(|t| std::time::Instant::now() < t) {
                    return self.zoom_badge_wait();
                }
                self.zoom_badge_timer = false;
            }
            Message::Escape => {
                if self.privacy_pending() {
                    // The privacy notice cannot be dismissed, only accepted.
                } else if self.delete_confirm.is_some() {
                    if !self.deleting {
                        self.delete_confirm = None;
                    }
                } else if self.settings_ui.recording.is_some() {
                    self.settings_ui.recording = None;
                } else if self.export.share.list_open {
                    return self.export_update(export_view::ExportMsg::Share(export_view::ShareMsg::ListClose));
                } else if self.export.open {
                    return self.export_update(export_view::ExportMsg::Close);
                } else if self.settings_open {
                    self.settings_open = false;
                } else if self.focus.is_some() {
                    self.focus = None;
                    self.reset_zoom();
                }
            }
            // An earlier load finishing after another one, or after the
            // file was cleared: not what is wanted now.
            Message::DrivesLoaded(path, _) if self.drives_path.as_ref() != Some(&path) => {}
            Message::DrivesLoaded(_path, result) => {
                self.drives_loading = false;
                match result {
                    Ok(list) => {
                        log::info!("drive data loaded: {} drives", list.len());
                        self.drives = list;
                        self.drives_error = None;
                        self.relayout_drives();
                    }
                    Err(e) => {
                        log::warn!("drive data could not be loaded: {e}");
                        self.drives_error = Some(e);
                    }
                }
            }
            Message::PickDriveData => {
                return Task::perform(
                    async {
                        rfd::AsyncFileDialog::new()
                            .set_title(i18n::t("app.selectDriveData"))
                            .add_filter(i18n::t("app.driveDataFilter"), &["json"])
                            .pick_file()
                            .await
                            .map(|h| h.path().to_path_buf())
                    },
                    Message::DriveDataPicked,
                );
            }
            Message::DriveDataPicked(Some(p)) => {
                // Remembered in the settings for next time.
                self.settings.drive_data = Some(p.clone());
                settings::save(&self.settings);
                return self.load_drives(p);
            }
            Message::DefaultFolderPicked(Some(p)) => {
                self.settings.default_folder = Some(p);
                settings::save(&self.settings);
            }
            Message::DefaultFolderPicked(None) => {}
            Message::DriveDataPicked(None) => {}
            Message::DriveScroll(offset, height) => self.drive_scroll = (offset, height),
            Message::PlacesUpdated(n) => return self.watch_places(n),
            Message::OpenSettings => {
                self.settings_open = true;
                self.settings_ui.search.clear();
            }
            Message::CloseSettings => {
                self.settings_open = false;
                self.settings_ui.recording = None;
            }
            Message::SettingsSection(sec) => {
                self.settings_ui.section = sec;
                self.settings_ui.search.clear();
            }
            Message::SettingsSubtab(t) => self.settings_ui.subtab = t,
            Message::SettingsSearch(q) => self.settings_ui.search = q,
            Message::Setting(change) => {
                use settings_view::Change;
                log::info!("settings: {change:?}");
                match change {
                    Change::Metric(b) => {
                        self.settings.metric = b;
                        self.metric_override = None;
                        self.relayout_drives();
                    }
                    Change::Mirror(b) => self.settings.mirror_cameras = b,
                    Change::Blur(px) => self.settings.glass_blur = px.round(),
                    Change::PlaceNames(b) => {
                        self.settings.place_names = b;
                        // Off: nothing more is sent, not even what was queued.
                        if !b {
                            if let Some(places) = &self.places {
                                places.stop();
                            }
                        }
                    }
                    Change::SentryGlow(b) => self.settings.sentry_glow = b,
                    Change::DashboardEnabled(b) => self.settings.dashboard_enabled = b,
                    Change::MapEnabled(b) => self.settings.map_enabled = b,
                    Change::ShowFsdEvents(b) => self.settings.show_fsd_events = b,
                    Change::CompactFixed(b) => {
                        self.settings.compact_fixed = b;
                        self.dash_offset = iced::Vector::ZERO;
                    }
                    Change::SavedGlow(b) => self.settings.saved_glow = b,
                    Change::ShowDriveStats(b) => {
                        self.settings.show_drive_stats = b;
                        self.relayout_drives();
                    }
                    Change::RecordKey(action) => {
                        // A second click on the field stops waiting.
                        self.settings_ui.recording = if self.settings_ui.recording == Some(action) { None } else { Some(action) };
                        return Task::none();
                    }
                    Change::ClearKey(action) => {
                        self.settings_ui.recording = None;
                        self.settings.keybinds.remove(action.setting_name());
                        // Space and the arrows stay on their actions unless
                        // cleared: an empty binding keeps the default off.
                        if action.default_key().is_some() {
                            self.settings.keybinds.insert(action.setting_name().to_string(), String::new());
                        }
                        self.shortcuts = shortcuts::Shortcuts::new(&self.settings.keybinds);
                    }
                    Change::BrowseFolder => return pick_folder(Message::DefaultFolderPicked),
                    Change::ClearFolder => self.settings.default_folder = None,
                    Change::BrowseDriveData => return Task::done(Message::PickDriveData),
                    Change::ClearDriveData => {
                        self.settings.drive_data = None;
                        self.clear_drives();
                    }
                    Change::LearnMore => {
                        self.settings_ui.learn_more = !self.settings_ui.learn_more;
                        return Task::none();
                    }
                    Change::OpenLink(url) => {
                        open_url(url);
                        return Task::none();
                    }
                    // Turning pre-releases on asks first; turning them off
                    // offers the stable version even though it's older.
                    Change::Prerelease(true) => {
                        self.prerelease_question = true;
                        return Task::none();
                    }
                    Change::Prerelease(false) => {
                        self.settings.prerelease = false;
                        self.update_downgrade = true;
                        settings::save(&self.settings);
                        return Task::done(Message::UpdateCheck(true));
                    }
                    Change::CheckUpdates => return Task::done(Message::UpdateCheck(true)),
                    Change::Open(menu) => {
                        let (labels, current) = settings_view::choices(&self.settings, menu);
                        let Some(i) = native_menu::popup(&labels, current) else { return Task::none() };
                        self.choose(menu, i);
                    }
                    Change::Choose(menu, i) => self.choose(menu, i),
                    Change::ResetCameraOrder => self.settings.camera_order = settings::Settings::default().camera_order,
                    Change::OpenSharedClips => {
                        self.settings_open = false;
                        return self.export_update(export_view::ExportMsg::Share(export_view::ShareMsg::ListOpen));
                    }
                    Change::OpenSupportChat => {
                        self.settings_open = false;
                        if self.chat.open {
                            return Task::none();
                        }
                        return self.chat_update(support_view::ChatMsg::Toggle);
                    }
                    Change::ViewChangelog => {
                        self.changelog = Some(update::changelog());
                        return Task::none();
                    }
                    Change::OpenLicences => {
                        open_licences();
                        return Task::none();
                    }
                }
                settings::save(&self.settings);
            }
            Message::DriveFilter(f) => {
                self.drive_filter = f;
                self.relayout_drives();
            }
            Message::SelectDrive(i) => {
                let Some(d) = self.drives.get(i).cloned() else { return Task::none() };
                self.selected_drive = Some(d.id);
                let collections = self.collections.clone();
                let id = d.id;
                return Task::perform(
                    off_thread_or(Err(i18n::t("app.unreadable").to_string()), move || {
                        // The drive's minutes, from RecentClips on the days it
                        // covers (a drive can cross midnight).
                        let keys = drives::key_set(&d);
                        let mut segments = Vec::new();
                        for day in drives::clip_days(&d) {
                            for c in collections.iter().filter(|c| c.kind == Kind::Recent && c.day() == day) {
                                if let Ok(list) = library::load_segments(c) {
                                    segments.extend(list.into_iter().filter(|s| keys.contains(library::stamp_key(s.start).as_str())));
                                }
                            }
                        }
                        segments.sort_by_key(|s| s.start);
                        segments.dedup_by_key(|s| s.start);
                        if segments.is_empty() {
                            Err(i18n::t("app.noMatchingClips").to_string())
                        } else {
                            Ok(segments)
                        }
                    }),
                    move |r| Message::DriveClips(id, r),
                );
            }
            Message::DriveClips(id, result) => {
                if self.selected_drive != Some(id) {
                    return Task::none();
                }
                match result {
                    Ok(segments) => {
                        self.error = None;
                        self.selected = None;
                        self.event_offset = None;
                        self.player.load(segments, 0.0);
                        self.export.clear_markers();
                        self.player.set_playing(true);
                    }
                    Err(e) => self.error = Some(e),
                }
            }
            Message::ToastExpire(id) => self.toasts.retain(|(t, _)| *t != id),
            Message::AcceptPrivacy => {
                if self.epoch.elapsed() >= welcome::ACCEPT_DELAY {
                    self.settings.privacy_accepted = welcome::PRIVACY_VERSION;
                    settings::save(&self.settings);
                    log::info!("privacy notice {} accepted", welcome::PRIVACY_VERSION);
                    return self.startup_update_check();
                }
            }
            Message::UpdateCheck(asked) => {
                if self.update.as_ref().is_some_and(|d| d.busy()) {
                    return Task::none();
                }
                if asked {
                    self.settings_ui.update_check = settings_view::CheckState::Checking;
                }
                let channel = if self.settings.prerelease { update::Channel::Prerelease } else { update::Channel::Stable };
                let downgrade = self.update_downgrade;
                return Task::perform(
                    off_thread_or(update::Outcome::Failed("the check stopped".into()), move || update::check(channel, downgrade)),
                    move |outcome| Message::UpdateChecked(asked, outcome),
                );
            }
            Message::UpdateChecked(asked, outcome) => {
                use settings_view::CheckState;
                let state = match outcome {
                    update::Outcome::UpToDate => {
                        log::info!(target: "update", "up to date ({})", if self.settings.prerelease { "pre-release" } else { "stable" });
                        CheckState::UpToDate
                    }
                    update::Outcome::Failed(e) => {
                        log::warn!(target: "update", "check failed: {e}");
                        CheckState::Failed
                    }
                    update::Outcome::Offer(offer) => {
                        log::info!(target: "update", "{} offered ({:?})", offer.version, offer.how);
                        if !self.update.as_ref().is_some_and(|d| d.busy()) {
                            self.update = Some(update_view::Dialog::Offer(offer));
                        }
                        CheckState::Found
                    }
                    update::Outcome::Critical { version, message, url } => {
                        log::warn!(target: "update", "the server says this version must be replaced by hand ({version})");
                        self.update = Some(update_view::Dialog::Critical { version, message, url });
                        CheckState::Found
                    }
                };
                if asked {
                    self.settings_ui.update_check = state;
                    self.update_check_id += 1;
                    let id = self.update_check_id;
                    return Task::perform(off_thread(|| std::thread::sleep(std::time::Duration::from_secs(3))), move |_| Message::UpdateCheckReset(id));
                }
            }
            Message::UpdateCheckReset(id) => {
                if id == self.update_check_id {
                    self.settings_ui.update_check = settings_view::CheckState::Idle;
                }
            }
            Message::UpdateLater => {
                if matches!(self.update, Some(update_view::Dialog::Offer(_) | update_view::Dialog::Failed(..))) {
                    self.update = None;
                }
            }
            Message::UpdateOpen(url) => open_url(&url),
            Message::UpdateNow => {
                let offer = match self.update.take() {
                    Some(update_view::Dialog::Offer(o) | update_view::Dialog::Failed(o, _)) => o,
                    other => {
                        self.update = other;
                        return Task::none();
                    }
                };
                self.update_progress.store(0, std::sync::atomic::Ordering::Relaxed);
                let progress = self.update_progress.clone();
                let asset = offer.asset.clone();
                self.update = Some(update_view::Dialog::Downloading(offer));
                return Task::perform(
                    off_thread_or(Err("the download stopped".into()), move || update::download(&asset, &progress)),
                    Message::UpdateDownloaded,
                );
            }
            Message::UpdateDownloaded(result) => {
                let Some(update_view::Dialog::Downloading(offer)) = self.update.take() else { return Task::none() };
                match result {
                    Ok(file) => {
                        self.update = Some(update_view::Dialog::Installing(offer));
                        // Settings are saved as they change, so nothing is
                        // lost when the app quits for the install.
                        return Task::perform(off_thread_or(Err("the install stopped".into()), move || update::install(&file)), Message::UpdateInstalled);
                    }
                    Err(e) => {
                        log::warn!(target: "update", "download failed: {e}");
                        self.update = Some(update_view::Dialog::Failed(offer, e));
                    }
                }
            }
            Message::UpdateInstalled(result) => {
                let Some(update_view::Dialog::Installing(offer)) = self.update.take() else { return Task::none() };
                match result {
                    Ok(()) => {
                        log::info!(target: "update", "installing {}: quitting", offer.version);
                        applog::end();
                        return iced::exit();
                    }
                    Err(e) => {
                        log::warn!(target: "update", "install failed: {e}");
                        self.update = Some(update_view::Dialog::Failed(offer, e));
                    }
                }
            }
            Message::ChangelogClose => self.changelog = None,
            Message::Chat(m) => return self.chat_update(m),
            Message::Export(m) => return self.export_update(m),
            Message::PrereleaseAnswer(yes) => {
                self.prerelease_question = false;
                if yes {
                    self.settings.prerelease = true;
                    self.update_downgrade = false;
                    settings::save(&self.settings);
                    return Task::done(Message::UpdateCheck(true));
                }
            }
            Message::Animate => {}
            Message::FileHovered => self.file_hover = true,
            Message::FileHoverLeft => self.file_hover = false,
            Message::FileDropped(path) => {
                self.file_hover = false;
                // A folder opens as is; a dropped file opens its folder.
                let dir = if path.is_dir() { Some(path) } else { path.parent().map(PathBuf::from) };
                if let Some(dir) = dir {
                    return Task::done(Message::FolderPicked(Some(dir)));
                }
            }
            Message::ClipHover(i) => self.hovered_clip = i,
            Message::DeleteClip(i) => {
                if let Some(dir) = self.items.get(i).and_then(deletable_folder) {
                    self.delete_confirm = Some((i, dir, false));
                }
            }
            Message::DeleteNext => {
                if let Some(c) = self.delete_confirm.as_mut() {
                    c.2 = true;
                }
            }
            Message::DeleteCancel => {
                if !self.deleting {
                    self.delete_confirm = None;
                }
            }
            Message::DeleteConfirm => {
                let Some((i, dir, true)) = self.delete_confirm.clone() else { return Task::none() };
                self.deleting = true;
                // Let go of the clip's files first if it is the one playing.
                let playing = self.selected == Some(i);
                if playing {
                    self.player.load(Vec::new(), 0.0);
                    self.export.clear_markers();
                    self.selected = None;
                }
                let failed = Err((dir.clone(), i18n::t("app.unreadable").to_string()));
                return Task::perform(
                    off_thread_or(failed, move || delete_folder(&dir).map(|_| dir)),
                    |r| match r {
                        Ok(dir) => Message::Deleted(dir, Ok(())),
                        Err((dir, e)) => Message::Deleted(dir, Err(e)),
                    },
                );
            }
            Message::Deleted(dir, result) => {
                self.deleting = false;
                self.delete_confirm = None;
                match result {
                    Ok(()) => {
                        if let Some(i) = self.items.iter().position(|it| it.collection.dir == dir) {
                            self.items.remove(i);
                            self.selected = match self.selected {
                                Some(s) if s > i => Some(s - 1),
                                Some(s) if s == i => None,
                                other => other,
                            };
                        }
                        self.collections.retain(|c| c.dir != dir);
                        self.hovered_clip = None;
                        log::info!("an event's folder was deleted");
                        return self.notify(i18n::t("ui.clipBrowser.deleteSuccess").to_string(), false);
                    }
                    Err(e) => return self.notify(format!("{}: {e}", i18n::t("ui.clipBrowser.deleteFailed")), true),
                }
            }
            // Nothing else until the privacy notice is accepted.
            Message::Input(..)
                if self.privacy_pending() || self.delete_confirm.is_some() || self.update.is_some() || self.prerelease_question || self.changelog.is_some() => {}
            Message::Input(id, repeat) => {
                // Settings › Keyboard Shortcuts is waiting for a key: bind it
                // (taking it off any other action).
                if let Some(action) = self.settings_ui.recording {
                    if repeat || shortcuts::is_modifier_only(&id) {
                        return Task::none();
                    }
                    self.settings_ui.recording = None;
                    self.settings.keybinds.retain(|_, bound| *bound != id);
                    self.settings.keybinds.insert(action.setting_name().to_string(), id);
                    self.shortcuts = shortcuts::Shortcuts::new(&self.settings.keybinds);
                    settings::save(&self.settings);
                    return Task::none();
                }
                if let Some(action) = self.shortcuts.action(&id) {
                    if !repeat || action.repeats() {
                        return self.run_shortcut(action);
                    }
                }
            }
            Message::SpeedMenu => {
                let labels: Vec<String> = SPEEDS.iter().map(|s| s.to_string()).collect();
                let current = SPEEDS.iter().position(|s| s.0 == self.player.rate());
                if let Some(i) = native_menu::popup(&labels, current) {
                    self.player.set_rate(SPEEDS[i].0);
                }
            }
            Message::DayMenu => {
                let current = self.day.as_ref().and_then(|d| self.days.iter().position(|x| x == d));
                let labels: Vec<String> = self.days.iter().map(|d| self.settings.date_format.show(d)).collect();
                if let Some(i) = native_menu::popup(&labels, current) {
                    return Task::done(Message::PickDay(self.days[i].clone()));
                }
            }
        }
        Task::none()
    }

    /// Where a tile is in the window (logical px), from the grid's size and
    /// layout: 10 px around the grid, 10 px between tiles, 3x2 or focused.
    fn tile_rect(&self, slot: usize) -> Option<Rectangle> {
        // The grid sits 5 px in from the stage; each cell is a tile with
        // 5 px around it (half the 10 px gap).
        let g = self.grid_size?;
        let m = video::MARGIN;
        let cell = |x: f32, y: f32, w: f32, h: f32| Rectangle { x: m + x + m, y: m + y + m, width: w - 2.0 * m, height: h - 2.0 * m };
        match self.focus {
            Some(f) if f == slot => Some(cell(0.0, 0.0, g.width, g.height)),
            Some(_) => None,
            None => {
                let (w, h) = (g.width / 3.0, g.height / 2.0);
                let (col, row) = ((slot % 3) as f32, (slot / 3) as f32);
                Some(cell(col * w, row * h, w, h))
            }
        }
    }

    /// Where the Settings dialog is (centred in the window), while open.
    /// Where the open support chat panel is (window coordinates): top
    /// right at first, then wherever it was dragged and resized to, always
    /// inside the window and above the controls.
    pub(crate) fn chat_rect(&self) -> Option<Rectangle> {
        if !self.chat.open {
            return None;
        }
        let w = self.window_size?;
        let bottom = w.height - 76.0;
        let (width, height) = match self.chat.size {
            Some(s) => (s.width, s.height),
            None => (support_view::WIDTH, (bottom - CHAT_TOP).min(support_view::MAX_HEIGHT)),
        };
        let width = width.min(w.width - 16.0).max(support_view::MIN_WIDTH.min(w.width));
        let height = height.min(bottom - 8.0).max(support_view::MIN_HEIGHT.min(bottom));
        let pos = self.chat.pos.unwrap_or(iced::Point::new(w.width - CHAT_RIGHT - width, CHAT_TOP));
        Some(Rectangle {
            x: pos.x.clamp(0.0, (w.width - width).max(0.0)),
            y: pos.y.clamp(0.0, (bottom - height).max(0.0)),
            width,
            height,
        })
    }

    /// Whether a dialog is up (they all sit centred over the video).
    fn dialog_open(&self) -> bool {
        self.settings_open || self.export.open || self.export.share.list_open || self.delete_confirm.is_some() || self.privacy_pending() || self.update.is_some() || self.prerelease_question || self.changelog.is_some()
    }

    /// Whether the open dialog covers the clip panel.
    fn panel_under_dialog(&self) -> bool {
        let panel = self.panel_size.map(|s| Rectangle::new(iced::Point::new(PANEL_X, PANEL_Y), s));
        self.dialog_rect().zip(panel).is_some_and(|(d, p)| d.intersects(&p))
    }

    /// The open dialog's rectangle, for frosting the video under it. With
    /// Settings open it's Settings' (a dialog over Settings is solid).
    fn dialog_rect(&self) -> Option<Rectangle> {
        if !self.dialog_open() {
            return None;
        }
        let size = if self.settings_open { self.settings_size } else { self.dialog_size };
        let (w, d) = (self.overlay_size.or(self.window_size)?, size?);
        Some(Rectangle { x: (w.width - d.width) / 2.0, y: (w.height - d.height) / 2.0, width: d.width, height: d.height })
    }

    /// The grid slot under a window point (all cameras shown).
    fn slot_at(&self, p: iced::Point) -> Option<usize> {
        if self.focus.is_some() {
            return None;
        }
        (0..6).find(|&s| self.tile_rect(s).is_some_and(|r| r.contains(p)))
    }

    /// The compact dashboard box in a tile: 98% wide, 0.8% from the
    /// bottom, 8% of the tile high but 50-90 px. Returns it and the tile.
    fn dashboard_rect(&self, slot: usize) -> Option<(Rectangle, Rectangle)> {
        let tile = self.tile_rect(slot)?;
        let w = tile.width * 0.98;
        let h = (tile.height * 0.08).clamp(50.0, 90.0);
        let bottom = tile.height * 0.008;
        Some((Rectangle { x: tile.x + (tile.width - w) / 2.0, y: tile.y + tile.height - bottom - h, width: w, height: h }, tile))
    }

    fn reset_zoom(&mut self) {
        self.zoom = 1.0;
        self.pan = (0.0, 0.0);
    }

    /// Keeps the zoomed picture covering the tile.
    fn clamp_pan(&mut self) {
        let Some(size) = self.focus.and_then(|f| self.tile_rect(f)).map(|r| r.size()) else { return };
        if self.zoom <= 1.0 {
            self.pan = (0.0, 0.0);
            return;
        }
        let max_x = size.width * (self.zoom - 1.0) / (2.0 * self.zoom) + 1.0;
        let max_y = size.height * (self.zoom - 1.0) / (2.0 * self.zoom) + 1.0;
        self.pan = (self.pan.0.clamp(-max_x, max_x), self.pan.1.clamp(-max_y, max_y));
    }

    fn show_zoom_badge(&mut self) -> Task<Message> {
        self.zoom_badge_until = Some(std::time::Instant::now() + ZOOM_BADGE);
        // One timer at a time, however fast the wheel turns; when it fires
        // early (the badge was extended) it waits again.
        if self.zoom_badge_timer {
            return Task::none();
        }
        self.zoom_badge_timer = true;
        self.zoom_badge_wait()
    }

    fn zoom_badge_wait(&self) -> Task<Message> {
        let left = self.zoom_badge_until.map(|t| t.saturating_duration_since(std::time::Instant::now())).unwrap_or_default();
        Task::perform(off_thread(move || std::thread::sleep(left + std::time::Duration::from_millis(30))), |_| Message::ZoomBadgeTimeout)
    }

    /// A select's choice (an index into settings_view::choices).
    fn choose(&mut self, menu: settings_view::Menu, i: usize) {
        use settings_view::Menu;
        match menu {
            Menu::Language => {
                if let Some((code, _)) = i18n::LANGUAGES.get(i) {
                    self.settings.language = code.to_string();
                    i18n::set_language(code);
                }
            }
            Menu::TimeFormat => self.settings.time_24h = i == 1,
            Menu::DialogStyle => {
                self.settings.solid_dialogs = i == 1;
                theme::set_solid_dialogs(self.settings.solid_dialogs);
            }
            Menu::DateFormat => {
                if let Some(f) = settings::DateFormat::ALL.get(i) {
                    self.settings.date_format = *f;
                }
            }
            Menu::DashboardStyle => {
                self.settings.dashboard_compact = i == 1;
                self.dash_offset = iced::Vector::ZERO;
            }
            Menu::Accel => {
                if let Some(m) = dashboard::AccelMode::ALL.get(i) {
                    self.settings.accel_mode = *m;
                }
            }
            Menu::MapStyle => self.settings.map_dark = i == 1,
            Menu::Skip => {
                if let Some(c) = settings_view::SKIP_CHOICES.get(i) {
                    self.settings.skip_seconds = *c;
                }
            }
        }
    }

    /// What the diagnostics report says about the app as it is now.
    fn diagnostics_snapshot(&self) -> diagnostics::Snapshot {
        let mut folder_lines = Vec::new();
        if self.root.is_some() {
            folder_lines.push(format!("Contents: {}", folder_summary(&self.collections, self.days.len())));
            folder_lines.push(format!("Day shown: {}, {} clips", self.day.as_deref().unwrap_or("none"), self.items.len()));
            if let Some(item) = self.selected.and_then(|i| self.items.get(i)) {
                folder_lines.push(format!(
                    "Clip shown: {:?}, {} minutes, up to {} cameras, reason {}",
                    item.collection.kind,
                    item.segments.len(),
                    item.cameras,
                    item.reason.as_deref().unwrap_or("none")
                ));
            }
        }
        if let Some(e) = &self.error {
            folder_lines.push(format!("Error shown: {e}"));
        }
        let size = self.window_size.map_or("unknown".to_string(), |s| format!("{:.0}x{:.0}", s.width, s.height));
        let mut app_lines = vec![
            format!("Window: {size}, tab {:?}, clip panel {}", self.tab, if self.panel_open { "open" } else { "closed" }),
            format!(
                "Open: {}",
                [
                    (self.settings_open, "Settings"),
                    (self.update.is_some(), "update dialog"),
                    (self.privacy_pending(), "privacy notice"),
                    (self.delete_confirm.is_some(), "delete dialog")
                ]
                .iter()
                .filter(|(on, _)| *on)
                .map(|(_, name)| *name)
                .collect::<Vec<_>>()
                .join(", ")
            ),
        ];
        app_lines.push(match (&self.drives_error, self.drives_loading, self.drives.len()) {
            (Some(e), _, _) => format!("Drive data: error: {e}"),
            (None, true, _) => "Drive data: loading".into(),
            (None, false, 0) => "Drive data: none loaded".into(),
            (None, false, n) => format!("Drive data: {n} drives"),
        });
        diagnostics::Snapshot {
            live: true,
            settings: Some(self.settings.clone()),
            folder: self.root.clone(),
            folder_lines,
            playback_lines: self.player.describe(),
            app_lines,
        }
    }

    /// The update check at startup, 2 s in, once the privacy notice is
    /// accepted (and unless devDisableApiRequests is set).
    fn startup_update_check(&self) -> Task<Message> {
        if self.privacy_pending() || self.settings.no_startup_check {
            return Task::none();
        }
        Task::perform(off_thread(|| std::thread::sleep(std::time::Duration::from_secs(2))), |_| Message::UpdateCheck(false))
    }

    /// The first-run privacy notice is up (not accepted, or a newer one).
    fn privacy_pending(&self) -> bool {
        self.settings.privacy_accepted < welcome::PRIVACY_VERSION
    }

    /// Whether the clip playing is GM Surround Vision footage.
    fn gm(&self) -> bool {
        self.selected.and_then(|i| self.items.get(i)).is_some_and(|it| it.collection.kind == Kind::Continuous)
    }

    /// The camera in a grid slot: the saved Tesla order, or GM's fixed one.
    fn camera_at(&self, slot: usize) -> Camera {
        if self.gm() {
            GRID[slot]
        } else {
            self.settings.camera_order[slot]
        }
    }

    /// The name on a camera's tile (GM's own names for its footage).
    fn camera_label(&self, camera: Camera) -> &'static str {
        if self.gm() {
            library::gm_label(camera)
        } else {
            camera.label()
        }
    }

    /// The front camera's telemetry now.
    fn front_telemetry(&self) -> Option<&telemetry::SeiMetadata> {
        let idx = GRID.iter().position(|c| *c == Camera::Front)?;
        self.player.shown(idx)?.telemetry.as_deref()
    }

    /// What either dashboard shows this frame.
    fn dash(&self, scale: f32) -> dashboard::Dash<'_> {
        dashboard::Dash {
            telemetry: self.front_telemetry(),
            time: self.player.wall_clock().map(|t| dashboard::time_of_day(t, self.settings.time_24h)).unwrap_or_else(|| "--:--".into()),
            metric: self.metric(),
            playing: self.player.is_playing(),
            blink_ms: self.epoch.elapsed().as_millis() % 700,
            scale,
            accel: self.settings.accel_mode,
            steering: self.steering,
        }
    }

    /// The steering wheel's easing (45/s, faster at higher speeds of play)
    /// and its G-force trail, once a frame.
    fn animate_dashboard(&mut self) {
        let now = std::time::Instant::now();
        let dt = self.last_frame.map_or(0.0, |t| (now - t).as_secs_f32().min(0.1));
        self.last_frame = Some(now);
        let Some(sei) = self.front_telemetry().cloned() else { return };
        let target = sei.steering_wheel_angle as f32;
        if self.player.is_playing() {
            let factor = 1.0 - (-45.0 * self.player.rate() as f32 * dt).exp();
            self.steering += (target - self.steering) * factor;
            if (target - self.steering).abs() < 0.05 {
                self.steering = target;
            }
        } else {
            self.steering = target;
        }
        let point = dashboard::gforce_point(&sei);
        let settled = self.gforce_trail.len() >= 3 && self.gforce_trail.iter().all(|p| *p == point);
        if !settled && self.gforce_trail.first() != Some(&point) || self.gforce_trail.len() < 3 {
            self.gforce_trail.insert(0, point);
            self.gforce_trail.truncate(3);
        }
    }

    /// Where a floating dashboard starts: the full one top right (20 px in),
    /// the compact one at the bottom of the front camera.
    fn dash_anchor(&self) -> Option<iced::Point> {
        let window = self.window_size?;
        if self.settings.dashboard_compact {
            let slot = self.settings.camera_order.iter().position(|c| *c == Camera::Front)?;
            let tile = self.tile_rect(slot).or_else(|| self.tile_rect(self.focus?))?;
            let size = dashboard::COMPACT_FLOATING;
            Some(iced::Point::new(tile.x + (tile.width - size.width) / 2.0, tile.y + tile.height - size.height - 8.0))
        } else {
            Some(iced::Point::new(window.width - 20.0 - dashboard::full_size(false).width, 20.0))
        }
    }

    /// The floating dashboard (full, or compact not fixed to the camera),
    /// in window coordinates, kept on screen above the controls.
    fn floating_dash_rect(&self) -> Option<Rectangle> {
        let s = &self.settings;
        if !s.dashboard_enabled || (s.dashboard_compact && s.compact_fixed) || !self.player.has_media() || self.gm() {
            return None;
        }
        let window = self.window_size?;
        let anchor = self.dash_anchor()?;
        let size = if s.dashboard_compact { dashboard::COMPACT_FLOATING } else { dashboard::full_size(self.dash_details) };
        let max_x = (window.width - size.width).max(0.0);
        let max_y = (window.height - CONTROLS_HEIGHT - size.height).max(0.0);
        Some(Rectangle {
            x: (anchor.x + self.dash_offset.x).clamp(0.0, max_x),
            y: (anchor.y + self.dash_offset.y).clamp(0.0, max_y),
            width: size.width,
            height: size.height,
        })
    }

    /// The floating dashboard itself, placed over everything but dialogs.
    fn floating_dashboard(&self) -> Option<Element<'_, Message>> {
        let rect = self.floating_dash_rect()?;
        let body: Element<'_, Message> = if self.settings.dashboard_compact {
            dashboard::compact(self.dash(0.74))
        } else {
            dashboard::full(
                self.dash(1.0),
                dashboard::Full {
                    trail: &self.gforce_trail,
                    t: self.epoch.elapsed().as_secs_f32(),
                    details_open: self.dash_details,
                    on_toggle_details: Message::DashDetails,
                },
            )
        };
        let panel = dashboard::frame(body).width(rect.width).height(rect.height).clip(true);
        // Dragged anywhere (buttons still click).
        let panel = tile_input::tile_input(panel).on_drag(Message::DashDrag).grab(true);
        Some(
            container(panel)
                .padding(Padding { top: rect.y, left: rect.x, ..Padding::ZERO })
                .width(Length::Fill)
                .height(Length::Fill)
                .into(),
        )
    }

    /// Wakes the app when map tiles arrive, then waits for the next ones.
    fn watch_tiles(&self, seen: u64) -> Task<Message> {
        let tiles = self.tiles.clone();
        Task::perform(off_thread(move || tiles.wait_for_update(seen)), Message::TilesUpdated)
    }

    /// Heading-up mode zooms in a little, by about 1.42x.
    fn map_zoom_effective(&self) -> f32 {
        if self.map_heading_up {
            self.map_zoom + 0.506
        } else {
            self.map_zoom
        }
    }

    fn map_visible(&self) -> bool {
        self.settings.map_enabled && self.player.has_media() && !self.gm()
    }

    /// The map's starting place: 20 px from the top, 380 px from the left.
    fn map_anchor(&self) -> iced::Point {
        iced::Point::new(380.0, 20.0)
    }

    /// The map panel (260 px square), kept on screen above the controls.
    fn map_rect(&self) -> Option<Rectangle> {
        if !self.map_visible() {
            return None;
        }
        let window = self.window_size?;
        let anchor = self.map_anchor();
        let size = 260.0;
        Some(Rectangle {
            x: (anchor.x + self.map_offset.x).clamp(0.0, (window.width - size).max(0.0)),
            y: (anchor.y + self.map_offset.y).clamp(0.0, (window.height - CONTROLS_HEIGHT - size).max(0.0)),
            width: size,
            height: size,
        })
    }

    /// The route the map shows: the selected drive's (with its FSD events
    /// when Show FSD Events is on), else the playing clip's.
    fn map_route(&self) -> (&[map::RoutePoint], &[(f32, f32, bool)]) {
        if let Some(d) = self.selected_drive.and_then(|id| self.drives.iter().find(|d| d.id == id)) {
            let events: &[(f32, f32, bool)] = if self.settings.show_fsd_events { &d.fsd_events } else { &[] };
            return (&d.route, events);
        }
        (&self.clip_route, &[])
    }

    /// Once a frame: follow the car (playing undoes panning),
    /// ease the map's turn towards the heading, and read the new clip's
    /// route when playback moves to another clip.
    fn follow_map(&mut self) -> Task<Message> {
        if !self.map_visible() {
            return Task::none();
        }
        if self.player.is_playing() {
            self.map_pan = (0.0, 0.0);
        }
        if let Some((_, _, heading)) = self.front_telemetry().and_then(map::car) {
            let mut delta = heading - self.map_bearing.rem_euclid(360.0);
            if delta > 180.0 {
                delta -= 360.0;
            } else if delta < -180.0 {
                delta += 360.0;
            }
            let rate = self.player.rate() as f32;
            self.map_bearing += delta * (1.0 - (-(1.0 / 60.0) * 20.0 * rate).exp());
        }
        if self.selected_drive.is_some() {
            return Task::none();
        }
        let file = self.player.current_file(Camera::Front).cloned();
        if file != self.clip_route_file {
            self.clip_route_file = file.clone();
            self.clip_route.clear();
            if let Some(path) = file {
                let fallback = (path.clone(), Vec::new());
                return Task::perform(
                    off_thread_or(fallback, move || {
                        let route = map::clip_route(&path);
                        (path, route)
                    }),
                    |(path, route)| Message::ClipRoute(path, route),
                );
            }
        }
        Task::none()
    }

    /// The map panel: the map, and on hover the hint, re-centre and
    /// heading-up / north-up buttons; the credits along the bottom.
    fn map_panel(&self) -> Option<Element<'_, Message>> {
        let rect = self.map_rect()?;
        let sei = self.front_telemetry();
        let car = sei.and_then(map::car);
        let (route, events) = self.map_route();
        let base = car.map(|(lat, lon, _)| map::world(lat, lon)).or_else(|| {
            let mid = route.get(route.len() / 2)?;
            Some(map::world(mid.0 as f64, mid.1 as f64))
        })?;
        // Back from world units to latitude/longitude, panned.
        let (wx, wy) = (base.0 + self.map_pan.0, base.1 + self.map_pan.1);
        let lon = wx * 360.0 - 180.0;
        let lat = (std::f64::consts::PI * (1.0 - 2.0 * wy)).sinh().atan().to_degrees();
        let style = if self.settings.map_dark { map::tiles::Style::Dark } else { map::tiles::Style::Light };
        let view = map::MapView {
            center: (lat, lon),
            zoom: self.map_zoom,
            bearing: if self.map_heading_up { self.map_bearing } else { 0.0 },
            car,
            route,
            events,
            arrow: &self.arrow,
            on_pan: Message::MapPan,
            on_zoom: Message::MapZoom,
        };
        // The map fills the glass panel inside its 1 px border; tiles are
        // clipped to its rounded corners, the route and arrow drawn above.
        let inner = rect.width - 2.0;
        let radius = DASH_RADIUS - 1.0;
        let tiles = map::TileLayer {
            tiles: &self.tiles,
            style,
            center: (lat, lon),
            zoom: view.effective_zoom(),
            bearing: view.bearing,
            radius,
        };
        let mut layers = stack![
            iced::widget::canvas(tiles).width(inner).height(inner),
            iced::widget::canvas(view).width(inner).height(inner),
        ];
        let attribution = self.tiles.index().map(|i| i.attribution).unwrap_or_default();
        if !attribution.is_empty() {
            layers = layers.push(
                container(container(text(attribution).size(8).center().color(iced::Color { a: 0.75, ..iced::Color::WHITE })).padding([1, 4]).style(theme::map_credit))
                    .width(Length::Fill)
                    .height(Length::Fill)
                    // At most the panel's width less 28 px (14 px a side), which
                    // keeps the box clear of the panel's rounded corners.
                    .padding(Padding { bottom: 4.0, left: 14.0, right: 14.0, top: 0.0 })
                    .align_x(Horizontal::Center)
                    .align_y(Vertical::Bottom),
            );
        }
        if self.map_hover {
            layers = layers.push(
                container(container(text(i18n::t("ui.map.hint")).size(10)).padding([4, 8]).style(theme::map_hint))
                    .width(Length::Fill)
                    .padding(Padding { top: 8.0, ..Padding::ZERO })
                    .align_x(Horizontal::Center),
            );
            let recenter = button(container(svg_icon(RECENTER_SVG, 16.0, theme::TEXT_SECONDARY)).center(Length::Fill))
                .width(32)
                .height(32)
                .padding(0)
                .style(theme::map_button)
                .on_press(Message::MapRecenter);
            // The compass turns with the map (north-up shows it upright).
            let turn = if self.map_heading_up { -self.map_bearing } else { 0.0 };
            let compass = button(
                container(
                    iced::widget::svg(iced::widget::svg::Handle::from_memory(COMPASS_SVG.as_bytes()))
                        .width(16)
                        .height(16)
                        .rotation(iced::Radians(turn.to_radians())),
                )
                .center(Length::Fill),
            )
            .width(32)
            .height(32)
            .padding(0)
            .style(theme::map_button)
            .on_press(Message::MapOrientation);
            layers = layers.push(
                container(row![compass, recenter].spacing(4))
                    .width(Length::Fill)
                    .height(Length::Fill)
                    .padding(Padding { right: 10.0, bottom: 10.0, ..Padding::ZERO })
                    .align_x(Horizontal::Right)
                    .align_y(Vertical::Bottom),
            );
        }
        let panel = container(layers).padding(1).width(rect.width).height(rect.height).style(theme::dashboard_glass);
        let panel = tile_input::tile_input(panel).on_drag(Message::MapDrag).grab(true);
        let panel = mouse_area(panel).on_enter(Message::MapHover(true)).on_exit(Message::MapHover(false));
        Some(
            container(panel)
                .padding(Padding { top: rect.y, left: rect.x, ..Padding::ZERO })
                .width(Length::Fill)
                .height(Length::Fill)
                .into(),
        )
    }

    /// Shows a toast: 3.2 s, or 5.5 s for an error.
    fn notify(&mut self, text: String, error: bool) -> Task<Message> {
        if error {
            log::warn!("message shown: {text}");
        }
        self.next_toast += 1;
        let id = self.next_toast;
        self.toasts.push((id, text));
        if self.toasts.len() > 4 {
            self.toasts.remove(0);
        }
        let ms = if error { 5500 } else { 3200 };
        Task::perform(off_thread(move || std::thread::sleep(std::time::Duration::from_millis(ms))), move |_| Message::ToastExpire(id))
    }

    /// The selected event's camera glows (the event camera highlight):
    /// red for Sentry, yellow for Saved, each with its own setting; not
    /// while a camera is focused.
    fn glow(&self) -> Option<(Camera, iced::Color, iced::Color)> {
        if self.focus.is_some() {
            return None;
        }
        let item = self.items.get(self.selected?)?;
        let camera = item.camera?;
        match item.collection.kind {
            Kind::Sentry if self.settings.sentry_glow => Some((camera, theme::ERROR, iced::Color::from_rgb8(255, 100, 100))),
            Kind::Saved if self.settings.saved_glow => Some((camera, theme::WARNING, iced::Color::from_rgb8(255, 255, 100))),
            _ => None,
        }
    }

    /// Which drives the TAG filter lets through, and where each card sits
    /// (card heights depend on units and the Footage chip).
    fn relayout_drives(&mut self) {
        let needle = self.drive_filter.trim().to_lowercase();
        self.drive_shown = (0..self.drives.len())
            .filter(|&i| needle.is_empty() || self.drives[i].tags.iter().any(|t| t.to_lowercase().contains(&needle)))
            .collect();
        let (rows, tops, total) = drive_list::layout(&self.drives, &self.drive_shown, self.metric(), self.settings.show_drive_stats, &self.footage_days);
        self.drive_rows = rows;
        self.drive_tops = tops;
        self.drive_total = total;
    }

    /// Wakes the app when a new place name arrives (so names show while
    /// paused too), then waits for the next one.
    fn watch_places(&self, seen: u64) -> Task<Message> {
        match self.places.clone() {
            Some(g) => Task::perform(off_thread(move || g.wait_for_update(seen)), Message::PlacesUpdated),
            None => Task::none(),
        }
    }

    /// Forgets the drive history (no drive-data.json for this folder).
    fn clear_drives(&mut self) {
        self.drives = Default::default();
        self.drives_path = None;
        self.drives_loading = false;
        self.drives_error = None;
        self.selected_drive = None;
        self.relayout_drives();
    }

    fn load_drives(&mut self, path: PathBuf) -> Task<Message> {
        self.drives_loading = true;
        self.drives_error = None;
        self.selected_drive = None;
        self.drives_path = Some(path.clone());
        let p = path.clone();
        Task::perform(
            off_thread_or(Err(i18n::t("app.unreadable").to_string()), move || {
                drives::load(&p).map(std::sync::Arc::new).map_err(|e| format!("{e:#}"))
            }),
            move |r| Message::DrivesLoaded(path.clone(), r),
        )
    }

    fn run_shortcut(&mut self, action: shortcuts::Action) -> Task<Message> {
        use shortcuts::Action;
        let speed_index = || SPEEDS.iter().position(|s| s.0 == self.player.rate()).unwrap_or(1);
        // The export editor open: its own play and skip; the speed keys
        // still set the speed (it plays with playback's decoders); the
        // rest would change what's under it.
        if self.editor_has_keys() {
            use export_view::ExportMsg;
            match action {
                Action::PlayPause => return Task::done(Message::Export(ExportMsg::PlayPreview)),
                Action::SkipForward => return Task::done(Message::Export(ExportMsg::Skip(self.settings.skip_seconds))),
                Action::SkipBackward => return Task::done(Message::Export(ExportMsg::Skip(-self.settings.skip_seconds))),
                Action::SpeedUp | Action::SpeedDown | Action::SpeedReset | Action::SpeedMax => {}
                _ => return Task::none(),
            }
        }
        match action {
            Action::PlayPause => return Task::done(Message::TogglePlay),
            Action::SkipForward => return Task::done(Message::Skip(self.settings.skip_seconds)),
            Action::SkipBackward => return Task::done(Message::Skip(-self.settings.skip_seconds)),
            Action::SpeedUp => self.player.set_rate(SPEEDS[(speed_index() + 1).min(SPEEDS.len() - 1)].0),
            Action::SpeedDown => self.player.set_rate(SPEEDS[speed_index().saturating_sub(1)].0),
            Action::SpeedReset => self.player.set_rate(1.0),
            Action::SpeedMax => self.player.set_rate(SPEEDS[SPEEDS.len() - 1].0),
            Action::ToggleDash => {
                // The dashboard toggle is remembered.
                self.settings.dashboard_enabled = !self.settings.dashboard_enabled;
                settings::save(&self.settings);
            }
            // For this session only; the saved setting is not changed.
            Action::ToggleMetric => {
                self.metric_override = Some(!self.metric());
                self.relayout_drives();
            }
            Action::ToggleClips => self.panel_open = !self.panel_open,
            Action::ToggleMap => {
                self.settings.map_enabled = !self.settings.map_enabled;
                settings::save(&self.settings);
            }
            Action::NextClip | Action::PrevClip => {
                let n = self.items.len();
                if n > 0 {
                    let cur = self.selected.unwrap_or(0);
                    let next = if action == Action::NextClip { (cur + 1) % n } else { (cur + n - 1) % n };
                    return Task::done(Message::SelectItem(next));
                }
            }
        }
        Task::none()
    }

    fn subscription(&self) -> Subscription<Message> {
        let frames = if self.player.wants_frames() {
            iced::window::frames().map(|_| Message::Tick)
        } else if self.scanning || self.glow().is_some() || self.privacy_pending() || matches!(self.update, Some(update_view::Dialog::Downloading(_))) {
            // The spinner and the glow move while paused too.
            iced::window::frames().map(|_| Message::Animate)
        } else {
            Subscription::none()
        };
        Subscription::batch([frames, iced::event::listen_with(input_event)])
    }

    fn view(&self) -> Element<'_, Message> {
        // The clip browser floats over the top-left of the camera grid,
        // which keeps the full width.
        let browser: Element<'_, Message> = if self.panel_open { self.clip_browser() } else { self.collapsed_browser() };
        // Reports the panel's size so the video under it can be frosted.
        // Opaque: clicks and scrolls on the panel never reach the camera below.
        let browser = sensor(iced::widget::opaque(browser)).on_show(Message::PanelSized).on_resize(Message::PanelSized);
        let floating = container(browser)
            .padding(Padding { top: PANEL_Y, right: 0.0, bottom: 24.0, left: PANEL_X })
            .width(Length::Fill)
            .height(Length::Fill)
            .align_x(Horizontal::Left)
            .align_y(Vertical::Top);
        let mut stage = stack![container(self.camera_grid()).padding(video::MARGIN)].height(Length::Fill);
        // No folder open yet: a click anywhere picks one.
        if self.root.is_none() && !self.scanning {
            let prompt = column![
                icon(theme::icon::FOLDER, 48.0).color(theme::TEXT_MUTED),
                text(i18n::t("ui.dropOverlay.message")).size(14),
                button(text(i18n::t("ui.dropOverlay.chooseFolder")).size(12)).padding([6, 14]).style(theme::secondary_button).on_press(Message::OpenFolder),
            ]
            .spacing(12)
            .align_x(Alignment::Center);
            stage = stage.push(mouse_area(container(prompt).center(Length::Fill).style(theme::overlay(0.55))).on_press(Message::OpenFolder));
        }
        // Under a dialog the panel steps aside: the dialog frosts the video,
        // but iced can't frost the panel's text, which would show through.
        if !self.panel_under_dialog() {
            stage = stage.push(floating);
        }
        if self.file_hover {
            stage = stage.push(
                container(
                    container(
                        column![icon(theme::icon::FOLDER_OPEN, 48.0).color(theme::ACCENT), text(i18n::t("app.dropFolder")).size(14)]
                            .spacing(12)
                            .align_x(Alignment::Center),
                    )
                    .center(Length::Fill)
                    .style(theme::drop_target),
                )
                .padding(24)
                .width(Length::Fill)
                .height(Length::Fill)
                .style(theme::overlay(0.55)),
            );
        }
        if self.scanning {
            // A spinner over everything while the folder is scanned.
            let spin = iced::widget::canvas(spinner::Spinner { t: self.epoch.elapsed().as_secs_f32() }).width(48).height(48);
            stage = stage.push(
                container(column![spin, text(i18n::t("ui.loading.scanning")).size(14).color(theme::TEXT)].spacing(20).align_x(Alignment::Center))
                    .center(Length::Fill)
                    .style(theme::overlay(0.85)),
            );
        }
        if !self.toasts.is_empty() {
            // Toasts: bottom left, above the controls.
            let list = self.toasts.iter().fold(Column::new().spacing(10), |col, (_, msg)| {
                col.push(
                    container(
                        row![container(space()).width(9).height(9).style(theme::toast_dot), text(msg).size(12)]
                            .spacing(10)
                            .align_y(Alignment::Center),
                    )
                    .padding([10, 12])
                    .max_width(520)
                    .style(theme::toast),
                )
            });
            stage = stage.push(
                container(list)
                    .padding(Padding { left: 16.0, bottom: 16.0, ..Padding::ZERO })
                    .width(Length::Fill)
                    .height(Length::Fill)
                    .align_x(Horizontal::Left)
                    .align_y(Vertical::Bottom),
            );
        }
        if let Some((from, at)) = self.camera_drag {
            // A camera being dragged: its name by the pointer.
            let name = self.camera_label(self.camera_at(from));
            stage = stage.push(
                container(container(text(name).size(12).font(semibold(INTER)).color(iced::Color::WHITE)).padding([6, 12]).style(theme::drag_indicator))
                    .padding(Padding { top: at.y + 12.0, left: at.x + 12.0, ..Padding::ZERO }),
            );
        }
        let app = container(column![stage, self.controls()])
            .width(Length::Fill)
            .height(Length::Fill)
            .style(theme::app_background);
        // The window's size (to place floating panels), and the floating
        // dashboard over everything but dialogs.
        let mut app = stack![sensor(app).on_show(Message::WindowSized).on_resize(Message::WindowSized)];
        // A dialog should blur the panels behind it, but iced can only frost
        // the video, so the floating map and dashboard step aside instead.
        let dialog_open = self.dialog_open();
        if !dialog_open {
            if let Some(map) = self.map_panel() {
                app = app.push(map);
            }
            if let Some(dash) = self.floating_dashboard() {
                app = app.push(dash);
            }
        }
        if self.privacy_pending() {
            return stack![app, welcome::view(self.epoch.elapsed().as_secs_f32())].into();
        }
        if self.delete_confirm.is_some() {
            return stack![app, self.delete_dialog()].into();
        }
        // The support chat floats at the top right, as in earlier versions.
        if let Some(rect) = self.chat_rect() {
            app = app.push(
                container(support_view::view(&self.chat, self.settings.time_24h, rect.size()))
                    .padding(Padding { top: rect.y, right: 0.0, bottom: 0.0, left: rect.x })
                    .width(Length::Fill)
                    .height(Length::Fill)
                    .align_x(Horizontal::Left)
                    .align_y(Vertical::Top),
            );
        }
        // The export dialog (which shows the shared clips list when it's
        // open), or the list on its own (opened from Settings).
        if self.export.open || self.export.share.list_open {
            let overlay = sensor(self.export_dialog()).on_show(Message::OverlaySized).on_resize(Message::OverlaySized);
            app = app.push(overlay);
        }
        if self.settings_open {
            let overlay = sensor(settings_view::view(&self.settings, &self.settings_ui, &self.shortcuts, Message::SettingsSized))
                .on_show(Message::OverlaySized)
                .on_resize(Message::OverlaySized);
            app = stack![app, overlay];
        }
        if self.prerelease_question {
            // Over Settings these are solid: what's under them is Settings'
            // text, which can't be frosted.
            theme::set_stacked(self.settings_open);
            app = app.push(update_view::prerelease_question());
        } else if let Some(notes) = &self.changelog {
            theme::set_stacked(self.settings_open);
            app = app.push(update_view::changelog(notes));
        } else if let Some(dialog) = &self.update {
            theme::set_stacked(self.settings_open);
            app = app.push(update_view::view(dialog, self.update_progress.load(std::sync::atomic::Ordering::Relaxed)));
        }
        app.into()
    }

    /// The two delete dialogs: are you sure, then are you really sure.
    fn delete_dialog(&self) -> Element<'_, Message> {
        let Some((_, dir, second)) = &self.delete_confirm else { return space().into() };
        let t = i18n::t;
        let (glyph, title, message) = if *second {
            (theme::icon::ERROR, t("ui.clipBrowser.deleteFinalConfirmTitle"), t("ui.clipBrowser.deleteFinalConfirmMessage"))
        } else {
            (theme::icon::DELETE, t("ui.clipBrowser.deleteConfirmTitle"), t("ui.clipBrowser.deleteConfirmMessage"))
        };
        let path = text(dir.display().to_string()).size(12).font(MONO);
        let mut path_box = column![].spacing(6);
        if !*second {
            path_box = path_box.push(text(t("ui.clipBrowser.deleteConfirmPath").to_uppercase()).size(11).color(theme::TEXT_MUTED));
        }
        path_box = path_box.push(container(path).padding(8).width(Length::Fill).style(theme::path_code));
        let mut body = column![text(message).size(14), container(path_box).padding(12).width(Length::Fill).style(theme::path_box)].spacing(16);
        if !*second {
            body = body.push(
                row![icon(theme::icon::WARNING, 16.0).color(theme::WARNING), text(t("ui.clipBrowser.deleteConfirmWarning")).size(13).color(theme::WARNING)]
                    .spacing(6)
                    .align_y(Alignment::Center),
            );
        }
        let confirm_label = if self.deleting {
            "…".to_string()
        } else if *second {
            t("ui.clipBrowser.deleteConfirmBtn").to_string()
        } else {
            t("ui.clipBrowser.deleteBtn").to_string()
        };
        let confirm = button(row![icon(theme::icon::DELETE, 16.0), text(confirm_label).size(13).font(semibold(INTER))].spacing(6).align_y(Alignment::Center))
            .padding([10, 16])
            .style(theme::danger_button)
            .on_press_maybe((!self.deleting).then_some(if *second { Message::DeleteConfirm } else { Message::DeleteNext }));
        let cancel = button(text(t("ui.clipBrowser.cancelBtn")).size(13).font(semibold(INTER)))
            .padding([10, 16])
            .style(theme::secondary_button)
            .on_press_maybe((!self.deleting).then_some(Message::DeleteCancel));
        let dialog = container(column![
            container(
                row![
                    icon(glyph, 22.0).color(theme::ERROR),
                    text(title).size(15).font(semibold(INTER)),
                    space().width(Length::Fill),
                    button(container(text("×").size(18)).center(Length::Fill))
                        .width(28)
                        .height(28)
                        .padding(0)
                        .style(theme::modal_close)
                        .on_press_maybe((!self.deleting).then_some(Message::DeleteCancel)),
                ]
                .spacing(8)
                .align_y(Alignment::Center),
            )
            .padding([16, 20])
            .style(theme::modal_header),
            container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
            container(body).padding(20),
            container(row![space().width(Length::Fill), confirm, cancel].spacing(10)).padding([16, 20]).width(Length::Fill).style(theme::modal_footer),
        ])
        .width(420)
        .clip(true)
        .style(theme::modal);
        iced::widget::opaque(mouse_area(container(measured(dialog)).center(Length::Fill).style(theme::backdrop)).on_press(Message::DeleteCancel))
    }

    // ---------------------------------------------------------------------
    // Clip browser
    // ---------------------------------------------------------------------

    /// km/h: the setting, unless the shortcut flipped it for this session.
    fn metric(&self) -> bool {
        self.metric_override.unwrap_or(self.settings.metric)
    }

    /// Whose footage the folder holds: GM's (Continuous recordings) or Tesla's.
    fn brand(&self) -> &'static str {
        if self.collections.iter().any(|c| c.kind == Kind::Continuous) {
            "GM"
        } else {
            "Tesla"
        }
    }

    fn source_name(&self) -> String {
        self.root
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_default()
    }

    fn clip_browser(&self) -> Element<'_, Message> {
        let clips: usize = self.items.iter().map(|i| i.segments.len()).sum();
        let subtitle = match (&self.root, &self.day) {
            (None, _) => i18n::t("ui.clipBrowser.subtitle").to_string(),
            (Some(_), Some(day)) if !self.loading_day => format!("{} · {}: {clips} {} {day}", self.brand(), self.source_name(), i18n::t("ui.clipBrowser.clipsOn")),
            (Some(_), _) => format!("{} · {}", self.brand(), self.source_name()),
        };
        let title = row![
            container(icon(theme::icon::VIDEOCAM, 20.0)).center(30).style(theme::logo),
            text(i18n::t("ui.clipBrowser.title")).size(20).font(semibold(INTER)),
        ]
        .spacing(8)
        .align_y(Alignment::Center);
        // The Drives tab has a TAG filter in place of the date picker.
        let date_row = if self.tab == Tab::Drives {
            row![
                text(i18n::t("app.tag")).size(10).font(theme::medium(INTER)).color(theme::TEXT_MUTED),
                text_input(i18n::t("app.filter"), &self.drive_filter)
                    .on_input(Message::DriveFilter)
                    .size(12)
                    .padding([4, 10])
                    .width(Length::Fill)
                    .style(theme::filter_input),
            ]
        } else {
            row![text(i18n::t("ui.clipBrowser.dateLabel").to_uppercase()).size(10).font(theme::medium(INTER)).color(theme::TEXT_MUTED), self.day_picker()]
        }
        .spacing(8)
        .align_y(Alignment::Center);
        let actions = row![
            button(icon(theme::icon::CHEVRON_LEFT, 20.0)).padding(6).style(theme::icon_button).on_press(Message::TogglePanel),
            button(icon(theme::icon::FOLDER_OPEN, 20.0)).padding(6).style(theme::icon_button).on_press(Message::OpenFolder),
        ]
        .spacing(2);
        let header = container(
            row![
                column![title, text(subtitle).size(11).color(theme::TEXT_MUTED), date_row].spacing(6).width(Length::Fill),
                actions
            ]
            .spacing(10),
        )
        .padding([14, 16])
        .width(Length::Fill)
        .style(theme::panel_header);

        let tabs = container(
            row![
                button(text(i18n::t("ui.clipBrowser.title")).size(11).center().width(Length::Fill))
                    .width(Length::Fill)
                    .padding([6, 10])
                    .style(theme::tab(self.tab == Tab::Clips))
                    .on_press(Message::ShowTab(Tab::Clips)),
                button(
                    container(
                        if self.drives.is_empty() {
                            row![text(i18n::t("app.tabDrives")).size(11)]
                        } else {
                            row![
                                text(i18n::t("app.tabDrives")).size(11),
                                container(text(self.drives.len().to_string()).size(10)).padding([1, 6]).style(theme::tab_count(self.tab == Tab::Drives)),
                            ]
                            .spacing(6)
                            .align_y(Alignment::Center)
                        },
                    )
                    .center_x(Length::Fill),
                )
                    .width(Length::Fill)
                    .padding([6, 10])
                    .style(theme::tab(self.tab == Tab::Drives))
                    .on_press(Message::ShowTab(Tab::Drives)),
            ]
            .spacing(4),
        )
        .padding(4)
        .style(theme::tab_bar);

        let body: Element<'_, Message> = match self.tab {
            Tab::Drives if self.drives_loading => column![
                placeholder(i18n::t("app.loadingDrives")),
                placeholder(i18n::t("app.largeDriveData")),
            ]
            .into(),
            Tab::Drives if self.drives.is_empty() => {
                let mut c = column![
                    placeholder(i18n::t("app.noDriveData")),
                    container(
                        button(text(i18n::t("app.selectDriveData")).size(12))
                            .padding([8, 14])
                            .style(theme::accent_button)
                            .on_press(Message::PickDriveData)
                    )
                    .center_x(Length::Fill),
                ]
                .spacing(4);
                if let Some(e) = &self.drives_error {
                    c = c.push(container(text(e).size(11).color(theme::ERROR)).padding([8, 14]));
                }
                c.into()
            }
            Tab::Drives => {
                let list = drive_list::view(
                    drive_list::ListView {
                        drives: &self.drives,
                        rows: &self.drive_rows,
                        tops: &self.drive_tops,
                        total: self.drive_total,
                        selected: self.selected_drive,
                        scroll: self.drive_scroll.0,
                        viewport: self.drive_scroll.1,
                        metric: self.metric(),
                        stats: self.settings.show_drive_stats,
                        h24: self.settings.time_24h,
                        footage_days: &self.footage_days,
                        places: self.places.as_ref().filter(|_| self.settings.place_names),
                    },
                    Message::SelectDrive,
                    Message::DriveScroll,
                );
                // The floating panel sizes to its content; the list's height
                // is set where the panel is laid out.
                list
            }
            Tab::Clips if self.root.is_none() => column![
                placeholder(i18n::t("ui.clipBrowser.subtitle")),
                container(
                    button(row![icon(theme::icon::FOLDER_OPEN, 18.0), text(i18n::t("ui.clipBrowser.chooseFolder")).size(12)].spacing(6).align_y(Alignment::Center))
                        .padding([8, 14])
                        .style(theme::accent_button)
                        .on_press(Message::OpenFolder)
                )
                .center_x(Length::Fill),
            ]
            .spacing(4)
            .into(),
            Tab::Clips if self.loading_day => placeholder(i18n::t("app.loadingClips")),
            Tab::Clips if self.items.is_empty() => placeholder(i18n::t("app.noClipsDay")),
            Tab::Clips => scrollable(
                self.items
                    .iter()
                    .enumerate()
                    .fold(Column::new().spacing(8), |col, (i, item)| col.push(clip_card(item, i, self.selected == Some(i), self.hovered_clip == Some(i))))
                    .padding([2, 12]),
            )
            .direction(scrollable::Direction::Vertical(scrollable::Scrollbar::new().width(6).scroller_width(6).margin(3)))
            .style(theme::thin_scroll)
            .height(Length::Shrink)
            .into(),
        };

        let divider = container(space().height(1)).width(Length::Fill).style(theme::hairline);
        let mut panel = column![header, divider, container(tabs).padding([10, 12]), body];
        if let Some(e) = &self.error {
            panel = panel.push(container(text(e).size(11).color(theme::ERROR)).padding([8, 14]));
        }
        // The Drives list fills the panel down to the bottom of the window;
        // otherwise the panel fits its content.
        let tall = self.tab == Tab::Drives && !self.drives.is_empty();
        container(panel.push(space().height(12)))
            .width(340)
            .height(if tall { Length::Fill } else { Length::Shrink })
            .clip(true)
            .style(theme::panel)
            .into()
    }

    /// The collapsed panel: a 44 px glass square with the chevron.
    fn collapsed_browser(&self) -> Element<'_, Message> {
        container(
            button(container(icon(theme::icon::CHEVRON_LEFT, 20.0)).center(Length::Fill))
                .width(44)
                .height(44)
                .padding(0)
                .style(theme::collapsed_button)
                .on_press(Message::TogglePanel),
        )
        .width(44)
        .height(44)
        .style(theme::panel_radius(COLLAPSED_RADIUS))
        .into()
    }

    fn day_picker(&self) -> Element<'_, Message> {
        let format = self.settings.date_format;
        if !native_menu::AVAILABLE {
            let option = |iso: &String| DayOption { label: format.show(iso), iso: iso.clone() };
            let options: Vec<DayOption> = self.days.iter().map(option).collect();
            return pick_list(options, self.day.as_ref().map(option), |d: DayOption| Message::PickDay(d.iso))
                .placeholder(i18n::t("ui.clipBrowser.selectDate"))
                .text_size(11)
                .padding([3, 10])
                .handle(theme::chevron_handle(14.0))
                .style(theme::day_select)
                .into();
        }
        let label = self.day.as_deref().map(|d| format.show(d)).unwrap_or_else(|| i18n::t("ui.clipBrowser.selectDate").into());
        button(row![text(label).size(11), icon(theme::icon::EXPAND_MORE, 14.0)].spacing(6).align_y(Alignment::Center))
            .padding([3, 10])
            .style(theme::day_pill)
            .on_press_maybe((!self.days.is_empty()).then_some(Message::DayMenu))
            .into()
    }

    // ---------------------------------------------------------------------
    // Cameras
    // ---------------------------------------------------------------------

    fn camera_grid(&self) -> Element<'_, Message> {
        let tile = |slot: usize| -> Element<'_, Message> {
            let camera = self.camera_at(slot);
            // The player's tile for this camera (its tiles follow GRID).
            let idx = GRID.iter().position(|c| *c == camera).unwrap_or(slot);
            let picture = self.player.shown(idx).map(|s| (s.id, s.frame.clone()));
            let glass = self.panel_size.filter(|_| !self.panel_under_dialog()).map(|size| video::Glass {
                rect: Rectangle::new(iced::Point::new(PANEL_X, PANEL_Y), size),
                radius: if self.panel_open { PANEL_RADIUS } else { COLLAPSED_RADIUS },
                blur: self.settings.glass_blur,
                saturate: GLASS_SATURATE,
            });
            let is_front = camera == library::Camera::Front;
            let fixed_compact = self.settings.dashboard_enabled && self.settings.dashboard_compact && self.settings.compact_fixed && !self.gm();
            let dash_rect = if is_front && fixed_compact && self.player.slot_active(idx) { self.dashboard_rect(slot) } else { None };
            let mut glass2 = dash_rect.map(|(rect, _)| video::Glass {
                rect,
                radius: DASH_RADIUS,
                blur: self.settings.glass_blur,
                saturate: GLASS_SATURATE,
            });
            // A floating dashboard frosts whatever camera it is over.
            if let Some(rect) = self.floating_dash_rect() {
                glass2 = Some(video::Glass { rect, radius: DASH_RADIUS, blur: self.settings.glass_blur, saturate: GLASS_SATURATE });
            }
            // The support chat is glass where it covers this tile.
            if let Some(rect) = self.chat_rect().filter(|r| self.tile_rect(slot).is_some_and(|t| t.intersects(r))) {
                glass2 = Some(video::Glass { rect, radius: 16.0, blur: self.settings.glass_blur, saturate: GLASS_SATURATE });
            }
            // The Settings dialog is glass too: it takes the
            // dashboard's slot (the dialog covers the middle of the screen,
            // the side panel stays frosted beside it).
            if let Some(rect) = self.dialog_rect() {
                glass2 = Some(video::Glass { rect, radius: settings_view::RADIUS, blur: self.settings.glass_blur, saturate: GLASS_SATURATE });
            }
            let focused = self.focus == Some(slot);
            let view = video::View {
                zoom: if focused { self.zoom } else { 1.0 },
                pan: if focused { self.pan } else { (0.0, 0.0) },
                mirror: camera.mirrored() && self.settings.mirror_cameras && !self.gm(),
                square: false,
            };
            // The video fills the tile's cell, half the gap included, so
            // frosted glass can smear across the gaps too.
            let video: Option<Element<'_, Message>> = self
                .player
                .slot_active(idx)
                .then(|| shader(video::VideoTile { slot: idx, picture, glass, glass2, view }).width(Length::Fill).height(Length::Fill).into());
            // The camera's name sits on top of the video, so the frosted
            // panel (which only blurs the video) can't blur it: hide it
            // while the panel covers it (it would be a smudge).
            let label_rect = self.tile_rect(slot).map(|r| Rectangle {
                x: r.x + 8.0,
                y: r.y + 8.0,
                width: self.camera_label(camera).chars().count() as f32 * 7.0 + 16.0,
                height: 24.0,
            });
            let dialog = self.dialog_rect();
            let under_glass = |r: Rectangle| glass.is_some_and(|g| g.rect.intersects(&r)) || dialog.is_some_and(|d| d.intersects(&r));
            let under_panel = label_rect.is_some_and(under_glass);
            let label = self.camera_label(camera);
            let mut labels = column![].spacing(4);
            if !label.is_empty() {
                labels = labels.push(container(text(label).size(11).font(bold(INTER))).padding([4, 8]).style(theme::tile_label));
            }
            if let Some(e) = self.player.slot_error(idx) {
                labels = labels.push(container(text(e).size(10).color(theme::ERROR)).padding([3, 8]).style(theme::tile_label));
            }
            // A stack takes its size from its first layer: fill the tile.
            let mut layers = stack![space().width(Length::Fill).height(Length::Fill)];
            if video.is_none() {
                layers = layers.push(
                    container(text(if self.player.has_media() && !self.camera_label(camera).is_empty() { i18n::t("app.noCamera") } else { "" }).size(12).color(theme::TEXT_MUTED)).center(Length::Fill),
                );
            }
            if !under_panel {
                layers = layers.push(container(labels).padding(8));
            }
            if let Some((rect, tile)) = dash_rect.filter(|(r, _)| !dialog.is_some_and(|d| d.intersects(r))) {
                // The compact dashboard: bottom of the front camera.
                let dash = dashboard::compact(self.dash((tile.width / 650.0).clamp(0.55, 1.0)));
                layers = layers.push(
                    container(dashboard::frame(dash).width(rect.width).height(rect.height))
                        .width(Length::Fill)
                        .height(Length::Fill)
                        .padding(Padding { bottom: tile.y + tile.height - (rect.y + rect.height), ..Padding::ZERO })
                        .align_x(Horizontal::Center)
                        .align_y(Vertical::Bottom),
                );
            }
            let badge_on = self.zoom_badge_until.is_some_and(|t| std::time::Instant::now() < t);
            if focused && self.zoom > 1.0 && badge_on {
                layers = layers.push(
                    container(container(text(format!("{:.1}x", self.zoom)).size(12).font(semibold(INTER))).padding([6, 12]).style(theme::zoom_badge))
                        .padding(12)
                        .width(Length::Fill)
                        .height(Length::Fill)
                        .align_x(Horizontal::Right)
                        .align_y(Vertical::Bottom),
                );
            }
            // The camera being moved (faded, with an accent outline) and
            // the slot where it would land.
            let dragging = self.camera_drag.map(|(from, at)| (from, self.slot_at(at)));
            if let Some((from, over)) = dragging {
                if from == slot {
                    layers = layers.push(container(space()).width(Length::Fill).height(Length::Fill).style(theme::drag_source));
                } else if over == Some(slot) {
                    layers = layers.push(container(space()).width(Length::Fill).height(Length::Fill).style(theme::drag_target));
                }
            }
            // The event camera highlight: a pulsing border and glow,
            // once a second, on the camera that triggered the event.
            let glow = self.glow().filter(|(c, _, _)| *c == camera).map(|(_, color, bright)| {
                let pulse = 0.5 - 0.5 * (self.epoch.elapsed().as_secs_f32() * std::f32::consts::TAU).cos();
                (color, bright, pulse)
            });
            if let Some((color, bright, pulse)) = glow {
                // The border (the outer glow is the tile's shadow, below).
                layers = layers.push(container(space()).width(Length::Fill).height(Length::Fill).style(theme::glow_border(color, bright, pulse)));
            }
            let m = video::MARGIN;
            let base: Element<'_, Message> = match glow {
                Some((color, _, pulse)) => container(space()).width(Length::Fill).height(Length::Fill).style(theme::tile_glow(color, pulse)).into(),
                None => container(space()).width(Length::Fill).height(Length::Fill).style(theme::tile).into(),
            };
            let mut cell = stack![container(base).padding(m)];
            if let Some(v) = video {
                cell = cell.push(v);
            }
            cell = cell.push(container(container(layers).width(Length::Fill).height(Length::Fill).clip(true)).padding(m));
            let tile = container(cell).width(Length::Fill).height(Length::Fill);
            let mut input = tile_input::tile_input(tile).on_click(Message::TileClick(slot));
            // Rearranging is for Tesla's layout (GM's is fixed).
            if self.focus.is_none() && !self.gm() {
                input = input.on_drag_to(move |p| Message::CameraDragTo(slot, p)).on_drop_at(move |p| Message::CameraDrop(slot, p));
            }
            if focused {
                input = input.on_wheel(Message::TileWheel).grab(self.zoom > 1.0);
                if self.zoom > 1.0 {
                    input = input.on_drag(Message::TilePan);
                }
            }
            input.into()
        };
        let grid: Element<'_, Message> = match self.focus {
            // Focused: the camera fills the whole grid area.
            Some(slot) => tile(slot),
            None => column![
                row![tile(0), tile(1), tile(2)].height(Length::Fill),
                row![tile(3), tile(4), tile(5)].height(Length::Fill),
            ]
            .height(Length::Fill)
            .into(),
        };
        sensor(grid).on_show(Message::GridSized).on_resize(Message::GridSized).into()
    }

    // ---------------------------------------------------------------------
    // Control bar
    // ---------------------------------------------------------------------

    fn controls(&self) -> Element<'_, Message> {
        let has_media = self.player.has_media();
        let skip_secs = self.settings.skip_seconds;
        let total = self.player.total().max(0.001);
        let position = self.scrub.unwrap_or_else(|| self.player.position()).min(total);

        let time = container(
            row![
                text(hms(position)).font(MONO).size(13),
                text("/").font(MONO).size(13).color(theme::TEXT_MUTED),
                // Not shown while the minutes' lengths are still coming in:
                // it would keep changing.
                text(if !has_media {
                    hms(0.0)
                } else if self.player.total_known() {
                    hms(total)
                } else {
                    "–:––".to_string()
                })
                .font(MONO)
                .size(13),
            ]
            .spacing(4),
        )
        .padding([6, 12])
        .style(theme::time_pill);

        let speed: Element<'_, Message> = if native_menu::AVAILABLE {
            glass(
                row![
                    text(Speed(self.player.rate()).to_string()).size(12).font(semibold(INTER)).width(30),
                    icon(theme::icon::EXPAND_MORE, 16.0),
                ]
                .spacing(4)
                .align_y(Alignment::Center),
                [5, 10],
                10.0,
            )
            .on_press(Message::SpeedMenu)
            .into()
        } else {
            pick_list(SPEEDS, Some(Speed(self.player.rate())), Message::Rate)
                .text_size(12)
                .padding([5, 10])
                .handle(theme::chevron_handle(16.0))
                .style(theme::select)
                .into()
        };

        // A glass button with the skip length in small type at the bottom right.
        let skip = |glyph: char, by: f64| {
            glass(
                stack![
                    container(icon(glyph, 20.0)).center(24),
                    container(text(format!("{}", skip_secs as u32)).size(9).font(bold(INTER)))
                        .width(28)
                        .height(28)
                        .align_x(Horizontal::Right)
                        .align_y(Vertical::Bottom),
                ],
                6,
                10.0,
            )
            .on_press_maybe(has_media.then_some(Message::Skip(by)))
        };
        let play = glass(
            container(icon(if self.player.is_playing() { theme::icon::PAUSE } else { theme::icon::PLAY }, 26.0)).center(28),
            [6, 8],
            12.0,
        )
        .on_press_maybe(has_media.then_some(Message::TogglePlay));
        let playback = row![skip(theme::icon::SKIP_BACK, -skip_secs), play, skip(theme::icon::SKIP_FORWARD, skip_secs)]
            .spacing(6)
            .align_y(Alignment::Center);

        let timeline: Element<'_, Message> = timeline::Timeline::new(total, position, Message::Seek)
            .on_release(Message::SeekDone)
            .markers(self.event_offset.filter(|_| has_media).into_iter().collect())
            .range(if has_media { self.export_markers() } else { (None, None) })
            .into();

        // Export: Start and End markers at the playhead, and the dialog
        // (with the progress on the button while an export runs).
        let marker = |label: &'static str, tip: Message| glass(text(label).size(11).font(semibold(INTER)), [7, 10], 10.0).on_press_maybe(has_media.then_some(tip));
        let export_face: Element<'_, Message> = match self.export.fraction() {
            Some(f) => text(format!("{}%", (f * 100.0).floor() as u32)).size(11).font(semibold(INTER)).color(theme::ACCENT).into(),
            None => svg_icon(export_view::DOWNLOAD_SVG, 18.0, theme::TEXT),
        };
        let export_open = has_media || self.export.running();
        let export_controls: Element<'_, Message> = if export::job::AVAILABLE {
            row![
                marker(i18n::t("ui.export.start"), Message::Export(export_view::ExportMsg::SetStart)),
                marker(i18n::t("ui.export.end"), Message::Export(export_view::ExportMsg::SetEnd)),
                glass(container(export_face).center(24), 6, 10.0).on_press_maybe(export_open.then_some(Message::Export(export_view::ExportMsg::Open))),
            ]
            .spacing(6)
            .align_y(Alignment::Center)
            .into()
        } else {
            space().width(0).into()
        };

        // Support chat and settings at the right end.
        let chat = glass(container(svg_icon(CHAT_SVG, 18.0, theme::TEXT)).center(24), 6, 10.0).on_press(Message::Chat(support_view::ChatMsg::Toggle));
        let gear = glass(container(icon(theme::icon::SETTINGS, 20.0)).center(24), 6, 10.0).on_press(Message::OpenSettings);
        let bar = container(
            row![time, speed, playback, timeline, export_controls, chat, gear]
                .spacing(14)
                .align_y(Alignment::Center),
        )
        .height(60)
        .padding([0, 20])
        .center_y(60)
        .width(Length::Fill)
        .style(theme::control_bar);
        column![
            container(space().height(1)).width(Length::Fill).style(theme::hairline),
            stack![bar, container(space().height(1)).width(Length::Fill).style(theme::inset_highlight)],
        ]
        .into()
    }
}

/// The keyboard modifiers held now, for mouse-button shortcuts.
static MODIFIERS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Keys and the extra mouse buttons, unless a widget already used them.
fn input_event(event: iced::Event, status: iced::event::Status, _window: iced::window::Id) -> Option<Message> {
    use iced::keyboard::{self, key, Key};
    // The window closing ends the app: the session ended cleanly.
    if let iced::Event::Window(iced::window::Event::CloseRequested | iced::window::Event::Closed) = event {
        applog::end();
    }
    if status == iced::event::Status::Captured {
        return None;
    }
    match event {
        iced::Event::Keyboard(keyboard::Event::KeyPressed { key: Key::Named(key::Named::Escape), .. }) => Some(Message::Escape),
        iced::Event::Keyboard(keyboard::Event::KeyPressed { physical_key: key::Physical::Code(code), modifiers, repeat, .. }) => {
            Some(Message::Input(shortcuts::key_identifier(code, modifiers), repeat))
        }
        iced::Event::Keyboard(keyboard::Event::ModifiersChanged(m)) => {
            MODIFIERS.store(m.bits(), std::sync::atomic::Ordering::Relaxed);
            None
        }
        iced::Event::Mouse(iced::mouse::Event::ButtonPressed(button)) => {
            let modifiers = keyboard::Modifiers::from_bits_truncate(MODIFIERS.load(std::sync::atomic::Ordering::Relaxed));
            shortcuts::mouse_identifier(button, modifiers).map(|id| Message::Input(id, false))
        }
        iced::Event::Window(iced::window::Event::FileHovered(_)) => Some(Message::FileHovered),
        iced::Event::Window(iced::window::Event::FilesHoveredLeft) => Some(Message::FileHoverLeft),
        iced::Event::Window(iced::window::Event::FileDropped(path)) => Some(Message::FileDropped(path)),
        _ => None,
    }
}

/// A dialog that reports its size, so the video under it is frosted.
pub(crate) fn measured<'a>(dialog: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    sensor(iced::widget::opaque(dialog)).on_show(Message::DialogSized).on_resize(Message::DialogSized).into()
}

fn placeholder<'a>(message: &'a str) -> Element<'a, Message> {
    container(text(message).size(12).color(theme::TEXT_MUTED).center())
        .padding(16)
        .center_x(Length::Fill)
        .into()
}

/// One card in the clip list. Event clips show a delete button while
/// the pointer is over them.
fn clip_card(item: &ClipItem, index: usize, selected: bool, hovered: bool) -> Element<'_, Message> {
    let (kind_label, kind_color) = match item.collection.kind {
        Kind::Recent => (i18n::t("ui.clipBrowser.recent"), theme::SUCCESS),
        Kind::Sentry => (i18n::t("ui.clipBrowser.sentry"), theme::ERROR),
        Kind::Saved => (i18n::t("ui.clipBrowser.saved"), theme::WARNING),
        Kind::Folder => (i18n::t("app.folder"), theme::ACCENT),
        Kind::Continuous => (i18n::t("app.continuous"), theme::SUCCESS),
    };
    let badge = |label: String, color| container(text(label).size(10)).padding([3, 7]).style(theme::badge(color));
    let mut badges = row![badge(kind_label.to_string(), kind_color)].spacing(6);
    if item.collection.kind == Kind::Saved {
        if let Some(reason) = &item.reason {
            let (label, alert) = library::reason_label(reason);
            badges = badges.push(badge(label, if alert { theme::ERROR } else { theme::WARNING }));
        }
    }
    let n = item.segments.len();
    let segments = if n == 1 { i18n::t("ui.clipBrowser.segment") } else { i18n::t("ui.clipBrowser.segments") };
    let sub = format!("{n} {segments} · {} {}", item.cameras.max(1), i18n::t("app.cam"));
    let body = container(
        column![
            text(item.collection.list_title()).size(12).font(bold(INTER)),
            badges,
            text(sub).size(11).color(theme::TEXT_SECONDARY),
        ]
        .spacing(7),
    )
    .padding(12)
    .width(Length::Fill);
    let mut layers = stack![body, rim(18.0)];
    if hovered && deletable_folder(item).is_some() {
        layers = layers.push(
            container(
                button(container(icon(theme::icon::DELETE, 18.0)).center(Length::Fill))
                    .width(28)
                    .height(28)
                    .padding(0)
                    .style(theme::clip_delete)
                    .on_press(Message::DeleteClip(index)),
            )
            .padding(Padding { right: 8.0, ..Padding::ZERO })
            .width(Length::Fill)
            .height(Length::Fill)
            .align_x(Horizontal::Right)
            .align_y(Vertical::Center),
        );
    }
    let card = button(layers).padding(0).width(Length::Fill).style(theme::clip_card(selected)).on_press(Message::SelectItem(index));
    mouse_area(card).on_enter(Message::ClipHover(Some(index))).on_exit(Message::ClipHover(None)).into()
}

/// The folder a card's delete button removes: only a Saved or Sentry event
/// folder (one event's clips), never a day of RecentClips or the root.
fn deletable_folder(item: &ClipItem) -> Option<PathBuf> {
    let dir = &item.collection.dir;
    let parent = dir.parent()?.file_name()?.to_str()?;
    let ok = matches!((item.collection.kind, parent), (Kind::Saved, "SavedClips") | (Kind::Sentry, "SentryClips"));
    (ok && dir.is_dir()).then(|| dir.clone())
}

/// Moves a folder to the Trash / Recycle Bin, or deletes it outright
/// where there is none (network shares).
fn delete_folder(dir: &std::path::Path) -> Result<(), (PathBuf, String)> {
    if !dir.is_dir() {
        return Err((dir.to_path_buf(), i18n::t("app.folderMissing").into()));
    }
    // A clip that was just playing may take a moment to let go of its
    // files (Windows locks open files), so the Trash is tried a few times.
    for attempt in 0..5 {
        if trash::delete(dir).is_ok() {
            return Ok(());
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    // No Trash here (a network share, say): deleted for good, as the dialog
    // warned.
    std::fs::remove_dir_all(dir).map_err(|e| (dir.to_path_buf(), e.to_string()))
}

/// The specular rim along the inside of a glass element's top edge, kept
/// clear of the rounded corners.
fn rim<'a, M: 'a>(radius: f32) -> Element<'a, M> {
    specular::specular(radius).into()
}

/// A liquid-glass button: the card material with a specular rim.
fn glass<'a>(
    content: impl Into<Element<'a, Message>>,
    padding: impl Into<Padding>,
    radius: f32,
) -> iced::widget::Button<'a, Message> {
    button(stack![container(content).padding(padding), rim(radius)])
        .padding(0)
        .style(theme::glass_button(radius))
}

/// The time display: 29:06, or 1:16:04 past an hour.
fn hms(t: f64) -> String {
    let s = t.max(0.0) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: Kind, dir: PathBuf) -> ClipItem {
        ClipItem {
            collection: Collection { kind, name: "x".into(), dir, date_filter: None },
            segments: Vec::new(),
            cameras: 6,
            reason: None,
            event_time: None,
            camera: None,
        }
    }

    #[test]
    fn only_event_folders_can_be_deleted() {
        let root = std::env::temp_dir().join(format!("sentry-studio-delete-test-{}", std::process::id()));
        let saved = root.join("SavedClips/2026-07-08_10-46-52");
        let sentry = root.join("SentryClips/2026-07-08_11-00-00");
        let recent = root.join("RecentClips/2026-07-08");
        for d in [&saved, &sentry, &recent] {
            std::fs::create_dir_all(d).unwrap();
        }
        assert_eq!(deletable_folder(&item(Kind::Saved, saved.clone())), Some(saved.clone()));
        assert_eq!(deletable_folder(&item(Kind::Sentry, sentry.clone())), Some(sentry.clone()));
        // A day of RecentClips, a mislabelled folder, the root: never.
        assert_eq!(deletable_folder(&item(Kind::Recent, recent.clone())), None);
        assert_eq!(deletable_folder(&item(Kind::Saved, sentry.clone())), None);
        assert_eq!(deletable_folder(&item(Kind::Saved, root.clone())), None);
        assert_eq!(deletable_folder(&item(Kind::Saved, root.join("SavedClips/missing"))), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
