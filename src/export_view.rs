//! The export: Start and End markers set from the playhead, and the Export
//! Video dialog (cameras, quality, time-lapse), worded as in earlier
//! versions. The export runs on its own threads (see export::job); the
//! dialog can be closed meanwhile, and the Export button shows how far it
//! has got.

use crate::export::encode::{Format, Support};
use crate::export::job::{self, Position, Quality, Tile};
use crate::export::overlay::{Corner, DashSize, DashStyle, Dashboard, MapTiles, Minimap, Timestamp};

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
/// A play triangle (the finished screen's play button).
const PLAY_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>"#;
const POLL: Duration = Duration::from_millis(250);
/// The preview's width in pixels (twice the dialog's, for sharp screens).
const PREVIEW_WIDTH: u32 = 1440;

/// What's being dragged in the preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dragged {
    Dashboard,
    Map,
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
    DashSize(usize),
    DashStyle(usize),
    Bar(usize),
    ZoneCameraMenu,
    ZoneCamera(usize),
    AddZone,
    EditZone(usize),
    RemoveZone(usize),
    ZonePoints(Vec<(f32, f32)>),
    SaveZone,
    CancelZone,
    RestoreZones,
    DismissRestore,
    Minimap(bool),
    MapCorner(usize),
    MapSize(usize),
    MapMode(usize),
    Format(Format),
    Formats([Support; 3]),
    Preview(Arc<Result<job::Preview, String>>),
    /// The camera's picture for the zone editor, at the preview's moment.
    ZoneSnapshot(Camera, Option<Box<crate::blur_editor::Snapshot>>),
    /// The dashboard or map dragged in the preview.
    Drag(Dragged, DragTo),
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
    Done { output: PathBuf, bytes: u64, seconds: f64, length: f64, format: Format },
    Failed(String),
}

/// A blur zone in the editor: its camera, corners, which zone it replaces
/// (None: a new one) and the camera's picture.
pub struct Editing {
    pub camera: Camera,
    pub points: Vec<(f32, f32)>,
    pub index: Option<usize>,
    pub snapshot: Option<crate::blur_editor::Snapshot>,
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
    pub dash_size: DashSize,
    pub dash_style: DashStyle,
    /// Tesla Mobile's data bar on top.
    pub bar_top: bool,
    pub minimap: bool,
    pub map_corner: Corner,
    pub map_size: DashSize,
    pub map_live: bool,
    /// The dashboard (compact) and map dragged to a place of their own in
    /// the preview: top-left as shares of the frame.
    pub dash_free: Option<(f32, f32)>,
    pub map_free: Option<(f32, f32)>,
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
            dash_size: DashSize::Medium,
            dash_style: DashStyle::Compact,
            bar_top: false,
            minimap: false,
            map_corner: Corner::TopRight,
            map_size: DashSize::Small,
            map_live: false,
            dash_free: None,
            map_free: None,
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
        let chosen = self.export_cameras();
        let order: Vec<Camera> = self.settings.camera_order.iter().copied().filter(|c| chosen.contains(c)).collect();
        let tiles: Vec<Tile> = job::grid(&order);
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
            timestamp: (self.export.timestamp && !self.export.dashboard).then_some(Timestamp {
                corner: self.export.corner,
                date_format: self.settings.date_format,
                h24: self.settings.time_24h,
            }),
            dashboard: self.export_dashboard(),
            minimap: self.export_minimap(),
            blur_zones: self.export.zones.clone(),
            output: output.clone(),
        })
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
            size: e.dash_size,
            metric: self.settings.metric,
            h24: self.settings.time_24h,
            accel: self.settings.accel_mode,
            glass: self.settings.glass_blur,
            free: e.dash_free.filter(|_| e.dash_style == DashStyle::Compact),
        })
    }

    /// The minimap as set up (None when it's off).
    fn export_minimap(&self) -> Option<Minimap> {
        let e = &self.export;
        e.minimap.then(|| Minimap {
            corner: e.map_corner,
            size: e.map_size,
            dark: self.settings.map_dark,
            tiles: MapTiles(self.tiles.clone()),
            live: e.map_live,
            free: e.map_free,
        })
    }

    /// Where the preview is drawn: the playhead when it's inside the range,
    /// else the range's start.
    fn preview_at(&self, start: Position, end: Position) -> Position {
        let here = self.here();
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
        self.export.preview_busy = true;
        self.export.preview_again = false;
        Task::perform(
            off_thread_or(Err("The preview stopped unexpectedly.".to_string()), move || job::preview(&request, at, PREVIEW_WIDTH).map_err(|e| format!("{e:#}"))),
            |r| wrap(ExportMsg::Preview(Arc::new(r))),
        )
    }

    /// The export's size at quality `q` with the cameras chosen (Tesla
    /// Mobile's bars included): its longer side.
    fn export_widest(&self, q: Quality) -> u32 {
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
        width.max(height)
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
                | ExportMsg::DashSize(_)
                | ExportMsg::Bar(_)
                | ExportMsg::Minimap(_)
                | ExportMsg::MapCorner(_)
                | ExportMsg::Drag(..)
                | ExportMsg::MapSize(_)
                | ExportMsg::MapMode(_)
                | ExportMsg::SaveZone
                | ExportMsg::RemoveZone(_)
                | ExportMsg::RestoreZones
        );
        let task = self.export_step(m);
        if redraw {
            Task::batch([task, self.refresh_preview()])
        } else {
            task
        }
    }

    fn export_step(&mut self, m: ExportMsg) -> Task<Message> {
        match m {
            ExportMsg::Preview(result) => {
                self.export.preview_busy = false;
                self.export.preview = Some(match result.as_ref() {
                    Ok(p) => Ok(Shown { handle: iced::widget::image::Handle::from_rgba(p.shown.0, p.shown.1, p.rgba.clone()), size: p.shown, full: (p.width, p.height) }),
                    Err(e) => Err(e.clone()),
                });
                if self.export.preview_again {
                    return self.refresh_preview();
                }
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
                    self.export.dash_size = DashSize::from_key(&self.settings.export_dash_size).unwrap_or(DashSize::Medium);
                    // Last time's blur zones, offered once a session.
                    self.export.restore_offer = self.export.zones.is_empty() && !self.settings.export_blur_zones.is_empty() && !self.export.restore_answered;
                    self.export.dash_style = DashStyle::from_key(&self.settings.export_dash_style).unwrap_or(DashStyle::Compact);
                    self.export.bar_top = self.settings.export_dash_tm_top;
                    self.export.minimap = self.settings.export_minimap;
                    self.export.map_corner = Corner::from_key(&self.settings.export_minimap_position).filter(|c| MAP_CORNERS.contains(c)).unwrap_or(Corner::TopRight);
                    self.export.map_size = DashSize::from_key(&self.settings.export_minimap_size).unwrap_or(DashSize::Small);
                    self.export.map_live = self.settings.export_minimap_live;
                    self.export.dash_free = self.settings.export_dash_free;
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
                if !matches!(self.export.state, State::Choosing) {
                    self.export.open = false;
                }
            }
            ExportMsg::Camera(c) => {
                if self.export.running() {
                    return Task::none();
                }
                if let Some(i) = self.export.cameras.iter().position(|x| *x == c) {
                    self.export.cameras.remove(i);
                } else {
                    self.export.cameras.push(c);
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
            ExportMsg::DashSize(i) => {
                if let Some(z) = DashSize::ALL.get(i).filter(|_| !self.export.running()) {
                    self.export.dash_size = *z;
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
                self.export.editing = Some(Editing { camera, points, index, snapshot: shown });
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
            ExportMsg::Drag(what, to) => {
                if self.export.running() {
                    return Task::none();
                }
                match (what, to) {
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
                }
            }
            ExportMsg::MapSize(i) => {
                if let Some(z) = DashSize::ALL.get(i).filter(|_| !self.export.running()) {
                    self.export.map_size = *z;
                }
            }
            ExportMsg::MapMode(i) => {
                if !self.export.running() {
                    self.export.map_live = i == 1;
                }
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
                self.settings.export_dash_size = self.export.dash_size.key().to_string();
                self.settings.export_dash_style = self.export.dash_style.key().to_string();
                self.settings.export_dash_tm_top = self.export.bar_top;
                self.settings.export_minimap = self.export.minimap;
                if !self.export.zones.is_empty() {
                    self.settings.export_blur_zones = self.export.zones.clone();
                }
                self.settings.export_minimap_position = self.export.map_corner.key().to_string();
                self.settings.export_minimap_size = self.export.map_size.key().to_string();
                self.settings.export_minimap_live = self.export.map_live;
                self.settings.export_dash_free = self.export.dash_free;
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
                    Ok(job::Outcome::Done { bytes, seconds, frames, warnings }) => {
                        let format = self.export_format();
                        self.export.state = State::Done { output, bytes, seconds, length: frames as f64 / job::FPS as f64, format };
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
        let editor = crate::blur_editor::Editor { snapshot: edit.snapshot.as_ref(), aspect: 1448.0 / 938.0, points: &edit.points, on_change: |p| wrap(ExportMsg::ZonePoints(p)) };
        let header = row![
            text(format!("{} · {}", t("ui.export.blurZoneEditor"), edit.camera.label())).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(wrap(ExportMsg::CancelZone)),
        ]
        .align_y(Alignment::Center);
        let body = column![
            text(format!("{} {}", t("ui.export.blurZoneInstructions"), t("ui.export.blurZoneDraw"))).size(11).color(theme::TEXT_MUTED),
            iced::widget::canvas(editor).width(Length::Fill).height(520),
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
            out.push(Movable { what: Dragged::Dashboard, rect: rect(x, y, size.width, size.height), snaps });
        }
        if let Some(m) = self.export_minimap() {
            let side = m.side(w, h);
            let (x, y) = m.place(side, w, h);
            let snaps = MAP_CORNERS
                .iter()
                .map(|c| {
                    let (sx, sy) = c.place(side, side, w, h);
                    (*c, iced::Point::new(sx, sy))
                })
                .collect();
            out.push(Movable { what: Dragged::Map, rect: rect(x, y, side, side), snaps });
        }
        out
    }

    /// The finished export: what was made, a look at it, and what next.
    fn export_complete<'a>(&'a self, output: &'a std::path::Path, bytes: u64, length: f64, format: Format) -> Element<'a, Message> {
        let header = row![
            container(svg_icon(CHECK_SVG, 14.0, theme::BG)).center(26).style(|_| container::Style {
                background: Some(Background::Color(theme::SUCCESS)),
                border: Border { radius: 13.0.into(), ..Default::default() },
                ..Default::default()
            }),
            text(t("ui.notifications.exportComplete")).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(wrap(ExportMsg::Close)),
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
        ]
        .spacing(14);
        let footer = row![
            secondary(reveal_label(), Some(wrap(ExportMsg::Reveal))),
            secondary(t("ui.export.playVideo"), Some(wrap(ExportMsg::Play))),
            space().width(Length::Fill),
            primary(t("ui.settings.done"), Some(wrap(ExportMsg::Close))),
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
                let drag = PreviewDrag { frame: (full.0 as f32, full.1 as f32), items: self.movables(full.0, full.1), enabled: !e.running() };
                let mut layers = stack![picture, iced::widget::canvas(drag).width(w).height(h)];
                if e.preview_busy {
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
        let widest = self.export_widest(e.quality);
        let mb = job::bitrate(e.quality, !multi, used, widest) as f64 / 8.0 * secs / speed / 1e6;
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
        if e.preview.as_ref().is_some_and(|p| p.is_ok()) && (e.minimap || (e.dashboard && e.dash_style == DashStyle::Compact)) {
            block = block.push(text(t("ui.export.previewDragHint")).size(10).color(theme::TEXT_MUTED));
        }
        block.into()
    }

    pub(crate) fn export_dialog(&self) -> Element<'_, Message> {
        if let Some(edit) = &self.export.editing {
            return self.zone_editor(edit);
        }
        if let State::Done { output, bytes, length, format, .. } = &self.export.state {
            return self.export_complete(output, *bytes, *length, *format);
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
                r = r.push(option_card(column![row![check(on), text(c.label()).size(12).font(theme::medium(theme::INTER))].spacing(8).align_y(Alignment::Center)], on, (!busy).then_some(wrap(ExportMsg::Camera(c)))));
            }
            cams = cams.push(r);
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
        let mb_for = |f: Format| job::bitrate(e.quality, !multi, f, widest) as f64 / 8.0 * secs / speed / 1e6;
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
        if multi && chosen.contains(&Camera::Front) {
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
                let size = DashSize::ALL.iter().position(|z| *z == e.dash_size).unwrap_or(1);
                overlays = overlays.push(sub(place_and_size(place, corner_pad(&Corner::ALL, lit, !busy, ExportMsg::DashCorner), segmented(size_labels(), size, !busy, ExportMsg::DashSize))));
            }
        }
        overlays = overlays.push(labelled(
            t("ui.export.minimap"),
            t("ui.export.minimapDesc"),
            toggler(e.minimap).size(22).on_toggle_maybe((!busy).then_some(|b| wrap(ExportMsg::Minimap(b)))).style(theme::toggle).into(),
        ));
        if e.minimap {
            let (place, lit) = if e.map_free.is_some() { (t("ui.export.customPosition"), None) } else { (t(e.map_corner.label_key()), Some(e.map_corner)) };
            let size = DashSize::ALL.iter().position(|z| *z == e.map_size).unwrap_or(0);
            overlays = overlays.push(sub(place_and_size(place, corner_pad(&MAP_CORNERS, lit, !busy, ExportMsg::MapCorner), segmented(size_labels(), size, !busy, ExportMsg::MapSize))));
            let modes = vec![t("ui.export.minimapStaticFast").to_string(), t("ui.export.minimapLiveSlow").to_string()];
            overlays = overlays.push(sub(labelled(t("ui.export.minimapRenderMode"), "", segmented(modes, e.map_live as usize, !busy, ExportMsg::MapMode))));
        }

        let section = |title: String, body: Element<'static, Message>| -> Element<'static, Message> {
            column![text(title).size(13).font(theme::semibold(theme::INTER)), body].spacing(10).into()
        };
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
        privacy = privacy.push(
            row![
                container(select(cam_labels, cam_index, !busy, ExportMsg::ZoneCameraMenu, ExportMsg::ZoneCamera)).width(Length::Fill),
                secondary(t("ui.export.addZone"), (!busy && available.contains(&e.zone_camera)).then_some(wrap(ExportMsg::AddZone))),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        );
        privacy = privacy.push(text(t("ui.export.blurZoneHint")).size(10).color(theme::TEXT_MUTED));
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

        // Side by side when the window is wide enough: the preview stays in
        // view while the overlays are changed. Otherwise one column of
        // settings under the preview.
        let window = self.window_size.unwrap_or(iced::Size::new(1200.0, 800.0));
        let body_height = (window.height - 64.0 - 80.0 - 48.0).max(300.0);
        let wide = window.width >= 1060.0;
        let dialog_width = if wide { (window.width - 80.0).min(1180.0) } else { 760.0 };
        let body: Element<'_, Message> = if wide {
            let left_width = ((dialog_width - 40.0 - 24.0) * 0.58).floor();
            let left = column![
                self.preview_block((a, b), secs, speed, multi, used, (left_width, 300.0)),
                section(t("ui.export.layout").into(), cams.into()),
                section(t("ui.export.quality").into(), quality.into()),
            ]
            .spacing(20)
            .width(left_width);
            let right = column![
                section(t("ui.export.overlays").into(), overlays.into()),
                section(t("ui.export.privacy").into(), privacy.into()),
                section(t("ui.export.timelapse").into(), timelapse.into()),
            ]
            .spacing(20)
            .width(Length::Fill);
            row![scrolled(left, body_height), scrolled(right, body_height)].into()
        } else {
            let left = column![
                section(t("ui.export.layout").into(), cams.into()),
                section(t("ui.export.quality").into(), quality.into()),
                section(t("ui.export.timelapse").into(), timelapse.into())
            ]
            .spacing(20)
            .width(Length::Fill);
            let right = column![section(t("ui.export.overlays").into(), overlays.into()), section(t("ui.export.privacy").into(), privacy.into())].spacing(20).width(Length::Fill);
            let content = column![self.preview_block((a, b), secs, speed, multi, used, (720.0, 240.0)), row![left, right].spacing(24)].spacing(20);
            scrolled(content, body_height)
        };

        // Footer: the buttons, or the progress.
        let footer: Element<'_, Message> = match &e.state {
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
                column![
                    row![text(words).size(12).color(theme::TEXT_SECONDARY), space().width(Length::Fill), secondary(t("ui.export.cancel"), Some(wrap(ExportMsg::Cancel)))]
                        .align_y(Alignment::Center),
                    progress_bar(frac),
                    text(t("ui.export.minimizeHint")).size(10).color(theme::TEXT_MUTED),
                ]
                .spacing(8)
                .into()
            }
            State::Done { bytes, seconds, .. } => row![
                svg_icon(CHECK_SVG, 16.0, theme::SUCCESS),
                text(tf("ui.export.exportCompleteMB", &[("size", &format!("{:.1}", *bytes as f64 / 1e6))])).size(12).color(theme::SUCCESS),
                text(format!("{:.0} s", seconds)).size(11).color(theme::TEXT_MUTED),
                space().width(Length::Fill),
                secondary(reveal_label(), Some(wrap(ExportMsg::Reveal))),
                primary(t("ui.changelog.close"), Some(wrap(ExportMsg::Close))),
            ]
            .spacing(10)
            .align_y(Alignment::Center)
            .into(),
            State::Failed(message) => row![
                text(message.clone()).size(12).color(theme::ERROR).width(Length::Fill),
                secondary(t("ui.export.cancel"), Some(wrap(ExportMsg::Close))),
                primary(t("ui.export.exportBtn"), Some(wrap(ExportMsg::Start))),
            ]
            .spacing(10)
            .align_y(Alignment::Center)
            .into(),
            State::Idle | State::Choosing => row![
                space().width(Length::Fill),
                secondary(t("ui.export.cancel"), Some(wrap(ExportMsg::Close))),
                primary(t("ui.export.exportBtn"), (!busy && !chosen.is_empty() && secs >= 0.1).then_some(wrap(ExportMsg::Start))),
            ]
            .spacing(10)
            .align_y(Alignment::Center)
            .into(),
        };

        let header = row![
            svg_icon(DOWNLOAD_SVG, 18.0, theme::ACCENT),
            text(t("ui.export.title")).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(wrap(ExportMsg::Close)),
        ]
        .spacing(8)
        .align_y(Alignment::Center);
        let dialog = container(column![
            container(header).padding([16, 20]).style(theme::modal_header),
            container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
            body,
            container(footer).padding([16, 20]).width(Length::Fill).style(theme::modal_footer),
        ])
        .width(dialog_width)
        .clip(true)
        .style(theme::modal);
        opaque(mouse_area(container(measured(dialog)).center(Length::Fill).style(theme::backdrop)).on_press(wrap(ExportMsg::Close)))
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
    button(container(content).padding([9, 12]).width(Length::Fill).style(card_style(on)))
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
}

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
    /// What's held, and where in it the pointer took hold (preview pixels).
    held: Option<(usize, iced::Vector)>,
    hover: Option<usize>,
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
        (0..self.items.len()).rev().find(|&i| self.shown(i, scale).contains(p))
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
                state.held = Some((i, p - self.shown(i, scale).position()));
                Some(Action::capture())
            }
            Event::Mouse(M::CursorMoved { .. }) => {
                let Some((i, grip)) = state.held else {
                    let hover = cursor.position_in(bounds).and_then(|p| self.at(p, scale));
                    let changed = hover != state.hover;
                    state.hover = hover;
                    return changed.then(Action::request_redraw);
                };
                let p = cursor.position_from(bounds.position())?;
                let item = &self.items[i];
                // The new top-left in the frame's pixels, kept inside it.
                let x = ((p.x - grip.x) / scale).clamp(0.0, (self.frame.0 - item.rect.width).max(0.0));
                let y = ((p.y - grip.y) / scale).clamp(0.0, (self.frame.1 - item.rect.height).max(0.0));
                // Within 12 preview pixels of a usual place: there.
                let near = item.snaps.iter().find(|(_, s)| ((s.x - x) * scale).hypot((s.y - y) * scale) < 12.0);
                let to = match near {
                    Some((c, _)) => DragTo::Corner(*c),
                    None => DragTo::Free(x / self.frame.0, y / self.frame.1),
                };
                Some(Action::publish(wrap(ExportMsg::Drag(item.what, to))).and_capture())
            }
            Event::Mouse(M::ButtonReleased(Button::Left)) => state.held.take().map(|_| Action::capture()),
            _ => None,
        }
    }

    fn draw(&self, state: &DragState, renderer: &iced::Renderer, _: &iced::Theme, bounds: iced::Rectangle, _: iced::mouse::Cursor) -> Vec<iced::widget::canvas::Geometry> {
        use iced::widget::canvas::{Frame, Path, Stroke};
        let mut frame = Frame::new(renderer, bounds.size());
        let scale = self.scale(bounds);
        let lit = state.held.map(|(i, _)| i).or(state.hover);
        if let Some(i) = lit.filter(|i| *i < self.items.len()) {
            let r = self.shown(i, scale);
            let outline = Path::rounded_rectangle(r.position(), r.size(), 4.0.into());
            frame.fill(&outline, Color { a: 0.10, ..theme::ACCENT });
            frame.stroke(&outline, Stroke::default().with_width(1.5).with_color(theme::ACCENT));
            // While held: the usual places it snaps to.
            if state.held.is_some() {
                for (_, s) in &self.items[i].snaps {
                    frame.fill(&Path::circle(iced::Point::new(s.x * scale + 3.0, s.y * scale + 3.0), 3.0), Color { a: 0.8, ..theme::ACCENT });
                }
            }
        }
        vec![frame.into_geometry()]
    }

    fn mouse_interaction(&self, state: &DragState, bounds: iced::Rectangle, cursor: iced::mouse::Cursor) -> iced::mouse::Interaction {
        if !self.enabled {
            return iced::mouse::Interaction::default();
        }
        if state.held.is_some() {
            return iced::mouse::Interaction::Grabbing;
        }
        match cursor.position_in(bounds).and_then(|p| self.at(p, self.scale(bounds))) {
            Some(_) => iced::mouse::Interaction::Grab,
            None => iced::mouse::Interaction::default(),
        }
    }
}

/// Padded, scrolling once it's taller than `max`.
fn scrolled<'a>(content: Column<'a, Message>, max: f32) -> Element<'a, Message> {
    container(iced::widget::scrollable(container(content).padding(20)).style(theme::thin_scroll)).max_height(max).into()
}

/// A setting that belongs to the one above it: indented under it.
fn sub(content: Element<'_, Message>) -> Element<'_, Message> {
    container(content).padding(iced::Padding { left: 16.0, ..iced::Padding::ZERO }).width(Length::Fill).into()
}

/// Where an overlay goes and how big, on one line: the place in words,
/// the pad, the sizes.
fn place_and_size<'a>(place: &'a str, pad: Element<'a, Message>, sizes: Element<'a, Message>) -> Element<'a, Message> {
    row![
        column![
            text(format!("{} · {}", t("ui.export.position"), t("ui.export.size"))).size(12).font(theme::medium(theme::INTER)),
            text(place).size(10).color(theme::TEXT_MUTED),
        ]
        .spacing(2)
        .width(Length::Fill),
        pad,
        sizes,
    ]
    .spacing(10)
    .align_y(Alignment::Center)
    .into()
}

/// The overlay sizes as their share of the frame ("25%"), the same in
/// every language and short enough to sit side by side.
fn size_labels() -> Vec<String> {
    DashSize::ALL.iter().map(|z| format!("{:.0}%", z.share() * 100.0)).collect()
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
            if std::env::var_os("SENTRY_DIALOG_TESLA").is_some() {
                app.export.dash_style = crate::export::overlay::DashStyle::TeslaMobile;
            }
            let (start, end) = app.export_range().unwrap();
            let request = app.export_request(start, end, std::path::PathBuf::new()).unwrap();
            let p = crate::export::job::preview(&request, super::Position { segment: 0, secs: 10.0 }, super::PREVIEW_WIDTH).unwrap();
            app.export.preview = Some(Ok(super::Shown { handle: iced::widget::image::Handle::from_rgba(p.shown.0, p.shown.1, p.rgba), size: p.shown, full: (p.width, p.height) }));
        }
        if std::env::var_os("SENTRY_DIALOG_DONE").is_some() {
            app.export.state = super::State::Done { output: "/Users/me/Movies/Tesla 2026-11-07 08-24-23.mp4".into(), bytes: 168_800_000, seconds: 67.9, length: 179.0, format: super::Format::H264 };
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
        let r = app.movables(w, h)[0].rect;
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
        assert!((fx * w as f32 - (r.x - 90.0 / scale)).abs() < 3.0 && (fy * h as f32 - (r.y - 72.0 / scale)).abs() < 3.0);
        // Dropped next to the top-left place: snapped there.
        let r = app.movables(w, h)[0].rect;
        let target = iced::Point::new(40.0 * scale + 2.0, 40.0 * scale + 2.0);
        let grip = (r.x * scale + 5.0, r.y * scale + 5.0);
        let steps = vec![at(grip.0, grip.1), iced::Event::Mouse(M::ButtonPressed(Button::Left)), at(target.x + 5.0, target.y + 5.0), iced::Event::Mouse(M::ButtonReleased(Button::Left))];
        painter.run(&mut app, view, update, iced::Size::new(shown, 400.0), &steps);
        eprintln!("corner: {:?}, free: {:?}", app.export.dash_corner, app.export.dash_free);
        assert_eq!(app.export.dash_corner, crate::export::overlay::Corner::TopLeft);
        assert!(app.export.dash_free.is_none());
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
        let p = crate::export::job::preview(&request, super::Position { segment: 0, secs: 10.0 }, super::PREVIEW_WIDTH).unwrap();
        app.export.preview = Some(Ok(super::Shown { handle: iced::widget::image::Handle::from_rgba(p.shown.0, p.shown.1, p.rgba.clone()), size: p.shown, full: (p.width, p.height) }));
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

    #[test]
    fn export_names() {
        use super::file_name;
        assert_eq!(file_name(None, Some("2026-11-07 08:23:55")), "Tesla 2026-11-07 08-23-55.mp4");
        assert_eq!(file_name(Some("Sentry"), Some("2026-11-07 08:23:55")), "Tesla Sentry 2026-11-07 08-23-55.mp4");
        assert_eq!(file_name(Some("Road trip: day 2/3"), Some("2026-11-07 08:23:55")), "Tesla Road trip day 2 3 2026-11-07 08-23-55.mp4");
        assert_eq!(file_name(None, None), "Tesla.mp4");
    }
}
