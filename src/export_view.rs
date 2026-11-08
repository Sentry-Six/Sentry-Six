//! The export: Start and End markers set from the playhead, and the Export
//! Video dialog (cameras, quality, time-lapse), worded as in earlier
//! versions. The export runs on its own threads (see export::job); the
//! dialog can be closed meanwhile, and the Export button shows how far it
//! has got.

mod share_ui;
pub use share_ui::{ShareMsg, ShareUi};

use crate::export::encode::{Format, Support};
use crate::export::job::{self, Position, Quality, Tile};
use crate::export::overlay::{Corner, DashSize, DashStyle, Dashboard, MapTiles, Minimap, Timestamp, Watermark};

/// The minimap's corners, as earlier versions offered them.
const MAP_CORNERS: [Corner; 4] = [Corner::TopRight, Corner::TopLeft, Corner::BottomRight, Corner::BottomLeft];
use crate::i18n::{t, tf};
use crate::library::{Camera, GRID};
use crate::theme;
use crate::{measured, off_thread, off_thread_or, svg_icon, App, Message};
use iced::widget::{button, column, container, mouse_area, opaque, pick_list, row, space, stack, text, toggler, Column};
use iced::{Alignment, Background, Border, Color, Element, Length, Task};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DOWNLOAD_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>"#;
const CHECK_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>"#;

/// Time-lapse speeds, as earlier versions offered them (8x by default).
pub const SPEEDS: [f64; 7] = [0.5, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0];
/// Chevrons for the editor's folding cards.
const CHEVRON_DOWN_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>"#;
const CHEVRON_UP_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>"#;

/// A play triangle (the finished screen's play button).
/// The editor's video tiles use the player's slots plus this, so they
/// don't share the playback grid's (each slot has one place and picture).
const EDITOR_SLOTS: usize = 100;
const PLAY_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>"#;
const POLL: Duration = Duration::from_millis(250);
/// The preview's width in pixels (twice the dialog's, for sharp screens).
const PREVIEW_WIDTH: u32 = 1440;

/// The editor's sections, which fold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fold {
    Cameras = 1,
    Quality = 2,
    Overlays = 4,
    Privacy = 8,
    TimeLapse = 16,
    Share = 32,
}

/// What's being dragged in the preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dragged {
    Camera(Camera),
    Dashboard,
    Map,
    Watermark,
}

/// Where it was dropped: near one of its places (snapped there), or
/// anywhere else (its top-left, as shares of the frame).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DragTo {
    Corner(Corner),
    Free(f32, f32),
}

/// A drawn preview: the picture, its size, and the export's own size.
#[derive(Debug, Clone)]
pub struct Shown {
    pub handle: iced::widget::image::Handle,
    pub size: (u32, u32),
    pub full: (u32, u32),
    /// The frame without the movable pieces, and the pieces: shown while
    /// one is dragged, so it moves without the preview being drawn again.
    pub base: Option<iced::widget::image::Handle>,
    pub pieces: Vec<(Dragged, iced::widget::image::Handle)>,
}

impl Shown {
    fn from_preview(p: &job::Preview) -> Shown {
        let handle = |w: u32, h: u32, rgba: &[u8]| iced::widget::image::Handle::from_rgba(w, h, rgba.to_vec());
        Shown {
            handle: handle(p.shown.0, p.shown.1, &p.rgba),
            size: p.shown,
            full: (p.width, p.height),
            base: (!p.base.is_empty()).then(|| handle(p.shown.0, p.shown.1, &p.base)),
            pieces: p
                .pieces
                .iter()
                .map(|piece| {
                    let what = match piece.kind {
                        job::PieceKind::Camera(c) => Dragged::Camera(c),
                        job::PieceKind::Dashboard => Dragged::Dashboard,
                        job::PieceKind::Map => Dragged::Map,
                        job::PieceKind::Watermark => Dragged::Watermark,
                    };
                    (what, handle(piece.shown.0, piece.shown.1, &piece.rgba))
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum ExportMsg {
    SetStart,
    SetEnd,
    Open,
    Close,
    /// The footage's sizes (a side camera's, the front's), for the quality cards.
    Probed(Option<(u32, u32)>, Option<(u32, u32)>),
    Camera(Camera),
    Quality(Quality),
    Timelapse(bool),
    Speed(usize),
    Timestamp(bool),
    Corner(usize),
    Dashboard(bool),
    DashCorner(usize),
    DashStyle(usize),
    Bar(usize),
    ZoneCameraMenu,
    ZoneCamera(usize),
    AddZone,
    EditZone(usize),
    RemoveZone(usize),
    ZonePoints(Vec<(f32, f32)>),
    /// The corners of a zone being placed, so far.
    ZonePlacing(Vec<(f32, f32)>),
    SaveZone,
    CancelZone,
    RestoreZones,
    DismissRestore,
    Minimap(bool),
    MapCorner(usize),
    Watermark(bool),
    WatermarkCorner(usize),
    Format(Format),
    Formats([Support; 3]),
    Preview(Arc<Result<job::Preview, String>>),
    /// The camera's picture for the zone editor, at the preview's moment.
    ZoneSnapshot(Camera, Option<Box<crate::blur_editor::Snapshot>>),
    /// The dashboard or map dragged in the preview, and let go.
    Drag(Dragged, DragTo),
    /// Resized in the preview: its new share, and where it is now.
    Resize(Dragged, f64, DragTo),
    /// The cameras back in their grid.
    ResetLayout,
    /// The editor's playhead moved by this many seconds (the skip buttons).
    Skip(f64),
    /// Nothing (the live map in the editor isn't panned or zoomed).
    Nothing,
    DragDone,
    /// Sharing (see share_ui).
    Share(share_ui::ShareMsg),
    /// The editor: a section folded or opened, the timeline moved (and
    /// let go), the preview played or paused.
    Fold(Fold),
    Seek(f64),
    SeekDone,
    PlayPreview,
    Start,
    Picked(Option<PathBuf>),
    Poll(u64),
    Finished(u64, Result<job::Outcome, String>),
    Cancel,
    Reveal,
    /// Opens the finished video in the system's player.
    Play,
}

#[derive(Debug, Clone)]
pub enum State {
    Idle,
    /// The save dialog is up.
    Choosing,
    Running { id: u64, started: Instant, output: PathBuf },
    /// Finished: the file, its size, the video's length and format, and
    /// how long it took.
    Done { output: PathBuf, bytes: u64, length: f64, format: Format, quality: Quality },
    Failed(String),
}

/// A blur zone in the editor: its camera, corners, which zone it replaces
/// (None: a new one) and the camera's picture.
pub struct Editing {
    pub camera: Camera,
    pub points: Vec<(f32, f32)>,
    pub index: Option<usize>,
    pub snapshot: Option<crate::blur_editor::Snapshot>,
    /// A new zone being placed corner by corner (shares of the picture).
    pub placing: Vec<(f32, f32)>,
}

pub struct Export {
    pub open: bool,
    pub start: Option<Position>,
    pub end: Option<Position>,
    pub cameras: Vec<Camera>,
    pub quality: Quality,
    /// The format chosen, and what this computer can encode (None until
    /// looked up).
    pub format: Format,
    pub support: Option<[Support; 3]>,
    /// The preview: the frame as it will be exported (scaled down), and
    /// whether one is being drawn and another wanted after it.
    pub preview: Option<Result<Shown, String>>,
    pub preview_busy: bool,
    pub preview_again: bool,
    pub timelapse: bool,
    pub speed: f64,
    pub timestamp: bool,
    pub corner: Corner,
    pub dashboard: bool,
    pub dash_corner: Corner,
    /// The dashboard's size as a share (see Dashboard::share).
    pub dash_share: f64,
    pub dash_style: DashStyle,
    /// Tesla Mobile's data bar on top.
    pub bar_top: bool,
    pub minimap: bool,
    pub map_corner: Corner,
    /// The map's side as a share of the frame's shorter side.
    pub map_share: f64,
    /// The watermark's width as a share of the frame's.
    pub wm_share: f32,
    /// The dashboard (compact) and map dragged to a place of their own in
    /// the preview: top-left as shares of the frame.
    pub dash_free: Option<(f32, f32)>,
    pub map_free: Option<(f32, f32)>,
    /// Cameras moved or resized in the preview (see job::Tile::free), the
    /// last moved last (drawn over the others). Kept while the app runs.
    pub cam_free: Vec<(Camera, (f32, f32, f32))>,
    /// The Sentry Six watermark: on, its corner, or dragged somewhere.
    pub watermark: bool,
    pub wm_corner: Corner,
    pub wm_free: Option<(f32, f32)>,
    /// Sharing the finished export, and the list of shared clips.
    pub share: ShareUi,
    /// The editor's folded sections (bits of Fold).
    pub folded: u8,
    /// Where in the range the preview shows (playback seconds), and
    /// whether it's playing (the preview drawn again and again, moving on
    /// by the time each took).
    pub at: Option<f64>,
    pub playing: bool,
    pub preview_started: Option<Instant>,
    /// A piece is being dragged (the frame isn't drawn again meanwhile), or
    /// was let go and the exact render is on its way.
    pub dragging: bool,
    pub drag_wait: bool,
    /// Time left: when it was last estimated, and the seconds left then.
    /// It counts down between estimates, and each new one only nudges it,
    /// so it doesn't flicker as the frame rate wobbles.
    pub eta: Option<(Instant, f64)>,
    /// Blur zones (Privacy), the camera the next one goes on, the one
    /// being edited, and whether last time's zones are offered back.
    pub zones: Vec<crate::export::blur::BlurZone>,
    pub zone_camera: Camera,
    pub editing: Option<Editing>,
    pub restore_offer: bool,
    restore_answered: bool,
    pub state: State,
    /// Sizes of the footage, once read.
    pub side_size: Option<(u32, u32)>,
    pub front_size: Option<(u32, u32)>,
    /// Frames written, and the total once the export is planned (0 before).
    done: Arc<AtomicUsize>,
    total: Arc<AtomicUsize>,
    cancel: Arc<AtomicBool>,
    next_id: u64,
}

impl Default for Export {
    fn default() -> Self {
        Export {
            open: false,
            start: None,
            end: None,
            cameras: GRID.to_vec(),
            quality: Quality::High,
            format: Format::H264,
            support: None,
            preview: None,
            preview_busy: false,
            preview_again: false,
            timelapse: false,
            speed: 8.0,
            timestamp: true,
            corner: Corner::BottomCenter,
            dashboard: false,
            dash_corner: Corner::BottomCenter,
            dash_share: DashSize::Medium.share(),
            dash_style: DashStyle::Compact,
            bar_top: false,
            minimap: false,
            map_corner: Corner::TopRight,
            map_share: DashSize::Small.share(),
            wm_share: Watermark::SHARE,
            dash_free: None,
            cam_free: Vec::new(),
            map_free: None,
            watermark: true,
            wm_corner: Corner::BottomRight,
            wm_free: None,
            share: ShareUi::default(),
            folded: 0,
            at: None,
            playing: false,
            preview_started: None,
            dragging: false,
            drag_wait: false,
            eta: None,
            zones: Vec::new(),
            zone_camera: Camera::Back,
            editing: None,
            restore_offer: false,
            restore_answered: false,
            state: State::Idle,
            side_size: None,
            front_size: None,
            done: Arc::new(AtomicUsize::new(0)),
            total: Arc::new(AtomicUsize::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
            next_id: 1,
        }
    }
}

impl Export {
    /// Another collection was opened: its markers don't apply.
    pub fn clear_markers(&mut self) {
        self.start = None;
        self.end = None;
    }

    pub fn running(&self) -> bool {
        matches!(self.state, State::Running { .. } | State::Choosing)
    }

    /// 0..1 while an export runs.
    pub fn fraction(&self) -> Option<f32> {
        match &self.state {
            State::Running { .. } => Some(self.done.load(Ordering::Relaxed) as f32 / self.total.load(Ordering::Relaxed).max(1) as f32),
            _ => None,
        }
    }
}

pub fn wrap(m: ExportMsg) -> Message {
    Message::Export(m)
}

pub fn quality_key(q: Quality) -> &'static str {
    match q {
        Quality::Mobile => "mobile",
        Quality::Medium => "medium",
        Quality::High => "high",
        Quality::Max => "max",
    }
}

pub fn quality_from_key(k: &str) -> Option<Quality> {
    Some(match k {
        "mobile" => Quality::Mobile,
        "medium" => Quality::Medium,
        "high" => Quality::High,
        "max" => Quality::Max,
        _ => return None,
    })
}

fn quality_label(q: Quality) -> &'static str {
    match q {
        Quality::Mobile => t("ui.export.mobile"),
        Quality::Medium => t("ui.export.medium"),
        Quality::High => t("ui.export.high"),
        Quality::Max => t("ui.export.maximum"),
    }
}

/// "1:05" or "1:02:05".
/// The next time-left estimate. The raw one (frames left at the average
/// rate so far) wobbles from poll to poll; the shown one counts down by
/// itself and moves a tenth of the way to the raw one each poll, and only
/// goes up for a real slowdown (more than 3 s).
fn next_eta(prev: Option<(Instant, f64)>, elapsed: f64, done: usize, total: usize) -> Option<(Instant, f64)> {
    if total == 0 || done < 10 || elapsed < 1.0 {
        return prev;
    }
    let raw = elapsed / done as f64 * total.saturating_sub(done) as f64;
    let now = Instant::now();
    let Some((at, secs)) = prev else { return Some((now, raw)) };
    let counted = secs - now.duration_since(at).as_secs_f64();
    let nudged = counted + (raw - counted) * 0.1;
    let next = if nudged > counted && nudged - counted < 3.0 { counted } else { nudged };
    Some((now, next.max(0.0)))
}

/// See `export_filename`. `when` is "YYYY-MM-DD HH:MM:SS".
fn file_name(what: Option<&str>, when: Option<&str>) -> String {
    // Characters no system allows in a file name, and control characters.
    let clean = |s: &str| -> String {
        let s: String = s.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c }).collect();
        s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect()
    };
    let mut name = String::from("Tesla");
    if let Some(w) = what.map(clean).filter(|w| !w.is_empty()) {
        name = format!("{name} {w}");
    }
    if let Some(t) = when.filter(|t| t.len() >= 19) {
        name = format!("{name} {} {}", &t[..10], t[11..19].replace(':', "-"));
    }
    format!("{name}.mp4")
}

fn clock(secs: f64) -> String {
    let s = secs.max(0.0).round() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// The message for an export error, in earlier versions' words where one fits.
fn failure_text(e: &str) -> String {
    let l = e.to_lowercase();
    let key = if l.contains("no space") || l.contains("disk full") || l.contains("os error 28") {
        "ui.export.exportFailedNoSpace"
    } else if l.contains("permission denied") || l.contains("os error 13") || l.contains("not permitted") {
        "ui.export.exportFailedPermission"
    } else if l.contains("read-only") || l.contains("os error 30") {
        "ui.export.exportFailedReadOnly"
    } else if l.contains("no such file") || l.contains("os error 2") {
        "ui.export.exportFailedPathNotFound"
    } else {
        return tf("ui.notifications.exportFailedWithError", &[("error", e)]);
    };
    t(key).to_string()
}

impl App {
    /// Timeline position (seconds) of a marker.
    fn marker_secs(&self, p: Option<Position>) -> Option<f64> {
        p.filter(|p| p.segment < self.player.segments().len()).map(|p| self.player.position_at(p.segment, p.secs))
    }

    /// The export markers on the timeline: start and end.
    pub(crate) fn export_markers(&self) -> (Option<f64>, Option<f64>) {
        (self.marker_secs(self.export.start), self.marker_secs(self.export.end))
    }

    /// The range to export: the markers, or the whole collection.
    fn export_range(&self) -> Option<(Position, Position)> {
        let segments = self.player.segments();
        if segments.is_empty() {
            return None;
        }
        let first = Position { segment: 0, secs: 0.0 };
        let last_seg = segments.len() - 1;
        let last = Position { segment: last_seg, secs: self.player.position_at(last_seg + 1, 0.0) - self.player.position_at(last_seg, 0.0) };
        let (mut a, mut b) = (self.export.start.unwrap_or(first), self.export.end.unwrap_or(last));
        let (sa, sb) = (self.player.position_at(a.segment, a.secs), self.player.position_at(b.segment, b.secs));
        if sb < sa {
            std::mem::swap(&mut a, &mut b);
        }
        Some((a, b))
    }

    fn range_secs(&self) -> f64 {
        self.export_range().map(|(a, b)| self.player.position_at(b.segment, b.secs) - self.player.position_at(a.segment, a.secs)).unwrap_or(0.0)
    }

    /// The cameras this collection has footage from (no pillars on HW3).
    fn available_cameras(&self) -> Vec<Camera> {
        let mut seen: Vec<Camera> = self.player.segments().iter().flat_map(|s| s.files.keys().copied()).collect();
        seen.sort();
        seen.dedup();
        seen
    }

    /// The chosen cameras that have footage here.
    /// The chosen cameras' tiles: in their grid, or where they were moved
    /// in the preview (drawn after the others, the last moved last).
    fn export_tiles(&self) -> Vec<Tile> {
        let chosen = self.export_cameras();
        let order: Vec<Camera> = self.settings.camera_order.iter().copied().filter(|c| chosen.contains(c)).collect();
        let mut tiles = job::grid(&order);
        for t in &mut tiles {
            t.free = self.export.cam_free.iter().find(|(c, _)| *c == t.camera).map(|(_, f)| *f);
        }
        let rank = |t: &Tile| self.export.cam_free.iter().position(|(c, _)| *c == t.camera).map_or(0, |i| i + 1);
        tiles.sort_by_key(rank);
        tiles
    }

    fn export_cameras(&self) -> Vec<Camera> {
        let available = self.available_cameras();
        self.export.cameras.iter().copied().filter(|c| available.contains(c)).collect()
    }

    fn here(&self) -> Position {
        let t = self.scrub.unwrap_or_else(|| self.player.position());
        let (segment, secs) = self.player.locate_at(t);
        Position { segment, secs }
    }

    fn export_poll_later(&self, id: u64) -> Task<Message> {
        Task::perform(off_thread(move || std::thread::sleep(POLL)), move |_| wrap(ExportMsg::Poll(id)))
    }

    /// The export as the dialog has it set up, to `output`.
    fn export_request(&self, start: Position, end: Position, output: PathBuf) -> Option<job::Request> {
        // Cameras keep playback's layout: their slots in the 3x2
        // grid, packed into Electron's grid shape.
        let tiles = self.export_tiles();
        Some(job::Request {
            segments: self.player.segments().to_vec(),
            start,
            end,
            tiles,
            quality: self.export.quality,
            format: Some(self.export_format()),
            speed: if self.export.timelapse { self.export.speed } else { 1.0 },
            mirror: self.settings.mirror_cameras,
            fast: true,
            // Earlier versions never burned in both: the dashboard shows the time.
            timestamp: self.export_timestamp(),
            dashboard: self.export_dashboard(),
            minimap: self.export_minimap(),
            watermark: self.export_watermark(),
            blur_zones: self.export.zones.clone(),
            output: output.clone(),
        })
    }

    /// The burned-in time as set up (earlier versions never burned in both:
    /// the dashboard shows the time).
    fn export_timestamp(&self) -> Option<Timestamp> {
        (self.export.timestamp && !self.export.dashboard).then_some(Timestamp { corner: self.export.corner, date_format: self.settings.date_format, h24: self.settings.time_24h })
    }

    /// The dashboard as set up (None when it's off).
    fn export_dashboard(&self) -> Option<Dashboard> {
        let e = &self.export;
        e.dashboard.then_some(Dashboard {
            style: e.dash_style,
            corner: match e.dash_style {
                DashStyle::TeslaMobile if e.bar_top => Corner::TopCenter,
                DashStyle::TeslaMobile => Corner::BottomCenter,
                DashStyle::Compact => e.dash_corner,
            },
            share: e.dash_share,
            metric: self.settings.metric,
            h24: self.settings.time_24h,
            accel: self.settings.accel_mode,
            glass: self.settings.glass_blur,
            free: e.dash_free.filter(|_| e.dash_style == DashStyle::Compact),
        })
    }

    /// The watermark as set up (None when it's off).
    fn export_watermark(&self) -> Option<Watermark> {
        let e = &self.export;
        e.watermark.then_some(Watermark { corner: e.wm_corner, free: e.wm_free, share: e.wm_share })
    }

    /// The minimap as set up (None when it's off).
    fn export_minimap(&self) -> Option<Minimap> {
        let e = &self.export;
        e.minimap.then(|| Minimap {
            corner: e.map_corner,
            share: e.map_share,
            dark: self.settings.map_dark,
            tiles: MapTiles(self.tiles.clone()),
            // Only the Live Map: it follows the car.
            live: true,
            free: e.map_free,
        })
    }

    /// The range in playback seconds (start, end).
    fn export_range_secs(&self) -> Option<(f64, f64)> {
        self.export_range().map(|(a, b)| (self.player.position_at(a.segment, a.secs), self.player.position_at(b.segment, b.secs)))
    }

    /// Where the preview is drawn: the playhead when it's inside the range,
    /// else the range's start.
    fn preview_at(&self, start: Position, end: Position) -> Position {
        // The editor's timeline, else the playhead.
        let here = match self.export.at {
            Some(t) => {
                let (segment, secs) = self.player.locate_at(t);
                Position { segment, secs }
            }
            None => self.here(),
        };
        let key = |p: &Position| (p.segment, p.secs);
        if key(&here) >= key(&start) && key(&here) <= key(&end) {
            here
        } else {
            start
        }
    }

    /// Draws the preview again (one at a time: a change while one is being
    /// drawn asks for another when it's done).
    fn refresh_preview(&mut self) -> Task<Message> {
        if !self.export.open || self.export.running() || self.export.editing.is_some() {
            return Task::none();
        }
        if self.export.preview_busy {
            self.export.preview_again = true;
            return Task::none();
        }
        let Some((start, end)) = self.export_range() else { return Task::none() };
        let Some(request) = self.export_request(start, end, PathBuf::new()) else { return Task::none() };
        if request.tiles.is_empty() {
            self.export.preview = None;
            return Task::none();
        }
        let at = self.preview_at(start, end);
        // With the pieces: dragging needs them, and so does playing (the
        // overlays over the live video).
        let with_pieces = true;
        self.export.preview_busy = true;
        self.export.preview_started = Some(Instant::now());
        self.export.preview_again = false;
        Task::perform(
            off_thread_or(Err("The preview stopped unexpectedly.".to_string()), move || job::preview(&request, at, PREVIEW_WIDTH, with_pieces).map_err(|e| format!("{e:#}"))),
            |r| wrap(ExportMsg::Preview(Arc::new(r))),
        )
    }

    /// The export's size at quality `q` with the cameras chosen (Tesla
    /// Mobile's bars included): its longer side.
    fn export_widest(&self, q: Quality) -> u32 {
        let (w, h) = self.export_size(q);
        w.max(h)
    }

    /// The export's width and height at quality `q` with the cameras chosen
    /// (Tesla Mobile's bars included).
    fn export_size(&self, q: Quality) -> (u32, u32) {
        let chosen = self.export_cameras();
        let multi = !(chosen.len() == 1 && chosen[0] == Camera::Front);
        let e = &self.export;
        let base = if multi { e.side_size.or(e.front_size).unwrap_or((1448, 938)) } else { e.front_size.unwrap_or((2896, 1876)) };
        let order: Vec<Camera> = self.settings.camera_order.iter().copied().filter(|c| chosen.contains(c)).collect();
        let tiles = job::grid(&order);
        let (cw, ch) = job::cell_size(base, q, !multi);
        let cols = tiles.iter().map(|t| t.col + 1).max().unwrap_or(1);
        let rows = tiles.iter().map(|t| t.row + 1).max().unwrap_or(1);
        let width = cw * cols;
        let mut height = ch * rows;
        if e.dashboard && e.dash_style == DashStyle::TeslaMobile {
            let (date, data) = crate::export::tesla_mobile::bar_heights(width);
            height += date + data;
        }
        (width, height)
    }

    /// How this computer encodes `f` (before it's been looked up: H.264
    /// and HEVC are taken to work, AV1 not).
    fn format_support(&self, f: Format) -> Support {
        match self.export.support {
            Some(found) => found[Format::ALL.iter().position(|x| *x == f).unwrap_or(0)],
            None if f == Format::Av1 => Support::No,
            None => Support::Hardware,
        }
    }

    /// Whether `f` can write quality `q` here.
    fn format_fits(&self, f: Format, q: Quality) -> bool {
        self.format_support(f) != Support::No && self.export_widest(q) <= f.max_side()
    }

    /// The format used: the one chosen, or, when it can't take this size
    /// (H.264 past 4096) or this computer has no encoder for it, the
    /// first one that can.
    pub(crate) fn export_format(&self) -> Format {
        let (f, q) = (self.export.format, self.export.quality);
        if self.format_fits(f, q) {
            return f;
        }
        Format::ALL.into_iter().find(|x| self.format_fits(*x, q)).unwrap_or(Format::Hevc)
    }

    /// "Tesla 2026-11-07 08-23-55.mp4": the footage's own date and time
    /// at the start of the range, to the second (several short exports from
    /// one minute don't collide), with "Sentry", "Saved" or the folder's
    /// name for those. In English whatever the language, so it reads the
    /// same everywhere (earlier versions' "tesla_Recent_Clips_..." turned
    /// other languages' titles into underscores).
    fn export_filename(&self, start: Position) -> String {
        let collection = self.selected.and_then(|i| self.items.get(i)).map(|i| &i.collection);
        let what = match collection.map(|c| (c.kind, c.name.as_str())) {
            Some((crate::library::Kind::Sentry, _)) => Some("Sentry".to_string()),
            Some((crate::library::Kind::Saved, _)) => Some("Saved".to_string()),
            Some((crate::library::Kind::Folder, name)) => Some(name.to_string()),
            _ => None,
        };
        let when = self.player.segments().get(start.segment).map(|s| s.start + start.secs.floor() as i64);
        file_name(what.as_deref(), when.map(crate::library::format_local).as_deref())
    }

    pub(crate) fn export_update(&mut self, m: ExportMsg) -> Task<Message> {
        // What changes the picture draws the preview again.
        let redraw = matches!(
            m,
            ExportMsg::Probed(..)
                | ExportMsg::Camera(_)
                | ExportMsg::Quality(_)
                | ExportMsg::Timestamp(_)
                | ExportMsg::Corner(_)
                | ExportMsg::Dashboard(_)
                | ExportMsg::DashStyle(_)
                | ExportMsg::DashCorner(_)
                | ExportMsg::Bar(_)
                | ExportMsg::Minimap(_)
                | ExportMsg::MapCorner(_)
                | ExportMsg::DragDone
                | ExportMsg::ResetLayout
                | ExportMsg::Seek(_)
                | ExportMsg::Skip(_)
                | ExportMsg::Watermark(_)
                | ExportMsg::WatermarkCorner(_)
                | ExportMsg::SaveZone
                | ExportMsg::RemoveZone(_)
                | ExportMsg::RestoreZones
        );
        let redraw = redraw && !(self.export.playing && matches!(m, ExportMsg::Seek(_) | ExportMsg::SeekDone | ExportMsg::Skip(_)));
        let task = self.export_step(m);
        if redraw {
            Task::batch([task, self.refresh_preview()])
        } else {
            task
        }
    }

    /// Whether the editor takes the playback keys (play/pause, skip): open
    /// on its settings, not on a finished export or the zone editor.
    pub(crate) fn editor_has_keys(&self) -> bool {
        self.export.open && self.export.editing.is_none() && !matches!(self.export.state, State::Done { .. })
    }

    /// Every frame: while the editor plays, its playhead follows the
    /// video, and it stops at the range's end.
    pub(crate) fn export_tick(&mut self) -> Task<Message> {
        if !self.export.playing {
            return Task::none();
        }
        let Some((a, b)) = self.export_range_secs() else { return Task::none() };
        let t = self.player.position();
        // Outside the range: the jump to its start hasn't happened yet.
        if t < a - 0.5 || t > b + 1.0 {
            return Task::none();
        }
        if t >= b - 0.02 || !self.player.is_playing() || !self.export.open {
            self.export.playing = false;
            self.player.set_playing(false);
            self.export.at = Some(t.clamp(a, b));
            return self.refresh_preview();
        }
        self.export.at = Some(t.max(a));
        Task::none()
    }

    fn export_step(&mut self, m: ExportMsg) -> Task<Message> {
        match m {
            ExportMsg::Share(m) => return self.share_step(m),
            ExportMsg::Preview(result) => {
                self.export.preview_busy = false;
                // The exact render after a drag: the pieces give way to it.
                if self.export.drag_wait && !self.export.preview_again {
                    self.export.drag_wait = false;
                    self.export.dragging = false;
                }
                self.export.preview = Some(match result.as_ref() {
                    Ok(p) => Ok(Shown::from_preview(p)),
                    Err(e) => Err(e.clone()),
                });
                if self.export.preview_again {
                    return self.refresh_preview();
                }
            }
            ExportMsg::Fold(f) => self.export.folded ^= f as u8,
            ExportMsg::Seek(t) => {
                self.export.at = Some(t);
                if self.export.playing {
                    self.player.seek(t);
                }
            }
            ExportMsg::Skip(d) => {
                if let Some((a, b)) = self.export_range_secs() {
                    let from = if self.export.playing { self.player.position() } else { self.export.at.unwrap_or(a) };
                    let t = (from + d).clamp(a, b);
                    self.export.at = Some(t);
                    if self.export.playing {
                        self.player.seek(t);
                    }
                }
            }
            ExportMsg::SeekDone => {}
            ExportMsg::PlayPreview => {
                let Some((a, b)) = self.export_range_secs() else { return Task::none() };
                self.export.playing = !self.export.playing;
                if self.export.playing {
                    // The real video, played by playback's decoders, laid
                    // out as the export (see preview_block).
                    if self.export.at.is_none_or(|t| t >= b - 0.05 || t < a) {
                        self.export.at = Some(a);
                    }
                    self.player.seek(self.export.at.unwrap_or(a));
                    self.player.set_playing(true);
                    return Task::none();
                }
                self.player.set_playing(false);
                self.export.at = Some(self.player.position().clamp(a, b));
                // Paused: the export's own frame here, with what dragging needs.
                return self.refresh_preview();
            }
            ExportMsg::SetStart | ExportMsg::SetEnd => {
                if !self.player.has_media() {
                    return Task::none();
                }
                let here = self.here();
                let start = matches!(m, ExportMsg::SetStart);
                if start {
                    self.export.start = Some(here);
                } else {
                    self.export.end = Some(here);
                }
                return self.notify(t(if start { "ui.notifications.startMarkerSet" } else { "ui.notifications.endMarkerSet" }).to_string(), false);
            }
            ExportMsg::Open => {
                if !self.player.has_media() && !self.export.running() {
                    return Task::none();
                }
                self.export.open = true;
                self.export.at = None;
                self.export.playing = false;
                // The editor plays the video itself (with playback's decoders).
                self.player.set_playing(false);
                if matches!(self.export.state, State::Done { .. } | State::Failed(_)) {
                    self.export.state = State::Idle;
                }
                if !self.export.running() {
                    if let Some(q) = quality_from_key(&self.settings.export_quality) {
                        self.export.quality = q;
                    }
                    self.export.format = Format::from_key(&self.settings.export_format).unwrap_or(Format::H264);
                    self.export.timestamp = self.settings.export_timestamp;
                    self.export.dashboard = self.settings.export_dashboard;
                    self.export.dash_corner = Corner::from_key(&self.settings.export_dash_position).unwrap_or(Corner::BottomCenter);
                    self.export.dash_share = self.settings.export_dash_scale.unwrap_or_else(|| DashSize::from_key(&self.settings.export_dash_size).unwrap_or(DashSize::Medium).share());
                    // Last time's blur zones, offered once a session.
                    self.export.restore_offer = self.export.zones.is_empty() && !self.settings.export_blur_zones.is_empty() && !self.export.restore_answered;
                    self.export.dash_style = DashStyle::from_key(&self.settings.export_dash_style).unwrap_or(DashStyle::Compact);
                    self.export.bar_top = self.settings.export_dash_tm_top;
                    self.export.minimap = self.settings.export_minimap;
                    self.export.map_corner = Corner::from_key(&self.settings.export_minimap_position).filter(|c| MAP_CORNERS.contains(c)).unwrap_or(Corner::TopRight);
                    self.export.map_share = self.settings.export_map_scale.unwrap_or_else(|| DashSize::from_key(&self.settings.export_minimap_size).unwrap_or(DashSize::Small).share());
                    self.export.wm_share = self.settings.export_watermark_scale.map_or(Watermark::SHARE, |x| x as f32);
                    self.export.dash_free = self.settings.export_dash_free;
                    self.export.watermark = self.settings.export_watermark;
                    self.export.wm_corner = Corner::from_key(&self.settings.export_watermark_position).unwrap_or(Corner::BottomRight);
                    self.export.wm_free = self.settings.export_watermark_free;
                    self.export.map_free = self.settings.export_map_free;
                    self.export.timelapse = self.settings.export_timelapse;
                    self.export.speed = self.settings.export_speed;
                }
                // The footage's sizes, for the quality cards (index reads:
                // off the UI thread, they can wait on a network share).
                let segments = self.player.segments().to_vec();
                let first = |front: bool| {
                    segments.iter().find_map(|s| s.files.iter().find(|(c, _)| (**c == Camera::Front) == front).map(|(_, p)| p.clone()))
                };
                let (side, front) = (first(false), first(true));
                let size = |p: Option<PathBuf>| p.and_then(|p| std::fs::File::open(p).ok()).and_then(|f| crate::mp4::read_video_track(&f).ok()).map(|t| (t.width, t.height));
                let sizes = Task::perform(off_thread_or((None, None), move || (size(side), size(front))), |(a, b)| wrap(ExportMsg::Probed(a, b)));
                // What this computer encodes (starts an encoder of each
                // kind the first time).
                if self.export.support.is_none() {
                    let formats = Task::perform(off_thread_or([Support::Hardware, Support::No, Support::No], || Format::ALL.map(crate::export::encode::support)), |s| wrap(ExportMsg::Formats(s)));
                    return Task::batch([sizes, formats]);
                }
                return sizes;
            }
            ExportMsg::Format(f) => {
                if !self.export.running() {
                    self.export.format = f;
                }
            }
            ExportMsg::Formats(found) => self.export.support = Some(found),
            ExportMsg::Probed(side, front) => {
                self.export.side_size = side;
                self.export.front_size = front;
            }
            ExportMsg::Close if self.export.editing.is_some() => self.export.editing = None,
            ExportMsg::Close => {
                // Not while a share uploads (its Cancel stops it first).
                if !matches!(self.export.state, State::Choosing) && !self.export.share.uploading() {
                    self.export.open = false;
                    self.export.share.list_open = false;
                }
            }
            ExportMsg::Camera(c) => {
                if self.export.running() {
                    return Task::none();
                }
                let shape = |tiles: &[Tile]| (tiles.iter().map(|t| t.col).max(), tiles.iter().map(|t| t.row).max());
                let before = shape(&self.export_tiles());
                if let Some(i) = self.export.cameras.iter().position(|x| *x == c) {
                    self.export.cameras.remove(i);
                } else {
                    self.export.cameras.push(c);
                }
                // Moved cameras stay put while the frame keeps its shape.
                let chosen = self.export_cameras();
                self.export.cam_free.retain(|(c, _)| chosen.contains(c));
                if shape(&self.export_tiles()) != before {
                    self.export.cam_free.clear();
                }
            }
            ExportMsg::Quality(q) => {
                if !self.export.running() {
                    self.export.quality = q;
                }
            }
            ExportMsg::Timelapse(on) => {
                if !self.export.running() {
                    self.export.timelapse = on;
                }
            }
            ExportMsg::Speed(i) => {
                if let Some(s) = SPEEDS.get(i).filter(|_| !self.export.running()) {
                    self.export.speed = *s;
                }
            }
            ExportMsg::Timestamp(on) => {
                if !self.export.running() {
                    self.export.timestamp = on;
                }
            }
            ExportMsg::Corner(i) => {
                if let Some(c) = Corner::ALL.get(i).filter(|_| !self.export.running()) {
                    self.export.corner = *c;
                }
            }
            ExportMsg::Dashboard(on) => {
                if !self.export.running() {
                    self.export.dashboard = on;
                }
            }
            ExportMsg::DashCorner(i) => {
                if let Some(c) = Corner::ALL.get(i).filter(|_| !self.export.running()) {
                    self.export.dash_corner = *c;
                    self.export.dash_free = None;
                }
            }
            ExportMsg::ZoneCameraMenu => {
                let cams = self.available_cameras();
                let items: Vec<String> = cams.iter().map(|c| c.label().to_string()).collect();
                let current = cams.iter().position(|c| *c == self.export.zone_camera);
                if let Some(i) = crate::native_menu::popup(&items, current) {
                    return self.export_update(ExportMsg::ZoneCamera(i));
                }
            }
            ExportMsg::ZoneCamera(i) => {
                if let Some(c) = self.available_cameras().get(i) {
                    self.export.zone_camera = *c;
                }
            }
            ExportMsg::AddZone | ExportMsg::EditZone(_) => {
                if self.export.running() {
                    return Task::none();
                }
                let (camera, points, index) = match m {
                    ExportMsg::EditZone(i) => match self.export.zones.get(i) {
                        Some(z) => (z.camera, z.points.clone(), Some(i)),
                        None => return Task::none(),
                    },
                    _ => {
                        let camera = self.export.zone_camera;
                        (camera, crate::export::blur::BlurZone::starting(camera).points, None)
                    }
                };
                // The camera's picture at the preview's moment (decoded on
                // a thread), mirrored as shown; until it comes, the one on
                // screen.
                let mirror = self.settings.mirror_cameras && camera.mirrored();
                let shown = GRID.iter().position(|c| *c == camera).and_then(|slot| self.player.shown(slot)).and_then(|s| crate::blur_editor::snapshot(&s.frame, mirror));
                self.export.editing = Some(Editing { camera, points, index, snapshot: shown, placing: Vec::new() });
                let Some((start, end)) = self.export_range() else { return Task::none() };
                let at = self.preview_at(start, end);
                let segments = self.player.segments().to_vec();
                return Task::perform(
                    off_thread_or(None, move || {
                        let frame = crate::export::source::Source::new(camera).frame_at(&segments, at.segment, at.secs)?;
                        crate::blur_editor::snapshot(&frame, mirror)
                    }),
                    move |snap| wrap(ExportMsg::ZoneSnapshot(camera, snap.map(Box::new))),
                );
            }
            ExportMsg::ZoneSnapshot(camera, snap) => {
                if let (Some(e), Some(snap)) = (self.export.editing.as_mut(), snap) {
                    if e.camera == camera {
                        e.snapshot = Some(*snap);
                    }
                }
            }
            ExportMsg::ZonePoints(points) => {
                if let Some(e) = self.export.editing.as_mut() {
                    e.points = points;
                    e.placing.clear();
                }
            }
            ExportMsg::ZonePlacing(points) => {
                if let Some(e) = self.export.editing.as_mut() {
                    e.placing = points;
                }
            }
            ExportMsg::SaveZone => {
                if let Some(e) = self.export.editing.take() {
                    let zone = crate::export::blur::BlurZone { camera: e.camera, points: e.points };
                    match e.index {
                        Some(i) if i < self.export.zones.len() => self.export.zones[i] = zone,
                        _ => self.export.zones.push(zone),
                    }
                    self.export.restore_offer = false;
                }
            }
            ExportMsg::CancelZone => self.export.editing = None,
            ExportMsg::RemoveZone(i) => {
                if i < self.export.zones.len() && !self.export.running() {
                    self.export.zones.remove(i);
                }
            }
            ExportMsg::RestoreZones => {
                self.export.zones = self.settings.export_blur_zones.clone();
                self.export.restore_offer = false;
                self.export.restore_answered = true;
                return self.notify(t("ui.export.restoreBannerRestored").to_string(), false);
            }
            ExportMsg::DismissRestore => {
                self.export.restore_offer = false;
                self.export.restore_answered = true;
            }
            ExportMsg::Minimap(on) => {
                if !self.export.running() {
                    self.export.minimap = on;
                }
            }
            ExportMsg::MapCorner(i) => {
                if let Some(c) = MAP_CORNERS.get(i).filter(|_| !self.export.running()) {
                    self.export.map_corner = *c;
                    self.export.map_free = None;
                }
            }
            ExportMsg::Watermark(on) => {
                if !self.export.running() {
                    self.export.watermark = on;
                }
            }
            ExportMsg::WatermarkCorner(i) => {
                if let Some(c) = Corner::ALL.get(i).filter(|_| !self.export.running()) {
                    self.export.wm_corner = *c;
                    self.export.wm_free = None;
                }
            }
            ExportMsg::DragDone => {
                self.export.drag_wait = true;
            }
            ExportMsg::Drag(what, to) => {
                if self.export.running() {
                    return Task::none();
                }
                self.export.dragging = true;
                match (what, to) {
                    (Dragged::Camera(_), _) => {}
                    (Dragged::Dashboard, DragTo::Corner(c)) => {
                        self.export.dash_corner = c;
                        self.export.dash_free = None;
                    }
                    (Dragged::Dashboard, DragTo::Free(x, y)) => self.export.dash_free = Some((x, y)),
                    (Dragged::Map, DragTo::Corner(c)) => {
                        self.export.map_corner = c;
                        self.export.map_free = None;
                    }
                    (Dragged::Map, DragTo::Free(x, y)) => self.export.map_free = Some((x, y)),
                    (Dragged::Watermark, DragTo::Corner(c)) => {
                        self.export.wm_corner = c;
                        self.export.wm_free = None;
                    }
                    (Dragged::Watermark, DragTo::Free(x, y)) => self.export.wm_free = Some((x, y)),
                }
            }
            ExportMsg::ResetLayout => self.export.cam_free.clear(),
            ExportMsg::Nothing => {}
            ExportMsg::Resize(what, share, to) => {
                if self.export.running() {
                    return Task::none();
                }
                if let (Dragged::Camera(c), DragTo::Free(x, y)) = (what, to) {
                    self.export.dragging = true;
                    self.export.cam_free.retain(|(k, _)| *k != c);
                    self.export.cam_free.push((c, (x, y, share as f32)));
                    return Task::none();
                }
                match what {
                    Dragged::Camera(_) => {}
                    Dragged::Dashboard => self.export.dash_share = share,
                    Dragged::Map => self.export.map_share = share,
                    Dragged::Watermark => self.export.wm_share = share as f32,
                }
                return self.export_step(ExportMsg::Drag(what, to));
            }
            ExportMsg::DashStyle(i) => {
                if let Some(d) = DashStyle::ALL.get(i).filter(|_| !self.export.running()) {
                    self.export.dash_style = *d;
                }
            }
            ExportMsg::Bar(i) => {
                if !self.export.running() {
                    self.export.bar_top = i == 1;
                }
            }
            ExportMsg::Start => {
                if self.export.running() || self.export_cameras().is_empty() {
                    return Task::none();
                }
                let Some((start, _)) = self.export_range() else { return Task::none() };
                if self.range_secs() < 0.1 {
                    return self.notify(t("ui.export.exportRangeTooShort").to_string(), true);
                }
                self.export.state = State::Choosing;
                let mut dialog = rfd::AsyncFileDialog::new().set_title("Save Tesla Export").set_file_name(self.export_filename(start)).add_filter("MP4", &["mp4"]);
                if let Some(dir) = self.settings.last_export_folder.as_ref().filter(|d| d.is_dir()) {
                    dialog = dialog.set_directory(dir);
                }
                return Task::perform(async move { dialog.save_file().await.map(|f| f.path().to_path_buf()) }, |p| wrap(ExportMsg::Picked(p)));
            }
            ExportMsg::Picked(None) => {
                self.export.state = State::Idle;
                return self.notify(t("ui.notifications.exportCancelled").to_string(), false);
            }
            ExportMsg::Picked(Some(mut output)) => {
                if output.extension().is_none() {
                    output.set_extension("mp4");
                }
                let Some((start, end)) = self.export_range() else {
                    self.export.state = State::Idle;
                    return Task::none();
                };
                if let Some(dir) = output.parent() {
                    self.settings.last_export_folder = Some(dir.to_path_buf());
                }
                self.settings.export_quality = quality_key(self.export.quality).to_string();
                self.settings.export_format = self.export.format.key().to_string();
                self.settings.export_timestamp = self.export.timestamp;
                self.settings.export_dashboard = self.export.dashboard;
                self.settings.export_dash_position = self.export.dash_corner.key().to_string();
                self.settings.export_dash_size = DashSize::nearest(self.export.dash_share).key().to_string();
                self.settings.export_dash_scale = Some(self.export.dash_share);
                self.settings.export_dash_style = self.export.dash_style.key().to_string();
                self.settings.export_dash_tm_top = self.export.bar_top;
                self.settings.export_minimap = self.export.minimap;
                if !self.export.zones.is_empty() {
                    self.settings.export_blur_zones = self.export.zones.clone();
                }
                self.settings.export_minimap_position = self.export.map_corner.key().to_string();
                self.settings.export_minimap_size = DashSize::nearest(self.export.map_share).key().to_string();
                self.settings.export_map_scale = Some(self.export.map_share);
                self.settings.export_watermark_scale = Some(self.export.wm_share as f64);
                self.settings.export_minimap_live = true;
                self.settings.export_dash_free = self.export.dash_free;
                self.settings.export_watermark = self.export.watermark;
                self.settings.export_watermark_position = self.export.wm_corner.key().to_string();
                self.settings.export_watermark_free = self.export.wm_free;
                self.settings.export_map_free = self.export.map_free;
                self.settings.export_timelapse = self.export.timelapse;
                self.settings.export_speed = self.export.speed;
                crate::settings::save(&self.settings);
                let Some(request) = self.export_request(start, end, output.clone()) else {
                    self.export.state = State::Idle;
                    return Task::none();
                };
                let id = self.export.next_id;
                self.export.next_id += 1;
                self.export.done = Arc::new(AtomicUsize::new(0));
                self.export.total = Arc::new(AtomicUsize::new(0));
                self.export.cancel = Arc::new(AtomicBool::new(false));
                self.export.state = State::Running { id, started: Instant::now(), output };
                self.export.eta = None;
                let (done, total, cancel) = (self.export.done.clone(), self.export.total.clone(), self.export.cancel.clone());
                // Planning reads every minute's index: off the UI thread too.
                let work = off_thread_or(Err("The export stopped unexpectedly.".to_string()), move || {
                    job::run(&request, &cancel, |p| {
                        if let job::Progress::Frames { done: d, total: n } = p {
                            total.store(n, Ordering::Relaxed);
                            done.store(d, Ordering::Relaxed);
                        }
                    })
                    .map_err(|e| format!("{e:#}"))
                });
                return Task::batch([Task::perform(work, move |r| wrap(ExportMsg::Finished(id, r))), self.export_poll_later(id)]);
            }
            ExportMsg::Poll(id) => {
                // Redraws the progress while the export runs.
                if let State::Running { id: running, started, .. } = &self.export.state {
                    if *running == id {
                        self.export.eta = next_eta(self.export.eta, started.elapsed().as_secs_f64(), self.export.done.load(Ordering::Relaxed), self.export.total.load(Ordering::Relaxed));
                        return self.export_poll_later(id);
                    }
                }
            }
            ExportMsg::Finished(id, result) => {
                let State::Running { id: running, output, .. } = &self.export.state else { return Task::none() };
                if *running != id {
                    return Task::none();
                }
                let output = output.clone();
                match result {
                    Ok(job::Outcome::Done { bytes, frames, warnings, .. }) => {
                        let format = self.export_format();
                        self.export.state = State::Done { output, bytes, length: frames as f64 / job::FPS as f64, format, quality: self.export.quality };
                        self.export.share.reset();
                        // The finished screen, even if the dialog was put away.
                        self.export.open = true;
                        let tasks: Vec<Task<Message>> = warnings.iter().map(|w| self.notify(t(w).to_string(), true)).collect();
                        return Task::batch(tasks);
                    }
                    Ok(job::Outcome::Cancelled) => {
                        self.export.state = State::Idle;
                        return self.notify(t("ui.notifications.exportCancelled").to_string(), false);
                    }
                    Err(e) => {
                        let message = failure_text(&e);
                        self.export.state = State::Failed(message.clone());
                        if !self.export.open {
                            return self.notify(message, true);
                        }
                    }
                }
            }
            ExportMsg::Cancel => {
                if matches!(self.export.state, State::Running { .. }) {
                    self.export.cancel.store(true, Ordering::Relaxed);
                } else {
                    self.export.open = false;
                }
            }
            ExportMsg::Reveal => {
                if let State::Done { output, .. } = &self.export.state {
                    reveal(output);
                }
            }
            ExportMsg::Play => {
                if let State::Done { output, .. } = &self.export.state {
                    open_file(output);
                }
            }
        }
        Task::none()
    }

    /// The blur zone editor, over the Export dialog.
    fn zone_editor<'a>(&'a self, edit: &'a Editing) -> Element<'a, Message> {
        let editor = crate::blur_editor::Editor {
            snapshot: edit.snapshot.as_ref(),
            aspect: 1448.0 / 938.0,
            points: &edit.points,
            on_change: |p| wrap(ExportMsg::ZonePoints(p)),
            placing: &edit.placing,
            on_place: |p| wrap(ExportMsg::ZonePlacing(p)),
        };
        let header = row![
            text(format!("{} · {}", t("ui.export.blurZoneEditor"), edit.camera.label())).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(wrap(ExportMsg::CancelZone)),
        ]
        .align_y(Alignment::Center);
        let body = column![
            text(format!("{} {}", t("ui.export.blurZoneInstructions"), t("ui.export.blurZoneDraw"))).size(11).color(theme::TEXT_MUTED),
            // The picture underneath, the zone drawn over it (centred and
            // fitted the same way, so they line up).
            stack![
                edit.snapshot.as_ref().map_or_else(
                    || -> Element<'_, Message> { space().width(Length::Fill).height(520).into() },
                    |s| iced::widget::image(s.image.clone()).width(Length::Fill).height(520).content_fit(iced::ContentFit::Contain).into(),
                ),
                iced::widget::canvas(editor).width(Length::Fill).height(520),
            ],
        ]
        .spacing(12);
        let footer = row![space().width(Length::Fill), secondary(t("ui.export.cancel"), Some(wrap(ExportMsg::CancelZone))), primary(t("ui.export.saveZone"), Some(wrap(ExportMsg::SaveZone)))]
            .spacing(10)
            .align_y(Alignment::Center);
        let dialog = container(column![
            container(header).padding([16, 20]).style(theme::modal_header),
            container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
            container(body).padding(20),
            container(footer).padding([16, 20]).width(Length::Fill).style(theme::modal_footer),
        ])
        .width(900)
        .clip(true)
        .style(theme::modal);
        opaque(container(measured(dialog)).center(Length::Fill).style(theme::backdrop))
    }

    /// The dashboard (compact) and map in an export `w` x `h`, for dragging.
    fn movables(&self, w: u32, h: u32) -> Vec<Movable> {
        let mut out = Vec::new();
        let rect = |x: f32, y: f32, cw: u32, ch: u32| iced::Rectangle::new(iced::Point::new(x, y), iced::Size::new(cw as f32, ch as f32));
        // The cameras, under the overlays: their grid fills the frame less
        // Tesla Mobile's bars.
        let tiles = self.export_tiles();
        let cols = tiles.iter().map(|t| t.col + 1).max().unwrap_or(1);
        let rows = tiles.iter().map(|t| t.row + 1).max().unwrap_or(1);
        let (top, bars) = match self.export_dashboard().filter(|d| d.style == DashStyle::TeslaMobile) {
            Some(d) => {
                let (date, data) = crate::export::tesla_mobile::bar_heights(w);
                (date + if d.bar_on_top() { data } else { 0 }, date + data)
            }
            None => (0, 0),
        };
        let cell = (w / cols, h.saturating_sub(bars) / rows);
        for t in &tiles {
            let (x, y, tw, th) = t.rect(cell, w, h, top);
            out.push(Movable {
                what: Dragged::Camera(t.camera),
                rect: iced::Rectangle::new(iced::Point::new(x, y), iced::Size::new(tw, th)),
                snaps: Vec::new(),
                corner: None,
                unit: w as f32,
                shares: (0.1, 1.0),
            });
        }
        if let Some(d) = self.export_dashboard().filter(|d| d.style == DashStyle::Compact) {
            let size = d.size(w);
            let (x, y) = d.place(size.width, size.height, w, h);
            let snaps = Corner::ALL
                .iter()
                .map(|c| {
                    let (sx, sy) = Dashboard { corner: *c, free: None, ..d }.place(size.width, size.height, w, h);
                    (*c, iced::Point::new(sx, sy))
                })
                .collect();
            let (lo, hi) = Dashboard::SHARES;
            let unit = Dashboard::UNIT as f32;
            out.push(Movable {
                what: Dragged::Dashboard,
                rect: rect(x, y, size.width, size.height),
                snaps,
                corner: d.free.is_none().then_some(d.corner),
                unit,
                shares: (lo as f32, (hi as f32).min(w.saturating_sub(80) as f32 / unit)),
            });
        }
        if let Some(m) = self.export_minimap() {
            let side = m.side(w, h);
            let (x, y) = m.place_in(side, w, h, top, h.saturating_sub(bars));
            let snaps = MAP_CORNERS
                .iter()
                .map(|c| {
                    let (sx, sy) = crate::export::overlay::corner_in(*c, side, side, w, top, h.saturating_sub(bars));
                    (*c, iced::Point::new(sx, sy))
                })
                .collect();
            let (lo, hi) = Minimap::SHARES;
            out.push(Movable { what: Dragged::Map, rect: rect(x, y, side, side), snaps, corner: m.free.is_none().then_some(m.corner), unit: w.min(h) as f32, shares: (lo as f32, hi as f32) });
        }
        if let Some(wm) = self.export_watermark() {
            let (ww, wh) = wm.size(w);
            let (x, y) = wm.place_in(w, h, top, h.saturating_sub(bars));
            let snaps = Corner::ALL
                .iter()
                .map(|c| {
                    let (sx, sy) = crate::export::overlay::corner_in(*c, ww, wh, w, top, h.saturating_sub(bars));
                    (*c, iced::Point::new(sx, sy))
                })
                .collect();
            let (lo, hi) = Watermark::SHARES;
            let (pl, ph) = Watermark::PIXELS;
            out.push(Movable {
                what: Dragged::Watermark,
                rect: rect(x, y, ww, wh),
                snaps,
                corner: wm.free.is_none().then_some(wm.corner),
                unit: w as f32,
                shares: (lo.max(pl / w as f32), hi.min(ph / w as f32)),
            });
        }
        out
    }

    /// The finished export: what was made, a look at it, and what next.
    fn export_complete<'a>(&'a self, output: &'a std::path::Path, bytes: u64, length: f64, format: Format, quality: Quality) -> Element<'a, Message> {
        let busy = self.export.share.uploading();
        let header = row![
            container(svg_icon(CHECK_SVG, 14.0, theme::BG)).center(26).style(|_| container::Style {
                background: Some(Background::Color(theme::SUCCESS)),
                border: Border { radius: 13.0.into(), ..Default::default() },
                ..Default::default()
            }),
            text(t("ui.notifications.exportComplete")).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press_maybe((!busy).then_some(wrap(ExportMsg::Close))),
        ]
        .spacing(10)
        .align_y(Alignment::Center);
        const WIDE: f32 = 520.0;
        // The export as the preview drew it, with a play button on it.
        let look: Element<'a, Message> = match &self.export.preview {
            Some(Ok(Shown { handle, size, .. })) => {
                let h = (WIDE * size.1 as f32 / size.0.max(1) as f32).min(300.0);
                let play = button(container(svg_icon(PLAY_SVG, 22.0, theme::TEXT)).center(56))
                    .padding(0)
                    .style(|_, status| {
                        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
                        button::Style {
                            background: Some(Background::Color(Color::from_rgba(0.0, 0.0, 0.0, if hovered { 0.75 } else { 0.55 }))),
                            border: Border { radius: 28.0.into(), color: Color::from_rgba(1.0, 1.0, 1.0, 0.25), width: 1.0 },
                            text_color: theme::TEXT,
                            ..button::Style::default()
                        }
                    })
                    .on_press(wrap(ExportMsg::Play));
                stack![
                    iced::widget::image(handle.clone()).width(WIDE).height(h).content_fit(iced::ContentFit::Contain),
                    container(play).center_x(WIDE).center_y(h),
                ]
                .into()
            }
            _ => space().height(0).into(),
        };
        let name = output.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let facts = format!("{:.1} MB  ·  {}  ·  {}", bytes as f64 / 1e6, clock(length), format.label());
        let body = column![
            container(look).center_x(Length::Fill),
            column![text(name).size(13).font(theme::semibold(theme::INTER)), text(facts).size(11).color(theme::TEXT_SECONDARY)].spacing(3),
            self.share_block(bytes, length, format, quality),
        ]
        .spacing(14);
        let footer = row![
            secondary(reveal_label(), Some(wrap(ExportMsg::Reveal))),
            secondary(t("ui.export.playVideo"), Some(wrap(ExportMsg::Play))),
            space().width(Length::Fill),
            primary(t("ui.settings.done"), (!busy).then_some(wrap(ExportMsg::Close))),
        ]
        .spacing(10)
        .align_y(Alignment::Center);
        let dialog = container(column![
            container(header).padding([16, 20]).style(theme::modal_header),
            container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
            container(body).padding(20),
            container(footer).padding([16, 20]).width(Length::Fill).style(theme::modal_footer),
        ])
        .width(WIDE + 40.0)
        .clip(true)
        .style(theme::modal);
        opaque(mouse_area(container(measured(dialog)).center(Length::Fill).style(theme::backdrop)).on_press(wrap(ExportMsg::Close)))
    }

    /// The editor's timeline: play the preview, and scrub through the range.
    fn editor_timeline(&self) -> Element<'_, Message> {
        let Some((a, b)) = self.export_range_secs().filter(|(a, b)| b > a) else { return space().height(0).into() };
        let here = self.player.position();
        let pos = self.export.at.unwrap_or(if (a..=b).contains(&here) { here } else { a }).clamp(a, b);
        let enabled = !self.export.running();
        // As playback's bar: the time, the skip and play buttons, the timeline.
        let time = container(
            row![
                text(crate::hms(pos - a)).font(theme::MONO).size(13),
                text("/").font(theme::MONO).size(13).color(theme::TEXT_MUTED),
                text(crate::hms(b - a)).font(theme::MONO).size(13),
            ]
            .spacing(4),
        )
        .padding([6, 12])
        .style(theme::time_pill);
        let skip_secs = self.settings.skip_seconds;
        let skip = |glyph: char, by: f64| {
            crate::glass(
                stack![
                    container(theme::icon(glyph, 20.0)).center(24),
                    container(text(format!("{}", skip_secs as u32)).size(9).font(theme::bold(theme::INTER)))
                        .width(28)
                        .height(28)
                        .align_x(iced::alignment::Horizontal::Right)
                        .align_y(iced::alignment::Vertical::Bottom),
                ],
                6,
                10.0,
            )
            .on_press_maybe(enabled.then_some(wrap(ExportMsg::Skip(by))))
        };
        let play = crate::glass(container(theme::icon(if self.export.playing { theme::icon::PAUSE } else { theme::icon::PLAY }, 26.0)).center(28), [6, 8], 12.0)
            .on_press_maybe(enabled.then_some(wrap(ExportMsg::PlayPreview)));
        let timeline: Element<'_, Message> = crate::timeline::Timeline::new(b - a, pos - a, move |t| wrap(ExportMsg::Seek(a + t))).on_release(wrap(ExportMsg::SeekDone)).into();
        row![time, row![skip(theme::icon::SKIP_BACK, -skip_secs), play, skip(theme::icon::SKIP_FORWARD, skip_secs)].spacing(6).align_y(Alignment::Center), timeline]
            .spacing(14)
            .align_y(Alignment::Center)
            .height(44)
            .into()
    }

    /// While the editor plays: the cameras' real video from playback's
    /// decoders, each where the export puts it, with the overlays drawn
    /// live from what's playing (the same drawing as the export's, at the
    /// preview's size): the dashboard on its frosted glass, Tesla Mobile's
    /// bars, the time and the map. The watermark is the preview's picture.
    fn live_layers<'a>(&'a self, items: &[Movable], full: (u32, u32), (w, h): (f32, f32)) -> iced::widget::Stack<'a, Message> {
        use crate::export::overlay::{corner_in, DashState};
        use iced::widget::pin;
        let scale = w / full.0.max(1) as f32;
        // A preview rectangle on whole pixels, from the frame's pixels.
        let px = |x: f32, y: f32, rw: f32, rh: f32| {
            let (x0, y0) = ((x * scale).round(), (y * scale).round());
            let (x1, y1) = (((x + rw) * scale).round().min(w), ((y + rh) * scale).round().min(h));
            iced::Rectangle::new(iced::Point::new(x0, y0), iced::Size::new((x1 - x0).max(1.0), (y1 - y0).max(1.0)))
        };
        let place = |layers: iced::widget::Stack<'a, Message>, r: iced::Rectangle, e: Element<'a, Message>| layers.push(pin(container(e).width(r.width).height(r.height)).x(r.x).y(r.y).width(w).height(h));
        let mut layers = stack![container(space()).width(w).height(h).style(|_| container::Style { background: Some(Background::Color(Color::BLACK)), ..Default::default() })];
        let dashboard = self.export_dashboard();
        // The dashboard's glass, in preview pixels.
        let frost = dashboard.and_then(|d| d.frost(full.0, full.1)).map(|([x, y, fw, fh, r], sigma)| (px(x, y, fw, fh), r * scale, sigma * scale));
        for item in items {
            let Dragged::Camera(c) = item.what else { continue };
            let Some(idx) = GRID.iter().position(|g| *g == c) else { continue };
            if !self.player.slot_active(idx) {
                continue;
            }
            let picture = self.player.shown(idx).map(|s| (s.id, s.frame.clone()));
            let view = crate::video::View { mirror: c.mirrored() && self.settings.mirror_cameras, square: true, ..Default::default() };
            let r = px(item.rect.x, item.rect.y, item.rect.width, item.rect.height);
            // The glass from the tile's top-left (see video::View::square).
            let glass2 = frost.filter(|(g, _, _)| g.intersects(&r)).map(|(g, radius, blur)| crate::video::Glass {
                rect: iced::Rectangle::new(iced::Point::new(g.x - r.x, g.y - r.y), g.size()),
                radius,
                blur,
                saturate: 1.85,
            });
            // Slots of their own: the shader keeps each slot's place and picture.
            let tile = iced::widget::shader(crate::video::VideoTile { slot: EDITOR_SLOTS + idx, picture, glass: None, glass2, view });
            layers = layers.push(pin(tile.width(r.width).height(r.height)).x(r.x).y(r.y).width(w).height(h));
        }
        let telemetry = self.front_telemetry();
        let wall = self.player.wall_clock();
        // Tesla Mobile's bars, across the frame.
        let (top, bars) = match dashboard.filter(|d| d.style == DashStyle::TeslaMobile) {
            Some(d) => {
                let (date, data) = crate::export::tesla_mobile::bar_heights(full.0);
                let line = wall.map(|t| crate::export::tesla_mobile::date_line(t, self.settings.time_24h)).unwrap_or_default();
                layers = place(layers, px(0.0, 0.0, full.0 as f32, date as f32), crate::export::tesla_mobile::date_bar(line));
                let data_y = if d.bar_on_top() { date } else { full.1.saturating_sub(data) };
                let state = DashState { telemetry: telemetry.cloned(), time: String::new(), steering: self.steering, blink_ms: self.epoch.elapsed().as_millis() % 700 };
                layers = place(layers, px(0.0, data_y as f32, full.0 as f32, data as f32), crate::export::tesla_mobile::data_bar(state, self.metric(), !d.bar_on_top()));
                (date + if d.bar_on_top() { data } else { 0 }, date + data)
            }
            None => (0, 0),
        };
        // The time.
        if let (Some(ts), Some(t)) = (self.export_timestamp(), wall) {
            let size = ts.size(full.0);
            let (x, y) = corner_in(ts.corner, size.width, size.height, full.0, top, full.1.saturating_sub(bars));
            layers = place(layers, px(x, y, size.width as f32, size.height as f32), ts.label(t, scale));
        }
        // The compact dashboard, as the export draws it at this size.
        if let (Some(d), Some(item)) = (dashboard.filter(|d| d.style == DashStyle::Compact), items.iter().find(|m| m.what == Dragged::Dashboard)) {
            let r = px(item.rect.x, item.rect.y, item.rect.width, item.rect.height);
            let inner = r.width / 650.0;
            layers = place(layers, r, Dashboard::bar(crate::dashboard::compact(self.dash(inner)), d.glass > 0.0, r.height, 6.0 * inner));
        }
        // The map following the car: playback's map at this size (its 260 px
        // at zoom 16, as the export's live map).
        if let Some(item) = items.iter().find(|m| m.what == Dragged::Map) {
            let r = px(item.rect.x, item.rect.y, item.rect.width, item.rect.height);
            let car = telemetry.and_then(crate::map::car);
            let route = self.map_route().0;
            let center = car.map(|(lat, lon, _)| (lat, lon)).or_else(|| route.get(route.len() / 2).map(|p| (p.0 as f64, p.1 as f64)));
            if let Some(center) = center {
                let side = r.width;
                let zoom = crate::map::DEFAULT_ZOOM + (side / 260.0).log2();
                let corner = side * 24.0 / 260.0;
                let style = if self.settings.map_dark { crate::map::tiles::Style::Dark } else { crate::map::tiles::Style::Light };
                let tiles = crate::map::TileLayer { tiles: &self.tiles, style, center, zoom, bearing: 0.0, radius: corner };
                let view = crate::map::MapView { center, zoom, bearing: 0.0, car, route, events: &[], arrow: &self.arrow, on_pan: |_, _| wrap(ExportMsg::Nothing), on_zoom: |_| wrap(ExportMsg::Nothing) };
                let map: Element<'a, Message> = container(stack![iced::widget::canvas(tiles).width(side).height(side), iced::widget::canvas(view).width(side).height(side)])
                    .style(move |_| container::Style { border: Border { color: Color::from_rgba(1.0, 1.0, 1.0, 0.25), width: 1.0, radius: corner.into() }, ..Default::default() })
                    .into();
                layers = place(layers, r, map);
            } else if let Some((_, piece)) = self.export.preview.as_ref().and_then(|p| p.as_ref().ok()).and_then(|sh| sh.pieces.iter().find(|(what, _)| *what == Dragged::Map)) {
                // No position yet: the preview's map.
                layers = place(layers, r, iced::widget::image(piece.clone()).width(r.width).height(r.height).content_fit(iced::ContentFit::Fill).into());
            }
        }
        // The watermark: its picture from the preview.
        if let (Some(Ok(sh)), Some(item)) = (self.export.preview.as_ref(), items.iter().find(|m| m.what == Dragged::Watermark)) {
            if let Some((_, piece)) = sh.pieces.iter().find(|(what, _)| *what == Dragged::Watermark) {
                let r = px(item.rect.x, item.rect.y, item.rect.width, item.rect.height);
                layers = place(layers, r, iced::widget::image(piece.clone()).width(r.width).height(r.height).content_fit(iced::ContentFit::Fill).into());
            }
        }
        layers
    }

    /// The preview of the export, with its size, format and range under it.
    fn preview_block(&self, (a, b): (f64, f64), secs: f64, speed: f64, multi: bool, used: Format, (wide, tall): (f32, f32)) -> Element<'_, Message> {
        let e = &self.export;
        let (wide_px, tall_px) = (wide, tall);
        #[allow(non_snake_case)]
        let (WIDE, TALL) = (wide_px, tall_px);
        let frame: Element<'_, Message> = match &e.preview {
            Some(Ok(Shown { handle, size: shown, .. })) => {
                let aspect = shown.0 as f32 / shown.1.max(1) as f32;
                let (w, h) = if WIDE / aspect > TALL { (TALL * aspect, TALL) } else { (WIDE, WIDE / aspect) };
                let picture = iced::widget::image(handle.clone()).width(w).height(h).content_fit(iced::ContentFit::Fill);
                let full = e.preview.as_ref().and_then(|p| p.as_ref().ok()).map(|p| p.full).unwrap_or(*shown);
                let items = self.movables(full.0, full.1);
                // While a piece is dragged: the frame without the pieces,
                // and each piece where it is now (scaled with the preview).
                let pieces_shown = e.dragging || e.drag_wait;
                // The pictures under the drag layer: one layer whatever they
                // are, so the drag layer keeps its place (and what it holds)
                // when they change from the frame to the pieces.
                let content: Element<'_, Message> = if e.playing {
                    self.live_layers(&items, full, (w, h)).into()
                } else {
                    match e.preview.as_ref().and_then(|p| p.as_ref().ok()).filter(|p| pieces_shown && p.base.is_some()) {
                    Some(sh) => {
                        let scale = w / full.0.max(1) as f32;
                        let mut layers = stack![iced::widget::image(sh.base.clone().unwrap_or_else(|| handle.clone())).width(w).height(h).content_fit(iced::ContentFit::Fill)];
                        for (what, piece) in &sh.pieces {
                            if let Some(item) = items.iter().find(|m| m.what == *what) {
                                let r = item.rect;
                                layers = layers.push(
                                    container(iced::widget::image(piece.clone()).width(r.width * scale).height(r.height * scale).content_fit(iced::ContentFit::Fill))
                                        .padding(iced::Padding { top: r.y * scale, left: r.x * scale, ..iced::Padding::ZERO })
                                        .width(w)
                                        .height(h),
                                );
                            }
                        }
                        layers.into()
                    }
                    None => picture.into(),
                    }
                };
                let drag = PreviewDrag { frame: (full.0 as f32, full.1 as f32), items, enabled: !e.running() };
                let mut layers = stack![content, iced::widget::canvas(drag).width(w).height(h)];
                if e.preview_busy && !e.playing {
                    layers = layers.push(container(container(text(t("ui.export.previewUpdating")).size(10).color(theme::TEXT_SECONDARY)).padding([3, 8]).style(|_| container::Style {
                        background: Some(Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.6))),
                        border: Border { radius: 6.0.into(), ..Default::default() },
                        ..Default::default()
                    }))
                    .padding(8)
                    .width(w)
                    .align_x(Alignment::End));
                }
                container(layers)
                    .style(|_| container::Style { border: Border { color: Color::from_rgba(1.0, 1.0, 1.0, 0.12), width: 1.0, radius: 4.0.into() }, ..Default::default() })
                    .into()
            }
            other => {
                let words = match other {
                    Some(Err(message)) => message.clone(),
                    _ => t("ui.export.previewDrawing").to_string(),
                };
                container(text(words).size(11).color(theme::TEXT_MUTED)).center_x(WIDE).center_y(TALL * 0.6).style(card_style(false)).into()
            }
        };
        // Size, format and file size; the range and its length.
        let (w, h) = match &e.preview {
            Some(Ok(shown)) => shown.full,
            _ => (0, 0),
        };
        let (fw, fh) = self.export_size(e.quality);
        let mb = job::bitrate(e.quality, !multi, used, fw, fh) as f64 / 8.0 * secs / speed / 1e6;
        let mut facts = vec![used.label().to_string(), format!("≈ {} MB", if mb < 10.0 { format!("{mb:.1}") } else { format!("{mb:.0}") })];
        if w > 0 {
            facts.insert(0, format!("{w} × {h}"));
        }
        let length = if e.timelapse { format!("{} → {}", clock(secs), clock(secs / speed)) } else { clock(secs) };
        let caption = row![
            text(facts.join("  ·  ")).size(11).font(theme::medium(theme::INTER)).color(theme::TEXT_SECONDARY),
            space().width(Length::Fill),
            text(format!("{} – {}  ·  {length}", clock(a), clock(b))).size(11).font(theme::MONO).color(theme::TEXT_SECONDARY),
        ]
        .align_y(Alignment::Center);
        let mut block = column![container(frame).center_x(Length::Fill), caption].spacing(8);
        if e.preview.as_ref().is_some_and(|p| p.is_ok()) {
            block = block.push(text(t("ui.export.previewDragHint")).size(10).color(theme::TEXT_MUTED));
        }
        block.into()
    }

    pub(crate) fn export_dialog(&self) -> Element<'_, Message> {
        if let Some(edit) = &self.export.editing {
            return self.zone_editor(edit);
        }
        if self.export.share.list_open {
            return self.shared_clips_dialog();
        }
        if let State::Done { output, bytes, length, format, quality, .. } = &self.export.state {
            return self.export_complete(output, *bytes, *length, *format, *quality);
        }
        let e = &self.export;
        let busy = e.running();
        let speed = if e.timelapse { e.speed } else { 1.0 };
        let range = self.export_range();
        let secs = self.range_secs();
        let (a, b) = range.map(|(a, b)| (self.player.position_at(a.segment, a.secs), self.player.position_at(b.segment, b.secs))).unwrap_or((0.0, 0.0));

        // Cameras, in playback's layout (those with footage here).
        let available = self.available_cameras();
        let chosen = self.export_cameras();
        let shown: Vec<Camera> = self.settings.camera_order.iter().copied().filter(|c| available.contains(c)).collect();
        let mut cams = Column::new().spacing(8);
        for chunk in shown.chunks(3) {
            let mut r = row![].spacing(8);
            for &c in chunk {
                let on = chosen.contains(&c);
                // All the same height, one line or two ("Right Repeater").
                let label = row![check(on), text(c.label()).size(12).font(theme::medium(theme::INTER))].spacing(7).align_y(Alignment::Center);
                r = r.push(option_card(container(label).height(32).align_y(Alignment::Center), on, (!busy).then_some(wrap(ExportMsg::Camera(c)))));
            }
            cams = cams.push(r);
        }
        if !e.cam_free.is_empty() {
            cams = cams.push(secondary(t("ui.export.resetLayout"), (!busy).then_some(wrap(ExportMsg::ResetLayout))));
        }

        // Quality, with each camera's size.
        let multi = !(chosen.len() == 1 && chosen[0] == Camera::Front);
        let base = if multi { e.side_size.or(e.front_size).unwrap_or((1448, 938)) } else { e.front_size.unwrap_or((2896, 1876)) };
        let mut qualities = row![].spacing(8);
        for q in [Quality::Mobile, Quality::Medium, Quality::High, Quality::Max] {
            let (w, h) = job::cell_size(base, q, !multi);
            let on = e.quality == q;
            qualities = qualities.push(option_card(
                column![text(quality_label(q)).size(12).font(theme::semibold(theme::INTER)), text(format!("{w}×{h}")).size(10).color(theme::TEXT_MUTED)].spacing(2),
                on,
                (!busy).then_some(wrap(ExportMsg::Quality(q))),
            ));
        }
        let mut quality = column![qualities].spacing(8);
        // Format: each one's size at this quality, greyed out when this
        // computer has no encoder for it or the frame is too big for it.
        let used = self.export_format();
        let widest = self.export_widest(e.quality);
        let (fw, fh) = self.export_size(e.quality);
        let mb_for = |f: Format| job::bitrate(e.quality, !multi, f, fw, fh) as f64 / 8.0 * secs / speed / 1e6;
        let mb_text = |mb: f64| if mb < 10.0 { format!("{mb:.1}") } else { format!("{mb:.0}") };
        let mut formats = row![].spacing(8);
        for f in Format::ALL {
            let support = self.format_support(f);
            let fits = widest <= f.max_side();
            let note = if support == Support::No {
                t("ui.export.formatNotHere").to_string()
            } else if !fits {
                tf("ui.export.formatTooBig", &[("size", &f.max_side().to_string())])
            } else {
                let what = match f {
                    Format::H264 => t("ui.export.formatH264"),
                    Format::Hevc => t("ui.export.formatHevc"),
                    Format::Av1 => t("ui.export.formatAv1"),
                };
                let slower = if support == Support::Software { format!(" · {}", t("ui.export.formatSlower")) } else { String::new() };
                format!("{what}{slower}")
            };
            let usable = support != Support::No && fits;
            let dim = Color { a: 0.5, ..theme::TEXT_MUTED };
            let size: Element<'_, Message> = if usable {
                text(format!("≈ {} MB", mb_text(mb_for(f)))).size(11).font(theme::medium(theme::INTER)).color(if used == f { theme::ACCENT } else { theme::TEXT_SECONDARY }).into()
            } else {
                space().height(0).into()
            };
            formats = formats.push(option_card(
                column![
                    text(f.label()).size(12).font(theme::semibold(theme::INTER)).color(if usable { theme::TEXT } else { dim }),
                    size,
                    text(note).size(10).color(if usable { theme::TEXT_MUTED } else { dim }),
                ]
                .spacing(2),
                used == f,
                (!busy && usable).then_some(wrap(ExportMsg::Format(f))),
            ));
        }
        quality = quality.push(text(t("ui.export.format")).size(12).font(theme::medium(theme::INTER)));
        quality = quality.push(formats);
        if used != e.format {
            let words = if self.format_support(e.format) == Support::No {
                tf("ui.export.formatSwitchedHere", &[("chosen", e.format.label()), ("format", used.label())])
            } else {
                tf("ui.export.formatSwitched", &[("quality", quality_label(e.quality)), ("chosen", e.format.label()), ("format", used.label())])
            };
            quality = quality.push(info(words, theme::WARNING));
        }
        // Where it plays.
        let hint = match used {
            Format::H264 => t("ui.export.formatH264Hint"),
            Format::Hevc => t("ui.export.formatHevcHint"),
            Format::Av1 => t("ui.export.formatAv1Hint"),
        };
        quality = quality.push(text(hint).size(10).color(theme::TEXT_MUTED));
        if widest > 3840 {
            quality = quality.push(info(t("ui.export.over4kWarning").to_string(), theme::WARNING));
        }
        // Only where the front camera is bigger than the others (HW4, not
        // HW3, where every camera is 1280x960).
        let front_bigger = e.front_size.zip(e.side_size).is_some_and(|(f, s)| f.0 > s.0);
        if multi && chosen.contains(&Camera::Front) && front_bigger {
            quality = quality.push(info(t("ui.export.frontCamWarning").to_string(), theme::WARNING));
        }

        // Time-lapse.
        let mut timelapse = column![labelled(
            t("ui.export.enableTimelapse"),
            t("ui.export.enableTimelapseDesc"),
            toggler(e.timelapse).size(22).on_toggle_maybe((!busy).then_some(|b| wrap(ExportMsg::Timelapse(b)))).style(theme::toggle).into(),
        )]
        .spacing(8);
        if e.timelapse {
            let labels: Vec<String> = SPEEDS.iter().map(|s| format!("{s}x")).collect();
            let current = SPEEDS.iter().position(|s| *s == e.speed).unwrap_or(3);
            timelapse = timelapse.push(sub(column![
                text(t("ui.export.timelapseSpeed")).size(12).font(theme::medium(theme::INTER)),
                segmented(labels, current, !busy, ExportMsg::Speed),
                text(t("ui.export.timelapseSpeedDesc")).size(10).color(theme::TEXT_MUTED),
            ]
            .spacing(6)
            .into()));
        }

        // Overlays: the timestamp, or the dashboard (which shows the time).
        let mut overlays = column![labelled(
            t("ui.export.timestamp"),
            t("ui.export.timestampDesc"),
            toggler(e.timestamp && !e.dashboard).size(22).on_toggle_maybe((!busy && !e.dashboard).then_some(|b| wrap(ExportMsg::Timestamp(b)))).style(theme::toggle).into(),
        )]
        .spacing(8);
        if e.timestamp && !e.dashboard {
            overlays = overlays.push(sub(labelled(t("ui.export.position"), t(e.corner.label_key()), corner_pad(&Corner::ALL, Some(e.corner), !busy, ExportMsg::Corner))));
        }
        overlays = overlays.push(labelled(
            t("ui.export.dashboard"),
            t("ui.export.dashboardDesc"),
            toggler(e.dashboard).size(22).on_toggle_maybe((!busy).then_some(|b| wrap(ExportMsg::Dashboard(b)))).style(theme::toggle).into(),
        ));
        if e.dashboard {
            let styles: Vec<String> = DashStyle::ALL.iter().map(|d| t(d.label_key()).to_string()).collect();
            let style = DashStyle::ALL.iter().position(|d| *d == e.dash_style).unwrap_or(0);
            overlays = overlays.push(sub(labelled(t("ui.export.style"), "", segmented(styles, style, !busy, ExportMsg::DashStyle))));
            if e.dash_style == DashStyle::TeslaMobile {
                let bars = vec![t("ui.export.bottom").to_string(), t("ui.export.top").to_string()];
                overlays = overlays.push(sub(labelled(t("ui.export.position"), "", segmented(bars, e.bar_top as usize, !busy, ExportMsg::Bar))));
            } else {
                let (place, lit) = if e.dash_free.is_some() { (t("ui.export.customPosition"), None) } else { (t(e.dash_corner.label_key()), Some(e.dash_corner)) };
                overlays = overlays.push(sub(labelled(t("ui.export.position"), place, corner_pad(&Corner::ALL, lit, !busy, ExportMsg::DashCorner))));
            }
        }
        overlays = overlays.push(labelled(
            t("ui.export.minimap"),
            t("ui.export.minimapDesc"),
            toggler(e.minimap).size(22).on_toggle_maybe((!busy).then_some(|b| wrap(ExportMsg::Minimap(b)))).style(theme::toggle).into(),
        ));
        if e.minimap {
            let (place, lit) = if e.map_free.is_some() { (t("ui.export.customPosition"), None) } else { (t(e.map_corner.label_key()), Some(e.map_corner)) };
            overlays = overlays.push(sub(labelled(t("ui.export.position"), place, corner_pad(&MAP_CORNERS, lit, !busy, ExportMsg::MapCorner))));
        }

        // The Sentry Six watermark.
        overlays = overlays.push(labelled(
            t("ui.export.watermark"),
            t("ui.export.watermarkDesc"),
            toggler(e.watermark).size(22).on_toggle_maybe((!busy).then_some(|b| wrap(ExportMsg::Watermark(b)))).style(theme::toggle).into(),
        ));
        if e.watermark {
            let (place, lit) = if e.wm_free.is_some() { (t("ui.export.customPosition"), None) } else { (t(e.wm_corner.label_key()), Some(e.wm_corner)) };
            overlays = overlays.push(sub(labelled(t("ui.export.position"), place, corner_pad(&Corner::ALL, lit, !busy, ExportMsg::WatermarkCorner))));
        }

        // Privacy: blur zones.
        let mut privacy = Column::new().spacing(8);
        if e.restore_offer {
            privacy = privacy.push(
                container(
                    row![
                        text(tf("ui.export.restoreBannerText", &[("count", &self.settings.export_blur_zones.len().to_string())])).size(11).color(theme::TEXT_SECONDARY).width(Length::Fill),
                        secondary(t("ui.export.restoreBannerDismiss"), Some(wrap(ExportMsg::DismissRestore))),
                        primary(t("ui.export.restoreBannerRestore"), Some(wrap(ExportMsg::RestoreZones))),
                    ]
                    .spacing(8)
                    .align_y(Alignment::Center),
                )
                .padding([8, 12])
                .style(card_style(true)),
            );
        }
        let cam_labels: Vec<String> = available.iter().map(|c| c.label().to_string()).collect();
        let cam_index = available.iter().position(|c| *c == e.zone_camera).unwrap_or(0);
        // "Add Blur Zone: pick the camera, then draw the area", with the
        // camera and the button side by side.
        privacy = privacy.push(labelled(
            t("ui.export.addBlurZone"),
            t("ui.export.blurZonePick"),
            row![
                select(cam_labels, cam_index, !busy, ExportMsg::ZoneCameraMenu, ExportMsg::ZoneCamera),
                secondary(t("ui.export.addZone"), (!busy && available.contains(&e.zone_camera)).then_some(wrap(ExportMsg::AddZone))),
            ]
            .spacing(8)
            .align_y(Alignment::Center)
            .into(),
        ));
        for (i, z) in e.zones.iter().enumerate() {
            privacy = privacy.push(
                container(
                    row![
                        text(format!("{} · {}", z.camera.label(), z.points.len())).size(12).width(Length::Fill),
                        secondary("Edit", (!busy).then_some(wrap(ExportMsg::EditZone(i)))),
                        button(container(text("×").size(16)).center(Length::Fill)).width(26).height(26).padding(0).style(theme::modal_close).on_press_maybe((!busy).then_some(wrap(ExportMsg::RemoveZone(i)))),
                    ]
                    .spacing(8)
                    .align_y(Alignment::Center),
                )
                .padding([6, 10])
                .style(card_style(false)),
            );
        }
        let unselected: Vec<&str> = e.zones.iter().map(|z| z.camera).filter(|c| !chosen.contains(c)).map(|c| c.label()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        if !unselected.is_empty() {
            privacy = privacy.push(info(tf("ui.export.blurZonesWarning", &[("cameras", &unselected.join(", "))]), theme::WARNING));
        }

        // The editor: the canvas (the preview, sized to the window) with
        // its timeline on the left, the settings in folding cards on the
        // right, Export (or its progress) top right.
        let window = self.window_size.unwrap_or(iced::Size::new(1280.0, 820.0));
        let side = if window.width >= 1100.0 { 380.0 } else { 320.0 };
        let canvas_w = (window.width - 48.0 - 40.0 - side - 20.0).max(320.0);
        let canvas_h = (window.height - 48.0 - 62.0 - 40.0 - 30.0 - 22.0 - 48.0 - 36.0).max(180.0);
        let folded = e.folded;
        let card = move |f: Fold, title: String, body: Element<'static, Message>| -> Element<'static, Message> {
            let open = folded & f as u8 == 0;
            let head = button(
                row![
                    text(title).size(13).font(theme::semibold(theme::INTER)),
                    space().width(Length::Fill),
                    svg_icon(if open { CHEVRON_UP_SVG } else { CHEVRON_DOWN_SVG }, 14.0, theme::TEXT_MUTED),
                ]
                .align_y(Alignment::Center),
            )
            .padding([10, 14])
            .width(Length::Fill)
            .style(|_, _| button::Style { text_color: theme::TEXT, ..button::Style::default() })
            .on_press(wrap(ExportMsg::Fold(f)));
            let mut col = column![head];
            if open {
                col = col.push(container(body).padding(iced::Padding { top: 0.0, right: 14.0, bottom: 14.0, left: 14.0 }));
            }
            container(col).width(Length::Fill).style(card_style(false)).into()
        };
        let sidebar = iced::widget::scrollable(
            column![
                card(Fold::Cameras, t("ui.export.layout").into(), cams.into()),
                card(Fold::Quality, t("ui.export.quality").into(), quality.into()),
                card(Fold::Overlays, t("ui.export.overlays").into(), overlays.into()),
                card(Fold::Privacy, t("ui.export.privacy").into(), privacy.into()),
                card(Fold::TimeLapse, t("ui.export.timelapse").into(), timelapse.into()),
                card(Fold::Share, t("ui.export.shareClip").into(), self.share_section(secs / speed, used)),
            ]
            .spacing(10)
            .padding(iced::Padding { right: 10.0, ..iced::Padding::ZERO }),
        )
        .style(theme::thin_scroll)
        .width(side)
        .height(Length::Fill);
        // The preview in the middle of the canvas, the timeline at its foot.
        let canvas = column![
            container(self.preview_block((a, b), secs, speed, multi, used, (canvas_w, canvas_h))).width(Length::Fill).height(Length::Fill).center_y(Length::Fill),
            self.editor_timeline()
        ]
        .spacing(12)
        .width(Length::Fill);
        let body = row![container(canvas).width(Length::Fill).height(Length::Fill), sidebar].spacing(20).padding(20).height(Length::Fill);

        // Top right: Export, or the export's progress, or why it failed.
        let action: Element<'_, Message> = match &e.state {
            State::Running { .. } => {
                let done = e.done.load(Ordering::Relaxed);
                let total = e.total.load(Ordering::Relaxed);
                let frac = done as f32 / total.max(1) as f32;
                let left = e.eta.map(|(at, secs)| secs - at.elapsed().as_secs_f64());
                let mut words = if total == 0 {
                    t("ui.export.preparing").to_string()
                } else {
                    tf("ui.export.exportingPercent", &[("percent", &format!("{}", (frac * 100.0).floor() as u32))])
                };
                if let Some(l) = left {
                    words = format!("{words}  ·  {} left", clock(l));
                }
                row![column![text(words).size(11).color(theme::TEXT_SECONDARY), progress_bar(frac)].spacing(6).width(260), secondary(t("ui.export.cancel"), Some(wrap(ExportMsg::Cancel)))]
                    .spacing(12)
                    .align_y(Alignment::Center)
                    .into()
            }
            State::Failed(message) => row![
                text(message.clone()).size(11).color(theme::ERROR).width(Length::Fixed(360.0)),
                primary(t("ui.export.exportBtn"), Some(wrap(ExportMsg::Start))),
            ]
            .spacing(12)
            .align_y(Alignment::Center)
            .into(),
            _ => primary(t("ui.export.exportBtn"), (!busy && !chosen.is_empty() && secs >= 0.1).then_some(wrap(ExportMsg::Start))),
        };
        let header = row![
            svg_icon(DOWNLOAD_SVG, 18.0, theme::ACCENT),
            text(t("ui.export.title")).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            action,
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(wrap(ExportMsg::Close)),
        ]
        .spacing(12)
        .align_y(Alignment::Center);
        let dialog = container(column![
            container(header).padding([14, 20]).style(theme::modal_header),
            container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
            body,
        ])
        .width(Length::Fill)
        .height(Length::Fill)
        .clip(true)
        .style(theme::modal_editor);
        // Over the whole window (Escape or × closes it).
        opaque(container(measured(dialog)).padding(24).width(Length::Fill).height(Length::Fill).style(theme::backdrop))
    }
}

/// A select: the macOS menu on a Mac, a dropdown elsewhere.
fn select<'a>(labels: Vec<String>, current: usize, enabled: bool, menu: ExportMsg, choose: fn(usize) -> ExportMsg) -> Element<'a, Message> {
    let value = labels.get(current).cloned().unwrap_or_default();
    if crate::native_menu::AVAILABLE {
        return button(row![text(value).size(11), theme::icon(theme::icon::EXPAND_MORE, 15.0)].spacing(6).align_y(Alignment::Center))
            .padding([4, 8])
            .style(theme::settings_select)
            .on_press_maybe(enabled.then_some(wrap(menu)))
            .into();
    }
    let options = labels.clone();
    let list = pick_list(options, Some(value), move |s: String| wrap(choose(labels.iter().position(|l| *l == s).unwrap_or(0)))).text_size(11).padding([4, 8]).handle(theme::chevron_handle(15.0)).style(theme::settings_pick);
    if enabled {
        list.into()
    } else {
        container(list).into()
    }
}

fn reveal_label() -> String {
    if cfg!(target_os = "macos") {
        "Show in Finder".into()
    } else {
        "Show in folder".into()
    }
}

/// Shows the file in Finder / Explorer / the file manager.
/// Opens a file in its usual app (the video player).
fn open_file(path: &std::path::Path) {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(path).spawn();
    if let Err(e) = r {
        log::warn!("could not open the export: {e}");
    }
}

fn reveal(path: &std::path::Path) {
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn();
    if let Err(e) = r {
        log::warn!("could not show the export: {e}");
    }
}

fn card_style(on: bool) -> impl Fn(&iced::Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(if on { Color { a: 0.12, ..theme::ACCENT } } else { Color::from_rgba(1.0, 1.0, 1.0, 0.04) })),
        border: Border { color: if on { Color { a: 0.5, ..theme::ACCENT } } else { Color::from_rgba(1.0, 1.0, 1.0, 0.08) }, width: 1.0, radius: 10.0.into() },
        ..Default::default()
    }
}

/// A selectable card (a camera, a quality).
fn option_card<'a>(content: impl Into<Element<'a, Message>>, on: bool, press: Option<Message>) -> Element<'a, Message> {
    button(container(content).padding([9, 10]).width(Length::Fill).style(card_style(on)))
        .padding(0)
        .width(Length::Fill)
        // The card draws itself; text in it is the app's (a plain button
        // would make it black).
        .style(|_, _| button::Style { text_color: theme::TEXT, ..button::Style::default() })
        .on_press_maybe(press)
        .into()
}

fn check<'a>(on: bool) -> Element<'a, Message> {
    let mark: Element<'a, Message> = if on { svg_icon(CHECK_SVG, 11.0, theme::BG) } else { space().into() };
    container(mark)
        .center(16)
        .style(move |_| container::Style {
            background: on.then_some(Background::Color(theme::ACCENT)),
            border: Border { color: if on { theme::ACCENT } else { Color::from_rgba(1.0, 1.0, 1.0, 0.3) }, width: 1.5, radius: 4.0.into() },
            ..Default::default()
        })
        .into()
}

/// Something that can be dragged in the preview: where it is and the
/// places it snaps to, in the frame's pixels.
struct Movable {
    what: Dragged,
    rect: iced::Rectangle,
    snaps: Vec<(Corner, iced::Point)>,
    /// The usual place it's in (None when dragged somewhere of its own).
    corner: Option<Corner>,
    /// Its width in the frame's pixels for a share of 1, and the shares
    /// it may be resized between.
    unit: f32,
    shares: (f32, f32),
}

/// How a held piece follows the pointer.
#[derive(Debug, Clone, Copy)]
enum Grip {
    /// Moved, held this far into it (preview pixels).
    Move(iced::Vector),
    /// Resized by a corner handle: the corner that stays put (the frame's
    /// pixels), which way the handle is from it, and whether it grows
    /// both ways from its centre (centred at the top or bottom).
    Resize { fixed: iced::Point, left: bool, up: bool, centred: bool, keep: Option<Corner> },
}

/// How near a corner (preview pixels) the pointer takes the resize handle.
const HANDLE_REACH: f32 = 9.0;

/// The layer over the preview that moves the dashboard and map: an outline
/// on hover, dragged anywhere, snapping to its usual places when near one.
struct PreviewDrag {
    /// The export's size, which the preview shows scaled.
    frame: (f32, f32),
    items: Vec<Movable>,
    enabled: bool,
}

#[derive(Default)]
struct DragState {
    /// What's held, and how.
    /// (By what it is: the pieces' order changes as cameras are moved.)
    held: Option<(Dragged, Grip)>,
    hover: Option<Dragged>,
    /// The lines it's snapped to (the frame's pixels): x of vertical
    /// lines, y of horizontal ones.
    guides: (Vec<f32>, Vec<f32>),
}

/// Snaps one axis: the piece's start, centre and end (from `pos`, `len`)
/// to the nearest of `lines` within `reach`. The new start, and the line.
fn snap_axis(pos: f32, len: f32, lines: &[f32], reach: f32) -> (f32, Option<f32>) {
    let mut best: Option<(f32, f32, f32)> = None;
    for &line in lines {
        for offset in [0.0, len / 2.0, len] {
            let d = (pos + offset - line).abs();
            if d < reach && best.is_none_or(|(bd, _, _)| d < bd) {
                best = Some((d, line - offset, line));
            }
        }
    }
    match best {
        Some((_, start, line)) => (start, Some(line)),
        None => (pos, None),
    }
}

impl PreviewDrag {
    fn scale(&self, bounds: iced::Rectangle) -> f32 {
        bounds.width / self.frame.0.max(1.0)
    }

    fn shown(&self, i: usize, scale: f32) -> iced::Rectangle {
        let r = self.items[i].rect;
        iced::Rectangle::new(iced::Point::new(r.x * scale, r.y * scale), iced::Size::new(r.width * scale, r.height * scale))
    }

    /// The topmost item under `p` (the map is drawn over the dashboard).
    fn at(&self, p: iced::Point, scale: f32) -> Option<usize> {
        (0..self.items.len()).rev().find(|&i| self.shown(i, scale).expand(HANDLE_REACH / 2.0).contains(p))
    }

    /// The corner handle of item `i` under `p`: (left, up) for which
    /// corner.
    fn handle(&self, i: usize, p: iced::Point, scale: f32) -> Option<(bool, bool)> {
        let r = self.shown(i, scale);
        [(true, true), (false, true), (true, false), (false, false)].into_iter().find(|(left, up)| {
            let c = iced::Point::new(if *left { r.x } else { r.x + r.width }, if *up { r.y } else { r.y + r.height });
            c.distance(p) <= HANDLE_REACH
        })
    }

    /// The grip for resizing item `i` by the handle at (left, up).
    fn resize_grip(&self, i: usize, (left, up): (bool, bool)) -> Grip {
        let item = &self.items[i];
        let r = item.rect;
        // Centred at the top or bottom, by a handle away from that edge:
        // it stays centred and grows both ways.
        let centred = match item.corner {
            Some(Corner::TopCenter) => !up,
            Some(Corner::BottomCenter) => up,
            _ => false,
        };
        let fixed = iced::Point::new(if centred { r.x + r.width / 2.0 } else if left { r.x + r.width } else { r.x }, if up { r.y + r.height } else { r.y });
        // In a usual place and held by the corner away from it: still there.
        let keep = item.corner.filter(|c| {
            let toward_top = matches!(c, Corner::TopLeft | Corner::TopCenter | Corner::TopRight);
            let side_ok = match c {
                Corner::TopLeft | Corner::BottomLeft => !left,
                Corner::TopRight | Corner::BottomRight => left,
                _ => centred,
            };
            side_ok && toward_top != up
        });
        Grip::Resize { fixed, left, up, centred, keep }
    }

    /// Item `i` resized with its handle at `p` (the frame's pixels): the
    /// new share and place, the moving edge snapped to the frame's edges
    /// and centre and the other pieces.
    #[allow(clippy::type_complexity)]
    fn resize(&self, state: &mut DragState, i: usize, p: iced::Point, (fixed, left, up, centred, keep): (iced::Point, bool, bool, bool, Option<Corner>), scale: f32) -> Option<iced::widget::canvas::Action<Message>> {
        let item = &self.items[i];
        let (fw, fh) = self.frame;
        let aspect = item.rect.width / item.rect.height.max(1.0);
        let mut xs = vec![0.0, fw / 2.0, fw];
        let mut ys = vec![0.0, fh / 2.0, fh];
        for (_, other) in self.items.iter().enumerate().filter(|(j, _)| *j != i) {
            let r = other.rect;
            xs.extend([r.x, r.x + r.width / 2.0, r.x + r.width]);
            ys.extend([r.y, r.y + r.height / 2.0, r.y + r.height]);
        }
        let reach = 6.0 / scale;
        // The width the pointer asks for, by either axis.
        let (ex, gx) = if centred { (p.x, None) } else { snap_axis(p.x, 0.0, &xs, reach) };
        let (ey, gy) = snap_axis(p.y, 0.0, &ys, reach);
        let dx = if centred { (ex - fixed.x).abs() } else if left { fixed.x - ex } else { ex - fixed.x };
        let dy = if up { fixed.y - ey } else { ey - fixed.y };
        // The handle runs along the corner's diagonal: the width whose
        // handle is nearest the pointer, or the width an edge snapped to.
        let k = if centred { 0.5 } else { 1.0 };
        let (want, guide) = match (gx, gy) {
            (Some(_), _) => (dx / k, (gx, None)),
            (None, Some(_)) => (dy * aspect, (None, gy)),
            (None, None) => ((k * dx + dy / aspect) / (k * k + 1.0 / (aspect * aspect)), (None, None)),
        };
        // Kept inside the frame, and between the sizes it may be.
        let room_x = if centred { 2.0 * fixed.x.min(fw - fixed.x) } else if left { fixed.x } else { fw - fixed.x };
        let room_y = (if up { fixed.y } else { fh - fixed.y }) * aspect;
        let (lo, hi) = item.shares;
        let hi = hi.min(room_x.min(room_y) / item.unit).max(lo);
        let share = (want / item.unit).clamp(lo, hi);
        let w = share * item.unit;
        let h = w / aspect;
        let x = if centred { fixed.x - w / 2.0 } else if left { fixed.x - w } else { fixed.x };
        let y = if up { fixed.y - h } else { fixed.y };
        // Only a guide it actually reaches.
        let at_edge = |g: Option<f32>, edge: f32| g.filter(|g| (g - edge).abs() < 1.0);
        let edge_x = if left { x } else { x + w };
        let edge_y = if up { y } else { y + h };
        state.guides = (at_edge(guide.0, edge_x).into_iter().collect(), at_edge(guide.1, edge_y).into_iter().collect());
        let to = match keep {
            Some(c) => DragTo::Corner(c),
            None => DragTo::Free(x / fw, y / fh),
        };
        Some(iced::widget::canvas::Action::publish(wrap(ExportMsg::Resize(item.what, share as f64, to))).and_capture())
    }
}

impl iced::widget::canvas::Program<Message> for PreviewDrag {
    type State = DragState;

    fn update(&self, state: &mut DragState, event: &iced::widget::canvas::Event, bounds: iced::Rectangle, cursor: iced::mouse::Cursor) -> Option<iced::widget::canvas::Action<Message>> {
        use iced::mouse::{Button, Event as M};
        use iced::widget::canvas::{Action, Event};
        if !self.enabled {
            return None;
        }
        let scale = self.scale(bounds);
        match event {
            Event::Mouse(M::ButtonPressed(Button::Left)) => {
                let p = cursor.position_in(bounds)?;
                let i = self.at(p, scale)?;
                let grip = match self.handle(i, p, scale) {
                    Some(corner) => self.resize_grip(i, corner),
                    None => Grip::Move(p - self.shown(i, scale).position()),
                };
                state.held = Some((self.items[i].what, grip));
                Some(Action::capture())
            }
            Event::Mouse(M::CursorMoved { .. }) => {
                let Some((what, grip)) = state.held else {
                    let hover = cursor.position_in(bounds).and_then(|p| self.at(p, scale)).map(|i| self.items[i].what);
                    let changed = hover != state.hover;
                    state.hover = hover;
                    return changed.then(Action::request_redraw);
                };
                let i = self.items.iter().position(|m| m.what == what)?;
                let p = cursor.position_from(bounds.position())?;
                let grip = match grip {
                    Grip::Move(v) => v,
                    Grip::Resize { fixed, left, up, centred, keep } => {
                        return self.resize(state, i, iced::Point::new(p.x / scale, p.y / scale), (fixed, left, up, centred, keep), scale);
                    }
                };
                let item = &self.items[i];
                let (w, h) = (item.rect.width, item.rect.height);
                // The new top-left in the frame's pixels.
                let x = (p.x - grip.x) / scale;
                let y = (p.y - grip.y) / scale;
                // Lines to snap to: the frame's edges and centre, the usual
                // places' edges, and the other pieces' edges and centres.
                let (fw, fh) = self.frame;
                let mut xs = vec![0.0, fw / 2.0, fw];
                let mut ys = vec![0.0, fh / 2.0, fh];
                for (_, s) in &item.snaps {
                    xs.extend([s.x, s.x + w]);
                    ys.extend([s.y, s.y + h]);
                }
                for (j, other) in self.items.iter().enumerate().filter(|(j, _)| *j != i) {
                    let _ = j;
                    let r = other.rect;
                    xs.extend([r.x, r.x + r.width / 2.0, r.x + r.width]);
                    ys.extend([r.y, r.y + r.height / 2.0, r.y + r.height]);
                }
                let reach = 6.0 / scale;
                let (x, gx) = snap_axis(x, w, &xs, reach);
                let (y, gy) = snap_axis(y, h, &ys, reach);
                let x = x.clamp(0.0, (fw - w).max(0.0));
                let y = y.clamp(0.0, (fh - h).max(0.0));
                state.guides = (gx.into_iter().collect(), gy.into_iter().collect());
                // Exactly on one of its usual places: that place.
                let corner = item.snaps.iter().find(|(_, s)| (s.x - x).abs() < 0.5 && (s.y - y).abs() < 0.5);
                let to = match corner {
                    Some((c, _)) => DragTo::Corner(*c),
                    None => DragTo::Free(x / fw, y / fh),
                };
                if let Dragged::Camera(_) = item.what {
                    return Some(Action::publish(wrap(ExportMsg::Resize(item.what, (w / item.unit) as f64, to))).and_capture());
                }
                Some(Action::publish(wrap(ExportMsg::Drag(item.what, to))).and_capture())
            }
            Event::Mouse(M::ButtonReleased(Button::Left)) => {
                state.guides = (Vec::new(), Vec::new());
                state.held.take().map(|_| Action::publish(wrap(ExportMsg::DragDone)).and_capture())
            }
            _ => None,
        }
    }

    fn draw(&self, state: &DragState, renderer: &iced::Renderer, _: &iced::Theme, bounds: iced::Rectangle, _: iced::mouse::Cursor) -> Vec<iced::widget::canvas::Geometry> {
        use iced::widget::canvas::{Frame, Path, Stroke};
        let mut frame = Frame::new(renderer, bounds.size());
        let scale = self.scale(bounds);
        let lit = state.held.map(|(what, _)| what).or(state.hover);
        if let Some(i) = lit.and_then(|what| self.items.iter().position(|m| m.what == what)) {
            let r = self.shown(i, scale);
            let outline = Path::rounded_rectangle(r.position(), r.size(), 4.0.into());
            frame.fill(&outline, Color { a: 0.10, ..theme::ACCENT });
            frame.stroke(&outline, Stroke::default().with_width(1.5).with_color(theme::ACCENT));
            // The resize handles at its corners.
            for (cx, cy) in [(r.x, r.y), (r.x + r.width, r.y), (r.x, r.y + r.height), (r.x + r.width, r.y + r.height)] {
                let handle = Path::rectangle(iced::Point::new(cx - 4.0, cy - 4.0), iced::Size::new(8.0, 8.0));
                frame.fill(&handle, Color::WHITE);
                frame.stroke(&handle, Stroke::default().with_width(1.5).with_color(theme::ACCENT));
            }
            // While held: the lines it has snapped to, across the frame.
            if state.held.is_some() {
                let line = Stroke::default().with_width(1.0).with_color(Color { a: 0.9, ..theme::ACCENT });
                for x in &state.guides.0 {
                    let x = (x * scale).round() + 0.5;
                    frame.stroke(&Path::line(iced::Point::new(x, 0.0), iced::Point::new(x, bounds.height)), line);
                }
                for y in &state.guides.1 {
                    let y = (y * scale).round() + 0.5;
                    frame.stroke(&Path::line(iced::Point::new(0.0, y), iced::Point::new(bounds.width, y)), line);
                }
            }
        }
        vec![frame.into_geometry()]
    }

    fn mouse_interaction(&self, state: &DragState, bounds: iced::Rectangle, cursor: iced::mouse::Cursor) -> iced::mouse::Interaction {
        if !self.enabled {
            return iced::mouse::Interaction::default();
        }
        use iced::mouse::Interaction;
        let diagonal = |left: bool, up: bool| if left == up { Interaction::ResizingDiagonallyDown } else { Interaction::ResizingDiagonallyUp };
        match state.held {
            Some((_, Grip::Move(_))) => return Interaction::Grabbing,
            Some((_, Grip::Resize { left, up, .. })) => return diagonal(left, up),
            None => {}
        }
        let scale = self.scale(bounds);
        let Some(p) = cursor.position_in(bounds) else { return Interaction::default() };
        match self.at(p, scale) {
            Some(i) => match self.handle(i, p, scale) {
                Some((left, up)) => diagonal(left, up),
                None => Interaction::Grab,
            },
            None => Interaction::default(),
        }
    }
}


/// A setting that belongs to the one above it: indented under it.
fn sub(content: Element<'_, Message>) -> Element<'_, Message> {
    container(content).padding(iced::Padding { left: 16.0, ..iced::Padding::ZERO }).width(Length::Fill).into()
}

/// Choices side by side, the chosen one lit.
fn segmented<'a>(labels: Vec<String>, current: usize, enabled: bool, choose: fn(usize) -> ExportMsg) -> Element<'a, Message> {
    let mut r = row![].spacing(2);
    for (i, label) in labels.into_iter().enumerate() {
        let on = i == current;
        r = r.push(
            button(text(label).size(11).font(if on { theme::semibold(theme::INTER) } else { theme::INTER }))
                .padding([3, 8])
                .style(move |_, status| {
                    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
                    button::Style {
                        background: Some(Background::Color(if on {
                            Color { a: 0.20, ..theme::ACCENT }
                        } else if hovered {
                            Color::from_rgba(1.0, 1.0, 1.0, 0.08)
                        } else {
                            Color::TRANSPARENT
                        })),
                        text_color: if on { theme::ACCENT } else { theme::TEXT_SECONDARY },
                        border: Border { radius: 5.0.into(), ..Default::default() },
                        ..button::Style::default()
                    }
                })
                .on_press_maybe((enabled && !on).then_some(wrap(choose(i)))),
        );
    }
    container(r)
        .padding(2)
        .style(|_| container::Style {
            background: Some(Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.25))),
            border: Border { color: Color::from_rgba(1.0, 1.0, 1.0, 0.12), width: 1.0, radius: 7.0.into() },
            ..Default::default()
        })
        .into()
}

/// Where an overlay goes, picked on a little picture of the frame: a dot
/// for each place it can go (`options`), the chosen one lit.
fn corner_pad<'a>(options: &[Corner], current: Option<Corner>, enabled: bool, choose: fn(usize) -> ExportMsg) -> Element<'a, Message> {
    let spot = |c: Corner| -> Element<'a, Message> {
        let Some(i) = options.iter().position(|o| *o == c) else { return space().width(10).height(10).into() };
        let on = Some(c) == current;
        button(space().width(6).height(6))
            .padding(2)
            .style(move |_, status| {
                let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
                button::Style {
                    background: Some(Background::Color(if on {
                        theme::ACCENT
                    } else if hovered {
                        Color::from_rgba(1.0, 1.0, 1.0, 0.55)
                    } else {
                        Color::from_rgba(1.0, 1.0, 1.0, 0.22)
                    })),
                    border: Border { radius: 5.0.into(), ..Default::default() },
                    ..button::Style::default()
                }
            })
            .on_press_maybe((enabled && !on).then_some(wrap(choose(i))))
            .into()
    };
    let line = |a: Corner, b: Corner, c: Corner| row![spot(a), space().width(Length::Fill), spot(b), space().width(Length::Fill), spot(c)].align_y(Alignment::Center);
    container(column![
        line(Corner::TopLeft, Corner::TopCenter, Corner::TopRight),
        space().height(Length::Fill),
        line(Corner::BottomLeft, Corner::BottomCenter, Corner::BottomRight),
    ])
    .padding(4)
    .width(54)
    .height(34)
    .style(|_| container::Style {
        background: Some(Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.30))),
        border: Border { color: Color::from_rgba(1.0, 1.0, 1.0, 0.18), width: 1.0, radius: 6.0.into() },
        ..Default::default()
    })
    .into()
}

fn labelled<'a>(label: &'a str, desc: &'a str, control: Element<'a, Message>) -> Element<'a, Message> {
    let mut words = column![text(label).size(12).font(theme::medium(theme::INTER))].spacing(2).width(Length::Fill);
    if !desc.is_empty() {
        words = words.push(text(desc).size(10).color(theme::TEXT_MUTED));
    }
    row![
        words,
        control
    ]
    .spacing(12)
    .align_y(Alignment::Center)
    .into()
}

fn info<'a>(words: String, color: Color) -> Element<'a, Message> {
    container(text(words).size(11).color(theme::TEXT_SECONDARY))
        .padding([8, 12])
        .width(Length::Fill)
        .style(move |_| container::Style {
            background: Some(Background::Color(Color { a: 0.08, ..color })),
            border: Border { color: Color { a: 0.3, ..color }, width: 1.0, radius: 8.0.into() },
            ..Default::default()
        })
        .into()
}

fn primary<'a>(label: &'a str, press: Option<Message>) -> Element<'a, Message> {
    button(text(label).size(12).font(theme::semibold(theme::INTER))).padding([8, 18]).style(theme::primary_button).on_press_maybe(press).into()
}

fn secondary<'a>(label: impl text::IntoFragment<'a>, press: Option<Message>) -> Element<'a, Message> {
    button(text(label).size(12).font(theme::medium(theme::INTER))).padding([8, 14]).style(theme::secondary_button).on_press_maybe(press).into()
}

fn progress_bar<'a>(fraction: f32) -> Element<'a, Message> {
    let filled = (fraction.clamp(0.0, 1.0) * 1000.0).round() as u16;
    let fill = container(space().height(6)).width(Length::FillPortion(filled.max(1))).style(|_: &iced::Theme| container::Style {
        background: Some(Background::Color(theme::ACCENT)),
        border: Border { radius: 3.0.into(), ..Default::default() },
        ..Default::default()
    });
    let mut bar = row![fill];
    if filled < 1000 {
        bar = bar.push(space().width(Length::FillPortion(1000 - filled)));
    }
    container(bar)
        .width(Length::Fill)
        .style(|_: &iced::Theme| container::Style {
            background: Some(Background::Color(Color::from_rgba(1.0, 1.0, 1.0, 0.08))),
            border: Border { radius: 3.0.into(), ..Default::default() },
            ..Default::default()
        })
        .into()
}

#[cfg(test)]
mod tests {
    /// Paints the Export dialog offscreen to a PNG (SENTRY_DUMP_DIALOG), to
    /// look at its layout without running the app. Settings come from an
    /// empty temporary home, so nothing of the user's is read or written.
    #[test]
    #[ignore]
    fn dialog_snapshot() {
        let Some(out) = std::env::var_os("SENTRY_DUMP_DIALOG") else { return };
        let home = std::env::temp_dir().join(format!("sentry-dialog-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the test runs alone (ignored, run on its own).
        unsafe { std::env::set_var("HOME", &home) };
        let (mut app, _) = crate::App::boot();
        let (w, h) = std::env::var("SENTRY_DIALOG_SIZE").ok().and_then(|s| s.split_once("x").and_then(|(a, b)| Some((a.parse().ok()?, b.parse().ok()?)))).unwrap_or((800u32, 860u32));
        app.window_size = Some(iced::Size::new(w as f32, h as f32));
        app.export.open = true;
        app.export.side_size = Some((1448, 938));
        app.export.front_size = Some((2896, 1876));
        app.export.support = Some([super::Support::Hardware, super::Support::Hardware, super::Support::No]);
        app.export.dashboard = true;
        // SENTRY_DIALOG_CLIPS: a folder of clips, for the cameras and a real
        // preview (drawn here, as the dialog would on its thread).
        if let Some(dir) = std::env::var_os("SENTRY_DIALOG_CLIPS") {
            let collections = crate::library::scan(std::path::Path::new(&dir)).unwrap();
            let segments = crate::library::load_segments(&collections[0]).unwrap();
            app.player.load(segments, 0.0);
            app.export.minimap = std::env::var_os("SENTRY_DIALOG_MAP").is_some();
            if std::env::var_os("SENTRY_DIALOG_FREE").is_some() {
                app.export.dash_free = Some((0.30, 0.40));
            }
            // SENTRY_DIALOG_CAMS: the front camera moved and shrunk, over
            // the back (with the dashboard's glass over it).
            if std::env::var_os("SENTRY_DIALOG_CAMS").is_some() {
                app.export.cam_free = vec![(super::Camera::Front, (0.36, 0.38, 0.30))];
            }
            if std::env::var_os("SENTRY_DIALOG_TESLA").is_some() {
                app.export.dash_style = crate::export::overlay::DashStyle::TeslaMobile;
            }
            let (start, end) = app.export_range().unwrap();
            let request = app.export_request(start, end, std::path::PathBuf::new()).unwrap();
            let p = crate::export::job::preview(&request, super::Position { segment: 0, secs: 10.0 }, super::PREVIEW_WIDTH, true).unwrap();
            app.export.preview = Some(Ok(super::Shown::from_preview(&p)));
        }
        // SENTRY_DIALOG_PLAYING: the editor playing (live overlays; the
        // video itself is a shader, which this painter leaves out).
        if std::env::var_os("SENTRY_DIALOG_PLAYING").is_some() {
            app.export.playing = true;
        }
        if std::env::var_os("SENTRY_DIALOG_DONE").is_some() {
            app.export.state = super::State::Done { output: "/Users/me/Movies/Tesla 2026-11-07 08-24-23.mp4".into(), bytes: 168_800_000, length: 179.0, format: super::Format::H264, quality: super::Quality::High };
        }
        if let Ok(which) = std::env::var("SENTRY_DIALOG_SHARE") {
            let clip = |code: &str, name: &str, hours: i64| crate::share::SharedClip {
                code: code.into(),
                url: format!("https://clip.sentry-six.com/{code}"),
                delete_token: "t".into(),
                expires_at: (chrono::Utc::now() + chrono::Duration::hours(hours)).to_rfc3339(),
                file_size: 168_800_000,
                file_name: name.into(),
                uploaded_at: String::new(),
            };
            app.settings.shared_clips = vec![clip("AbCd2345", "Tesla 2026-11-07 08-24-23.mp4", 70), clip("Xy9Kp3Mn", "Tesla Sentry 2026-11-05 14-02-11.mp4", -5)];
            match which.as_str() {
                "list" => app.export.share.list_open = true,
                "intent" => app.export.share.intent = true,
                "done" => app.export.share.state = super::share_ui::Sharing::Done(app.settings.shared_clips[0].clone()),
                _ => {}
            }
        }
        // SENTRY_DIALOG_DRAGGING: the dashboard mid-drag, top left.
        if std::env::var_os("SENTRY_DIALOG_DRAGGING").is_some() {
            app.export.dragging = true;
            app.export.dash_free = Some((0.05, 0.08));
        }
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        let pic = painter.paint_scaled(app.export_dialog(), iced::Size::new(w * 2, h * 2), 2.0);
        ::image::RgbaImage::from_raw(pic.width, pic.height, pic.rgba).unwrap().save(out).unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The blur zone editor answers a drag on its zone (SENTRY_DIALOG_CLIPS:
    /// a folder of clips).
    #[test]
    #[ignore]
    fn zone_editor_drags() {
        let Some(dir) = std::env::var_os("SENTRY_DIALOG_CLIPS") else { return };
        let home = std::env::temp_dir().join(format!("sentry-zone-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the test runs alone (ignored, run on its own).
        unsafe { std::env::set_var("HOME", &home) };
        let (mut app, _) = crate::App::boot();
        app.window_size = Some(iced::Size::new(1280.0, 820.0));
        let collections = crate::library::scan(std::path::Path::new(&dir)).unwrap();
        app.player.load(crate::library::load_segments(&collections[0]).unwrap(), 0.0);
        app.export.open = true;
        let _ = app.export_update(super::ExportMsg::AddZone);
        assert!(app.export.editing.is_some(), "the editor didn't open");
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        use iced::mouse::{Button, Event as M};
        let at = |x: f32, y: f32| iced::Event::Mouse(M::CursorMoved { position: iced::Point::new(x, y) });
        let events = [at(640.0, 430.0), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(680.0, 450.0), at(700.0, 470.0), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        let messages = painter.interact(app.export_dialog(), iced::Size::new(1280.0, 820.0), &events);
        let moved = messages.iter().filter(|m| matches!(m, crate::Message::Export(super::ExportMsg::ZonePoints(_)))).count();
        eprintln!("{} message(s), {moved} zone moves: {:?}", messages.len(), messages.iter().map(|m| format!("{m:?}").chars().take(60).collect::<String>()).collect::<Vec<_>>());
        assert!(moved > 0, "dragging the zone published nothing");
        // As in the app: rebuilt after every message. The zone must follow
        // the whole drag, not just its first step.
        let before = app.export.editing.as_ref().unwrap().points.clone();
        let mut steps = vec![at(640.0, 430.0), iced::Event::Mouse(M::ButtonPressed(Button::Left))];
        for k in 1..=10 {
            steps.push(at(640.0 + 10.0 * k as f32, 430.0));
        }
        steps.push(iced::Event::Mouse(M::ButtonReleased(Button::Left)));
        let n = painter.run(
            &mut app,
            |a| a.export_dialog(),
            |a, m| {
                if let crate::Message::Export(e) = m {
                    let _ = a.export_update(e);
                }
            },
            iced::Size::new(1280.0, 820.0),
            &steps,
        );
        let after = app.export.editing.as_ref().unwrap().points.clone();
        eprintln!("{n} message(s); first corner {:?} -> {:?}", before[0], after[0]);
        assert!(after[0].0 - before[0].0 > 0.05, "the zone stopped following the drag");

        // Drawing a new zone: a drag on the picture away from the zone.
        let mut steps = vec![at(318.0, 212.0), iced::Event::Mouse(M::ButtonPressed(Button::Left))];
        for k in 1..=5 {
            steps.push(at(318.0 + 30.0 * k as f32, 212.0 + 25.0 * k as f32));
        }
        steps.push(iced::Event::Mouse(M::ButtonReleased(Button::Left)));
        painter.run(
            &mut app,
            |a| a.export_dialog(),
            |a, m| {
                if let crate::Message::Export(e) = m {
                    let _ = a.export_update(e);
                }
            },
            iced::Size::new(1280.0, 820.0),
            &steps,
        );
        let drawn = app.export.editing.as_ref().unwrap().points.clone();
        eprintln!("drawn: {drawn:?}");
        assert_eq!(drawn.len(), 4);
        assert!(drawn[0].0 < 0.2 && drawn[0].1 < 0.2, "no new zone was drawn: {drawn:?}");

        // Placing a zone by clicks: five corners, then the first again.
        let click = |x: f32, y: f32| vec![at(x, y), iced::Event::Mouse(M::ButtonPressed(Button::Left)), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        let mut steps = Vec::new();
        for (x, y) in [(300.0, 600.0), (420.0, 560.0), (520.0, 640.0), (430.0, 670.0), (320.0, 660.0), (301.0, 601.0)] {
            steps.extend(click(x, y));
        }
        painter.run(
            &mut app,
            |a| a.export_dialog(),
            |a, m| {
                if let crate::Message::Export(e) = m {
                    let _ = a.export_update(e);
                }
            },
            iced::Size::new(1280.0, 820.0),
            &steps,
        );
        let placed = app.export.editing.as_ref().unwrap().points.clone();
        eprintln!("placed: {placed:?}");
        assert_eq!(placed.len(), 5, "clicking corners made no zone: {placed:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The dashboard dragged in the preview moves, and snaps to a corner.
    #[test]
    #[ignore]
    fn preview_drags_the_dashboard() {
        let Some(dir) = std::env::var_os("SENTRY_DIALOG_CLIPS") else { return };
        let home = std::env::temp_dir().join(format!("sentry-drag-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the test runs alone (ignored, run on its own).
        unsafe { std::env::set_var("HOME", &home) };
        let (mut app, _) = crate::App::boot();
        let collections = crate::library::scan(std::path::Path::new(&dir)).unwrap();
        app.player.load(crate::library::load_segments(&collections[0]).unwrap(), 0.0);
        app.export.open = true;
        app.export.dashboard = true;
        const W: u32 = 3258;
        const H: u32 = 1408;
        const SHOWN: f32 = 720.0;
        let (w, h, shown) = (W, H, SHOWN);
        let scale = shown / w as f32;
        fn view(a: &crate::App) -> iced::Element<'_, crate::Message> {
            iced::widget::canvas(super::PreviewDrag { frame: (W as f32, H as f32), items: a.movables(W, H), enabled: true }).width(SHOWN).height(H as f32 * SHOWN / W as f32).into()
        }
        let update = |a: &mut crate::App, m: crate::Message| {
            if let crate::Message::Export(e) = m {
                let _ = a.export_update(e);
            }
        };
        let dash = |a: &crate::App| a.movables(W, H).into_iter().find(|m| m.what == super::Dragged::Dashboard).expect("no dashboard").rect;
        let r = dash(&app);
        let (cx, cy) = ((r.x + r.width / 2.0) * scale, (r.y + r.height / 2.0) * scale);
        use iced::mouse::{Button, Event as M};
        let at = |x: f32, y: f32| iced::Event::Mouse(M::CursorMoved { position: iced::Point::new(x, y) });
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        let mut steps = vec![at(cx, cy), iced::Event::Mouse(M::ButtonPressed(Button::Left))];
        for k in 1..=6 {
            steps.push(at(cx - 15.0 * k as f32, cy - 12.0 * k as f32));
        }
        steps.push(iced::Event::Mouse(M::ButtonReleased(Button::Left)));
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        eprintln!("free: {:?}", app.export.dash_free);
        let (fx, fy) = app.export.dash_free.expect("the dashboard didn't move");
        eprintln!("moved to {:?}, aimed at {:?}", (fx * w as f32, fy * h as f32), (r.x - 90.0 / scale, r.y - 72.0 / scale));
        // Where it was aimed, or snapped to a line within reach (6 preview pixels).
        let reach = 6.0 / scale + 3.0;
        assert!((fx * w as f32 - (r.x - 90.0 / scale)).abs() < reach && (fy * h as f32 - (r.y - 72.0 / scale)).abs() < reach);
        // Dropped with its centre near the frame's centre: snapped onto it.
        let r = dash(&app);
        let grip = ((r.x + r.width / 2.0) * scale, (r.y + r.height / 2.0) * scale);
        let aim = ((w as f32 / 2.0 + 15.0) * scale, (h as f32 / 2.0 - 12.0) * scale);
        let steps = vec![at(grip.0, grip.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(aim.0, aim.1), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        let c = dash(&app);
        eprintln!("centred: {:?}", c);
        assert!((c.x + c.width / 2.0 - w as f32 / 2.0).abs() < 1.0 && (c.y + c.height / 2.0 - h as f32 / 2.0).abs() < 1.0);
        // Dropped next to the top-left place: snapped there.
        let r = dash(&app);
        let target = iced::Point::new(40.0 * scale + 2.0, 40.0 * scale + 2.0);
        let grip = ((r.x + r.width / 2.0) * scale, (r.y + r.height / 2.0) * scale);
        let steps = vec![at(grip.0, grip.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(target.x + r.width / 2.0 * scale, target.y + r.height / 2.0 * scale), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        eprintln!("corner: {:?}, free: {:?}", app.export.dash_corner, app.export.dash_free);
        assert_eq!(app.export.dash_corner, crate::export::overlay::Corner::TopLeft);
        assert!(app.export.dash_free.is_none());
        // Its bottom-right handle dragged 30 preview pixels right: wider,
        // still in the top-left place.
        let r = dash(&app);
        let handle = ((r.x + r.width) * scale, (r.y + r.height) * scale);
        let before = app.export.dash_share;
        let steps = vec![at(handle.0, handle.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(handle.0 + 15.0, handle.1), at(handle.0 + 30.0, handle.1), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        let after = dash(&app);
        eprintln!("resized: {before} -> {}, {r:?} -> {after:?}", app.export.dash_share);
        assert_eq!(app.export.dash_corner, crate::export::overlay::Corner::TopLeft);
        assert!(app.export.dash_free.is_none());
        assert!((after.width - (r.width + 30.0 / scale)).abs() < 3.0, "{after:?}");
        assert!((after.x - r.x).abs() < 1.0 && (after.y - r.y).abs() < 1.0);
        // Its top-left handle dragged in: smaller, placed where it ended.
        let r = after;
        let handle = (r.x * scale, r.y * scale);
        let steps = vec![at(handle.0, handle.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(handle.0 + 40.0, handle.1 + 2.0), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        let after = dash(&app);
        eprintln!("shrunk: {r:?} -> {after:?}, free {:?}", app.export.dash_free);
        assert!(app.export.dash_free.is_some());
        assert!((after.x + after.width - (r.x + r.width)).abs() < 2.0 && (after.y + after.height - (r.y + r.height)).abs() < 2.0);
        assert!(after.width < r.width - 30.0 / scale);
        // The front camera: shrunk by its top-left handle (its bottom-right
        // stays), then moved by its middle; Reset Layout puts it back.
        let cam = |a: &crate::App| a.movables(W, H).into_iter().find(|m| m.what == super::Dragged::Camera(super::Camera::Front)).expect("no front camera").rect;
        let home_rect = cam(&app);
        let handle = (home_rect.x * scale, home_rect.y * scale);
        let steps = vec![at(handle.0, handle.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(handle.0 + 40.0, handle.1 + 26.0), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        let small = cam(&app);
        eprintln!("front: {home_rect:?} -> {small:?}, {:?}", app.export.cam_free);
        assert!(small.width < home_rect.width - 100.0);
        assert!((small.x + small.width - (home_rect.x + home_rect.width)).abs() < 3.0 && (small.y + small.height - (home_rect.y + home_rect.height)).abs() < 3.0);
        let grip = ((small.x + small.width / 2.0) * scale, (small.y + small.height / 2.0) * scale);
        let steps = vec![at(grip.0, grip.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(grip.0 - 25.0, grip.1 + 20.0), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        let moved = cam(&app);
        eprintln!("moved front: {moved:?}");
        assert!((moved.width - small.width).abs() < 2.0);
        assert!(moved.x < small.x - 60.0 && moved.y > small.y + 40.0);
        // Its tile is drawn last, at that place.
        let tiles = app.export_tiles();
        assert_eq!(tiles.last().map(|t| t.camera), Some(super::Camera::Front));
        let _ = app.export_update(super::ExportMsg::ResetLayout);
        assert_eq!(cam(&app), home_rect);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// One press drags the dashboard all the way in the whole preview
    /// (the picture turning into the pieces mid-drag mustn't drop it), and
    /// a moved camera doesn't take over another's drag
    /// (SENTRY_DIALOG_CLIPS).
    #[test]
    #[ignore]
    fn editor_drags_on_first_press() {
        let Some(dir) = std::env::var_os("SENTRY_DIALOG_CLIPS") else { return };
        let home = std::env::temp_dir().join(format!("sentry-press-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the test runs alone (ignored, run on its own).
        unsafe { std::env::set_var("HOME", &home) };
        let (mut app, _) = crate::App::boot();
        let collections = crate::library::scan(std::path::Path::new(&dir)).unwrap();
        app.player.load(crate::library::load_segments(&collections[0]).unwrap(), 0.0);
        app.export.open = true;
        app.export.dashboard = true;
        let (start, end) = app.export_range().unwrap();
        let request = app.export_request(start, end, std::path::PathBuf::new()).unwrap();
        let p = crate::export::job::preview(&request, super::Position { segment: 0, secs: 10.0 }, super::PREVIEW_WIDTH, true).unwrap();
        app.export.preview = Some(Ok(super::Shown::from_preview(&p)));
        const WIDE: f32 = 720.0;
        fn view(a: &crate::App) -> iced::Element<'_, crate::Message> {
            let (a0, b0) = a.export_range_secs().unwrap();
            a.preview_block((a0, b0), b0 - a0, 1.0, true, super::Format::H264, (WIDE, 600.0))
        }
        let update = |a: &mut crate::App, m: crate::Message| {
            if let crate::Message::Export(e) = m {
                let _ = a.export_update(e);
            }
        };
        let (w, h) = (p.width, p.height);
        let scale = WIDE / w as f32;
        let find = |a: &crate::App, what: super::Dragged| a.movables(w, h).into_iter().find(|m| m.what == what).unwrap().rect;
        use iced::mouse::{Button, Event as M};
        let at = |x: f32, y: f32| iced::Event::Mouse(M::CursorMoved { position: iced::Point::new(x, y) });
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        // The dashboard, 10 moves of 8 px up and left in one press.
        let r = find(&app, super::Dragged::Dashboard);
        let (cx, cy) = ((r.x + r.width / 2.0) * scale, (r.y + r.height / 2.0) * scale);
        let mut steps = vec![at(cx, cy), iced::Event::Mouse(M::ButtonPressed(Button::Left))];
        for k in 1..=10 {
            steps.push(at(cx - 8.0 * k as f32, cy - 8.0 * k as f32));
        }
        steps.push(iced::Event::Mouse(M::ButtonReleased(Button::Left)));
        painter.run(&mut app, view, update, iced::Size::new(WIDE, 700.0), &steps);
        let after = find(&app, super::Dragged::Dashboard);
        eprintln!("dashboard {r:?} -> {after:?}");
        assert!(r.y - after.y > 60.0 / scale, "the drag stopped early: {r:?} -> {after:?}");
        // The left pillar moved (to the end of the order), then the right
        // pillar dragged: only the right pillar moves.
        for (what, dx) in [(super::Camera::LeftPillar, 30.0), (super::Camera::RightPillar, -30.0)] {
            let r = find(&app, super::Dragged::Camera(what));
            let (cx, cy) = ((r.x + r.width / 2.0) * scale, (r.y + r.height * 0.7) * scale);
            let mut steps = vec![at(cx, cy), iced::Event::Mouse(M::ButtonPressed(Button::Left))];
            for k in 1..=5 {
                steps.push(at(cx + dx * k as f32 / 5.0, cy + 6.0 * k as f32));
            }
            steps.push(iced::Event::Mouse(M::ButtonReleased(Button::Left)));
            let left_before = find(&app, super::Dragged::Camera(super::Camera::LeftPillar));
            painter.run(&mut app, view, update, iced::Size::new(WIDE, 700.0), &steps);
            let moved = find(&app, super::Dragged::Camera(what));
            eprintln!("{what:?}: {r:?} -> {moved:?}");
            assert!((moved.x - r.x - dx / scale).abs() < 6.0 / scale + 2.0, "{what:?} didn't follow");
            if what == super::Camera::RightPillar {
                assert_eq!(find(&app, super::Dragged::Camera(super::Camera::LeftPillar)), left_before, "the left pillar moved too");
            }
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The Export dialog in both dialog looks (frosted, solid) over the footage, side by side
    /// in one picture (SENTRY_DIALOG_CLIPS, SENTRY_DUMP_LOOKS=out.png).
    #[test]
    #[ignore]
    fn modal_looks() {
        let (Some(dir), Some(out)) = (std::env::var_os("SENTRY_DIALOG_CLIPS"), std::env::var_os("SENTRY_DUMP_LOOKS")) else { return };
        let home = std::env::temp_dir().join(format!("sentry-looks-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the test runs alone (ignored, run on its own).
        unsafe { std::env::set_var("HOME", &home) };
        let (mut app, _) = crate::App::boot();
        let (w, h) = (1280u32, 820u32);
        app.window_size = Some(iced::Size::new(w as f32, h as f32));
        let collections = crate::library::scan(std::path::Path::new(&dir)).unwrap();
        app.player.load(crate::library::load_segments(&collections[0]).unwrap(), 0.0);
        app.export.open = true;
        app.export.dashboard = true;
        app.export.minimap = true;
        app.export.support = Some([super::Support::Hardware, super::Support::Hardware, super::Support::No]);
        app.export.side_size = Some((1448, 938));
        app.export.front_size = Some((2896, 1876));
        let (start, end) = app.export_range().unwrap();
        let request = app.export_request(start, end, std::path::PathBuf::new()).unwrap();
        let p = crate::export::job::preview(&request, super::Position { segment: 0, secs: 10.0 }, super::PREVIEW_WIDTH, true).unwrap();
        app.export.preview = Some(Ok(super::Shown::from_preview(&p)));
        // Behind the dialog: the footage filling the window, frosted under
        // the dialog as the app does, and dimmed by the backdrop.
        let frame = match std::env::var_os("SENTRY_LOOKS_BACKGROUND") {
            Some(path) => ::image::open(path).unwrap().to_rgba8(),
            None => ::image::RgbaImage::from_raw(p.shown.0, p.shown.1, p.rgba).unwrap(),
        };
        let (bw, bh) = (w * 2, h * 2);
        let mut back = ::image::imageops::resize(&frame, bw, bh, ::image::imageops::FilterType::Triangle);
        let dialog = (100u32, 48u32, 2360u32, 1544u32);
        let frosted = ::image::imageops::blur(&::image::imageops::crop_imm(&back, dialog.0, dialog.1, dialog.2, dialog.3).to_image(), 26.0);
        ::image::imageops::replace(&mut back, &frosted, dialog.0 as i64, dialog.1 as i64);
        for px in back.pixels_mut() {
            for c in 0..3 {
                px[c] = (px[c] as f32 * 0.65) as u8;
            }
        }
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        let mut grid = ::image::RgbaImage::new(bw * 2, bh);
        for look in 0..2u8 {
            crate::theme::set_solid_dialogs(look == 1);
            let pic = painter.paint_scaled(app.export_dialog(), iced::Size::new(bw, bh), 2.0);
            let mut shot = back.clone();
            for (i, px) in shot.pixels_mut().enumerate() {
                let s = &pic.rgba[i * 4..i * 4 + 4];
                let a = s[3] as f32 / 255.0;
                for c in 0..3 {
                    px[c] = (s[c] as f32 + px[c] as f32 * (1.0 - a)).min(255.0) as u8;
                }
            }
            ::image::imageops::replace(&mut grid, &shot, (look as u32 * bw) as i64, 0);
        }
        crate::theme::set_solid_dialogs(false);
        let small = ::image::imageops::resize(&grid, bw, bh / 2, ::image::imageops::FilterType::Triangle);
        small.save(out).unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The zone editor inside the whole app window, driven as the app runs
    /// (App::view, App::update): clicking corners must make a zone.
    #[test]
    #[ignore]
    fn zone_editor_in_the_app() {
        let Some(dir) = std::env::var_os("SENTRY_DIALOG_CLIPS") else { return };
        let home = std::env::temp_dir().join(format!("sentry-zoneapp-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the test runs alone (ignored, run on its own).
        unsafe { std::env::set_var("HOME", &home) };
        let (mut app, _) = crate::App::boot();
        let size = iced::Size::new(1280.0, 820.0);
        app.window_size = Some(size);
        app.settings.privacy_accepted = crate::welcome::PRIVACY_VERSION;
        let collections = crate::library::scan(std::path::Path::new(&dir)).unwrap();
        app.player.load(crate::library::load_segments(&collections[0]).unwrap(), 0.0);
        app.export.open = true;
        let _ = app.export_update(super::ExportMsg::AddZone);
        let before = app.export.editing.as_ref().unwrap().points.clone();
        use iced::mouse::{Button, Event as M};
        let at = |x: f32, y: f32| iced::Event::Mouse(M::CursorMoved { position: iced::Point::new(x, y) });
        // Frames are drawn between events, as in the app.
        let redraw = || iced::Event::Window(iced::window::Event::RedrawRequested(std::time::Instant::now()));
        let click = |x: f32, y: f32| vec![redraw(), at(x, y), redraw(), iced::Event::Mouse(M::ButtonPressed(Button::Left)), redraw(), iced::Event::Mouse(M::ButtonReleased(Button::Left)), redraw()];
        let mut steps = vec![redraw(), redraw()];
        for (x, y) in [(300.0, 600.0), (420.0, 560.0), (520.0, 640.0), (430.0, 670.0), (301.0, 601.0)] {
            steps.extend(click(x, y));
        }
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        let seen = std::cell::RefCell::new(Vec::new());
        painter.run(
            &mut app,
            |a| a.view(),
            |a, m| {
                seen.borrow_mut().push(format!("{m:?}").chars().take(70).collect::<String>());
                let _ = a.update(m);
            },
            size,
            &steps,
        );
        let after = app.export.editing.as_ref().map(|e| e.points.clone());
        eprintln!("messages: {:#?}", seen.borrow());
        eprintln!("before {before:?}\nafter {after:?}");
        let _ = std::fs::remove_dir_all(&home);
        assert!(!seen.borrow().is_empty() && after.as_ref().is_some_and(|p| p[0].1 > 0.6), "clicking corners in the app made no zone");
    }

    #[test]
    fn export_names() {
        use super::file_name;
        assert_eq!(file_name(None, Some("2026-11-07 08:23:55")), "Tesla 2026-11-07 08-23-55.mp4");
        assert_eq!(file_name(Some("Sentry"), Some("2026-11-07 08:23:55")), "Tesla Sentry 2026-11-07 08-23-55.mp4");
        assert_eq!(file_name(Some("Road trip: day 2/3"), Some("2026-11-07 08:23:55")), "Tesla Road trip day 2 3 2026-11-07 08-23-55.mp4");
        assert_eq!(file_name(None, None), "Tesla.mp4");
    }
}
