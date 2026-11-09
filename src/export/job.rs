//! An export from start to finish: the range worked out minute by minute,
//! a thread per camera decoding ahead, each output frame drawn on the GPU
//! straight into the encoder's frame, and the samples written to the MP4.
//!
//! A camera missing for a minute shows black for that minute and stays in
//! step with the others.

use super::compose::{Compositor, Placement};
use super::encode::{EncodeSettings, FrameSink};
use super::mp4_writer::Mp4Writer;
use super::source::Source;
use crate::library::{Camera, Segment};
use crate::export::encode::Format;
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

/// Whether this system can export: macOS (VideoToolbox), Linux
/// (GStreamer) and Windows (Media Foundation).
pub const AVAILABLE: bool = cfg!(any(target_os = "macos", target_os = "linux", windows));

/// Output frames per second, whatever the footage.
pub const FPS: u32 = 36;
/// Ticks per second in the output file: one frame is 1000.
const TIMESCALE: u32 = FPS * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Mobile,
    Medium,
    High,
    Max,
}

impl Quality {
    /// Each camera's size as a share of the footage's, and a quality
    /// number (CRF) for it.
    fn factor_and_crf(self, front_only: bool) -> (f64, u32) {
        match (self, front_only) {
            (Quality::Mobile, false) => (0.40, 27),
            (Quality::Medium, false) => (0.50, 23),
            (Quality::High, false) => (0.75, 20),
            (Quality::Max, false) => (1.00, 18),
            (Quality::Mobile, true) => (0.35, 28),
            (Quality::Medium, true) => (0.50, 26),
            (Quality::High, true) => (0.75, 23),
            (Quality::Max, true) => (1.00, 20),
        }
    }
}

/// A camera's place in the output: its cell in the grid (all the same
/// size), or a place and size of its own.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    pub camera: Camera,
    pub col: u32,
    pub row: u32,
    /// Moved or resized in the editor: its left and top as shares of the
    /// grid's width and height (from the grid's top-left; outside 0-1 when
    /// moved past it), and its width as a share of the grid's width (its
    /// height keeps the camera's shape). The frame grows or shrinks to
    /// the box around everything (see export::layout).
    pub free: Option<(f32, f32, f32)>,
}

/// The plain grid: 1 → 1×1, 2 → 2×1, 3 → 3×1, 4 → 2×2, 5–6 → 3×2,
/// cameras in the given order.
pub fn grid(cameras: &[Camera]) -> Vec<Tile> {
    let cols = match cameras.len() {
        0..=3 => cameras.len().max(1),
        4 => 2,
        _ => 3,
    } as u32;
    cameras.iter().enumerate().map(|(i, &camera)| Tile { camera, col: i as u32 % cols, row: i as u32 / cols, free: None }).collect()
}

/// A point in the collection: seconds into one of its minutes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub segment: usize,
    pub secs: f64,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub segments: Vec<Segment>,
    pub start: Position,
    pub end: Position,
    pub tiles: Vec<Tile>,
    pub quality: Quality,
    /// The video format; None: H.264, or HEVC past H.264's 4096 (as
    /// earlier versions chose).
    pub format: Option<Format>,
    /// 1 for real time; 2–64 speeds up (time-lapse), 0.5 slows down.
    pub speed: f64,
    /// Back and repeater cameras flipped, as in playback.
    pub mirror: bool,
    /// The encoder's speed mode (faster, possibly a little softer).
    pub fast: bool,
    /// The burned-in recording time.
    pub timestamp: Option<super::overlay::Timestamp>,
    /// The burned-in dashboard (earlier versions never showed both).
    pub dashboard: Option<super::overlay::Dashboard>,
    /// The GPS minimap.
    pub minimap: Option<super::overlay::Minimap>,
    /// The Sentry Six watermark.
    pub watermark: Option<super::overlay::Watermark>,
    /// Blur zones (Privacy); zones on cameras not in the export are ignored.
    pub blur_zones: Vec<super::blur::BlurZone>,
    pub output: PathBuf,
}

/// What an export will make, worked out before it starts.
#[derive(Debug, Clone)]
pub struct Plan {
    /// One camera's size (in its grid cell).
    pub cell: (u32, u32),
    /// The whole picture.
    pub width: u32,
    pub height: u32,
    pub codec: Format,
    pub bitrate: u64,
    /// Where the cameras and overlays go (the frame is its box).
    pub layout: super::layout::Layout,
    /// For each output frame: the minute and the seconds into it.
    pub frames: Vec<(usize, f64)>,
}

impl Plan {
    /// Length of the exported video in seconds.
    pub fn seconds(&self) -> f64 {
        self.frames.len() as f64 / FPS as f64
    }
}

/// One camera's size in the export: the footage's size (a side camera's,
/// or the front's when it is the only one) times the quality's share.
pub fn cell_size(base: (u32, u32), quality: Quality, front_only: bool) -> (u32, u32) {
    let (factor, _) = quality.factor_and_crf(front_only);
    (make_even(base.0 as f64 * factor), make_even(base.1 as f64 * factor))
}

/// Bits per pixel that keep about the car's own quality, in H.264: Tesla
/// records a side camera at about 5.3 Mbit/s (1448x938 at 36 fps, 0.108)
/// and the front at about 10.3 (2896x1876, 0.053). High takes a little
/// less (85%) for smaller files.
fn bits_per_pixel(quality: Quality, front_only: bool) -> f64 {
    let tesla = if front_only { 0.053 } else { 0.108 };
    match quality {
        Quality::High => tesla * 0.85,
        _ => tesla,
    }
}

/// The rate in bits/s for a `width` x `height` export: the car's quality
/// for that many pixels (bits_per_pixel), and never less than earlier
/// versions' rate (8 Mbit/s at quality 18, less for lower qualities,
/// whatever the size). That is H.264's; HEVC and AV1 get their share of
/// it for about the same picture.
pub fn bitrate(quality: Quality, front_only: bool, format: Format, width: u32, height: u32) -> u64 {
    let (_, crf) = quality.factor_and_crf(front_only);
    let earlier = 8_000_000.0 * (1.0 - (crf as f64 - 18.0) * 0.03).max(0.3);
    let matched = bits_per_pixel(quality, front_only) * width as f64 * height as f64 * FPS as f64;
    ((earlier.max(matched) * format.rate_share()) / 1000.0).round() as u64 * 1000
}

fn make_even(n: f64) -> u32 {
    let r = n.round() as u32;
    r + r % 2
}

fn track_of(path: &Path) -> Option<crate::mp4::VideoTrack> {
    std::fs::File::open(path).ok().and_then(|f| crate::mp4::read_video_track(&f).ok())
}

/// A clip's length: as playback remembers it, or read from its index.
fn length_of(path: &Path) -> Option<f64> {
    crate::player::remembered_length(path).or_else(|| track_of(path).map(|t| t.duration)).filter(|d| *d > 0.0)
}

/// Each minute's length, from its front clip (or its first one), as
/// playback counts it: remembered, or read a few at a time (on a network
/// share each read waits on the round trip).
fn lengths(segments: &[Segment]) -> Vec<f64> {
    let mut out = vec![60.0; segments.len()];
    std::thread::scope(|scope| {
        for (chunk, outs) in segments.chunks(8).zip(out.chunks_mut(8)) {
            let handles: Vec<_> = chunk
                .iter()
                .map(|s| {
                    let path = s.files.get(&Camera::Front).or_else(|| s.files.values().next()).cloned();
                    scope.spawn(move || path.and_then(|p| length_of(&p)))
                })
                .collect();
            for (h, o) in handles.into_iter().zip(outs.iter_mut()) {
                if let Ok(Some(d)) = h.join() {
                    *o = d;
                }
            }
        }
    });
    out
}

/// Works out sizes, codec and every output frame's source time.
pub fn plan(req: &Request) -> Result<Plan> {
    if req.tiles.is_empty() {
        bail!("No cameras are selected.");
    }
    let (s, e) = (req.start.segment, req.end.segment);
    if s > e || e >= req.segments.len() {
        bail!("The export range is outside this clip.");
    }
    let segments = &req.segments[s..=e];
    let lengths = lengths(segments);
    // Range on a timeline that starts at minute s.
    let mut offsets = Vec::with_capacity(lengths.len());
    let mut acc = 0.0;
    for d in &lengths {
        offsets.push(acc);
        acc += d;
    }
    let from = req.start.secs.clamp(0.0, lengths[0]);
    let to = offsets[e - s] + req.end.secs.clamp(0.0, lengths[e - s]);
    if to - from < 0.05 {
        bail!("The export range is too short.");
    }
    let speed = if req.speed.is_finite() && req.speed > 0.0 { req.speed } else { 1.0 };
    let count = (((to - from) * FPS as f64 / speed) - 1e-9).ceil().max(1.0) as usize;
    let mut frames = Vec::with_capacity(count);
    let mut i = 0;
    for k in 0..count {
        let t = from + k as f64 * speed / FPS as f64;
        while i + 1 < offsets.len() && t >= offsets[i + 1] {
            i += 1;
        }
        frames.push((s + i, (t - offsets[i]).min(lengths[i])));
    }

    // The footage's sizes: a side camera's and the front's, from their
    // first clip in the range (HW4's sizes when there is none).
    let size_of = |front: bool| {
        req.tiles
            .iter()
            .filter(|t| (t.camera == Camera::Front) == front)
            .find_map(|t| segments.iter().find_map(|seg| seg.files.get(&t.camera)).and_then(|p| track_of(p)))
            .map(|t| (t.width, t.height))
    };
    let front_only = req.tiles.len() == 1 && req.tiles[0].camera == Camera::Front;
    let base = if front_only { size_of(true).unwrap_or((2896, 1876)) } else { size_of(false).or_else(|| size_of(true)).unwrap_or((1448, 938)) };
    // The frame: the box around the cameras and overlays (the grid and
    // Tesla Mobile's bars when nothing was moved). H.264 encoders stop at
    // 4096, HEVC and AV1 at 8192: a bigger layout is made smaller to fit,
    // as earlier versions' editor did.
    let overlays = super::layout::Overlays { timestamp: req.timestamp.as_ref(), dashboard: req.dashboard.as_ref(), minimap: req.minimap.as_ref(), watermark: req.watermark.as_ref() };
    let limit = req.format.unwrap_or(Format::Hevc).max_side();
    let full = cell_size(base, req.quality, front_only);
    let Some((cell, layout)) = super::layout::fitted(&req.tiles, full, overlays, limit) else {
        bail!("The layout is too big to export; the most is {limit} on a side.");
    };
    if cell != full {
        log::info!("export: the layout was too big for {limit} px; cameras {}x{} instead of {}x{}", cell.0, cell.1, full.0, full.1);
    }
    let (width, height) = layout.size();
    let codec = match req.format {
        Some(f) => f,
        None if width.max(height) <= Format::H264.max_side() => Format::H264,
        None => Format::Hevc,
    };
    let rate = bitrate(req.quality, front_only, codec, width, height);
    Ok(Plan { cell, width, height, codec, bitrate: rate, layout, frames })
}

#[derive(Debug, Clone, Copy)]
pub enum Progress {
    /// Frames written out of the total.
    Frames { done: usize, total: usize },
    /// Writing the index.
    Finishing,
}

#[derive(Debug, Clone)]
pub enum Outcome {
    /// `warnings`: translation keys for what was left out (an overlay
    /// with nothing to show).
    Done { bytes: u64, frames: usize, seconds: f64, warnings: Vec<&'static str> },
    Cancelled,
}

/// Runs an export. `cancel` stops it (the partial file is removed);
/// `progress` hears about every few frames.
pub fn run(req: &Request, cancel: &Arc<AtomicBool>, mut progress: impl FnMut(Progress)) -> Result<Outcome> {
    let started = Instant::now();
    let plan = plan(req)?;
    let total = plan.frames.len();
    log::info!(
        "export: {} camera(s), {:?}, {}x{} {:?} at {} kbit/s, {} frames ({:.1} s at {}x){}",
        req.tiles.len(),
        req.quality,
        plan.width,
        plan.height,
        plan.codec,
        plan.bitrate / 1000,
        total,
        plan.seconds(),
        req.speed,
        if req.fast { ", speed mode" } else { "" }
    );
    progress(Progress::Frames { done: 0, total });
    let mut warnings = Vec::new();
    let result = encode_all(req, &plan, cancel, &mut progress, &mut warnings, None);
    match result {
        Ok(true) => {
            let bytes = std::fs::metadata(&req.output).map(|m| m.len()).unwrap_or(0);
            let seconds = started.elapsed().as_secs_f64();
            log::info!("export: done in {seconds:.1} s ({:.1}x real time), {:.1} MB", plan.seconds() * req.speed.max(0.0) / seconds, bytes as f64 / 1e6);
            Ok(Outcome::Done { bytes, frames: total, seconds, warnings })
        }
        Ok(false) => {
            let _ = std::fs::remove_file(&req.output);
            log::info!("export: cancelled");
            Ok(Outcome::Cancelled)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&req.output);
            log::error!("export failed: {e:#}");
            Err(e)
        }
    }
}

/// A clip's GPS points, kept for the rest of the session (the preview
/// draws the map again after every change; reading a minute's points
/// over a network share takes a while).
fn clip_route(path: &Path) -> Arc<Vec<crate::map::RoutePoint>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static ROUTES: OnceLock<Mutex<HashMap<PathBuf, Arc<Vec<crate::map::RoutePoint>>>>> = OnceLock::new();
    let routes = ROUTES.get_or_init(Default::default);
    if let Some(r) = routes.lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        return r.clone();
    }
    let r = Arc::new(crate::map::clip_route(path));
    let mut routes = routes.lock().unwrap_or_else(|e| e.into_inner());
    // A few days of driving at most.
    if routes.len() >= 5000 {
        routes.clear();
    }
    routes.insert(path.to_path_buf(), r.clone());
    r
}

/// The range's route for the minimap: each minute's GPS points (every
/// sixth frame of its front clip), kept within the range. Read a few
/// minutes at a time.
fn route_points(req: &Request, plan: &Plan) -> Vec<crate::map::RoutePoint> {
    // Each minute's span in the range (seconds into it).
    let mut spans: Vec<(usize, f64, f64)> = Vec::new();
    for &(segment, t) in &plan.frames {
        match spans.last_mut() {
            Some(last) if last.0 == segment => last.2 = t,
            _ => spans.push((segment, t, t)),
        }
    }
    let mut out = Vec::new();
    for chunk in spans.chunks(8) {
        let parts: Vec<Vec<crate::map::RoutePoint>> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|&(segment, from, to)| {
                    let seg = &req.segments[segment];
                    let path = seg.files.get(&Camera::Front).or_else(|| seg.files.values().next()).cloned();
                    scope.spawn(move || {
                        let Some(path) = path else { return Vec::new() };
                        let length = length_of(&path).unwrap_or(60.0).max(0.001);
                        let points = clip_route(&path);
                        let n = points.len().max(2) - 1;
                        points.iter().copied().enumerate().filter(|(i, _)| (from - 0.5..=to + 0.5).contains(&(*i as f64 / n as f64 * length))).map(|(_, p)| p).collect()
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
        });
        out.extend(parts.into_iter().flatten());
    }
    out
}

/// Where frames go: on macOS straight into VideoToolbox's frames (no
/// copies); elsewhere (or on macOS with SENTRY_EXPORT_PORTABLE) drawn into
/// memory and handed to the system's encoder.
enum Sink {
    #[cfg(target_os = "macos")]
    Direct(super::encode::videotoolbox::Encoder),
    Memory(Box<dyn FrameSink>, Vec<u8>),
    /// A preview: the frame is drawn into memory and not encoded.
    Capture,
}

/// What the editor can move: drawn on their own in a preview, so they
/// follow the pointer over the frame without drawing it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PieceKind {
    Camera(Camera),
    Timestamp,
    /// The compact dashboard, or Tesla Mobile's data bar.
    Dashboard,
    /// Tesla Mobile's date bar.
    DateBar,
    Map,
    Watermark,
}

/// A movable piece of a preview: its picture at the preview's scale (RGBA,
/// not premultiplied).
#[derive(Debug)]
pub struct Piece {
    pub kind: PieceKind,
    pub shown: (u32, u32),
    pub rgba: Vec<u8>,
}

/// A preview frame being drawn: frame `k`, with and without the movable
/// pieces (BGRA), and the pieces.
struct Capture {
    k: usize,
    /// Also the frame without the pieces, and the pieces (for dragging).
    with_pieces: bool,
    full: Vec<u8>,
    base: Vec<u8>,
    pieces: Vec<(PieceKind, super::overlay::Picture)>,
}

/// One frame of an export as it will look, for the dialog's preview.
#[derive(Debug)]
pub struct Preview {
    /// The export's own size.
    pub width: u32,
    pub height: u32,
    /// The frame, scaled down to the size asked for (RGBA).
    pub shown: (u32, u32),
    pub rgba: Vec<u8>,
    /// The frame without the movable pieces, and the pieces.
    pub base: Vec<u8>,
    pub pieces: Vec<Piece>,
    /// Where the frame is on the layout's sheet (see export::layout), and
    /// the grid's size there (the sheet's scale).
    pub sheet: super::layout::Rect,
    pub grid: (u32, u32),
}

/// The part of a BGRA frame `width` wide at `(x, y, w, h)`, as an opaque
/// picture (RGBA).
fn crop_bgra(frame: &[u8], width: u32, (x, y, w, h): (u32, u32, u32, u32)) -> super::overlay::Picture {
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for row in y..y + h {
        let start = (row as usize * width as usize + x as usize) * 4;
        let Some(line) = frame.get(start..start + w as usize * 4) else { break };
        for px in line.chunks_exact(4) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    let h = (rgba.len() / 4 / w.max(1) as usize) as u32;
    super::overlay::Picture { width: w, height: h, rgba }
}

/// Paints `(x, y, w, h)` of a BGRA frame `width` wide black.
fn clear_bgra(frame: &mut [u8], width: u32, (x, y, w, h): (u32, u32, u32, u32)) {
    for row in y..y + h {
        let start = (row as usize * width as usize + x as usize) * 4;
        if let Some(line) = frame.get_mut(start..start + w as usize * 4) {
            for px in line.chunks_exact_mut(4) {
                px.copy_from_slice(&[0, 0, 0, 255]);
            }
        }
    }
}

/// BGRA at the export's size to RGBA at `shown`.
fn shrink(mut bgra: Vec<u8>, (w, h): (u32, u32), shown: (u32, u32)) -> Result<Vec<u8>> {
    if bgra.len() < w as usize * h as usize * 4 {
        bail!("the preview frame came back short");
    }
    bgra.truncate(w as usize * h as usize * 4);
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let full = image::RgbaImage::from_raw(w, h, bgra).ok_or_else(|| anyhow::anyhow!("bad preview frame"))?;
    Ok(if shown == (w, h) { full.into_raw() } else { image::imageops::resize(&full, shown.0, shown.1, image::imageops::FilterType::Triangle).into_raw() })
}

/// Draws the export's frame nearest `at` through the same decoding,
/// compositing, overlays and blur as the export, without encoding, and
/// scales it to at most `max_width` wide; `with_pieces`: with what
/// dragging needs too.
pub fn preview(req: &Request, at: Position, max_width: u32, with_pieces: bool) -> Result<Preview> {
    let plan = plan(req)?;
    let k = plan.frames.iter().position(|&(s, t)| s > at.segment || (s == at.segment && t >= at.secs - 0.5 / FPS as f64)).unwrap_or(plan.frames.len() - 1);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut capture = Capture { k, with_pieces, full: Vec::new(), base: Vec::new(), pieces: Vec::new() };
    encode_all(req, &plan, &cancel, &mut |_| {}, &mut Vec::new(), Some(&mut capture))?;
    let (w, h) = (plan.width, plan.height);
    let scale = (max_width as f64 / w as f64).min(1.0);
    let shown = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    let rgba = shrink(std::mem::take(&mut capture.full), (w, h), shown)?;
    let base = shrink(std::mem::take(&mut capture.base), (w, h), shown).unwrap_or_default();
    // Each piece at the preview's scale, its colours no longer premultiplied.
    let pieces = capture
        .pieces
        .into_iter()
        .filter_map(|(kind, pic)| {
            let img = image::RgbaImage::from_raw(pic.width, pic.height, pic.rgba)?;
            let size = (((pic.width as f64 * scale).round() as u32).max(1), ((pic.height as f64 * scale).round() as u32).max(1));
            let mut img = image::imageops::resize(&img, size.0, size.1, image::imageops::FilterType::Triangle);
            for px in img.pixels_mut() {
                let a = px[3] as f32 / 255.0;
                if a > 0.0 {
                    for c in 0..3 {
                        px[c] = (px[c] as f32 / a).min(255.0) as u8;
                    }
                }
            }
            Some(Piece { kind, shown: size, rgba: img.into_raw() })
        })
        .collect();
    Ok(Preview { width: w, height: h, shown, rgba, base, pieces, sheet: plan.layout.frame, grid: plan.layout.grid })
}

/// True when finished, false when cancelled; `warnings` gets what was
/// left out. `capture`: draw only frame k into the buffer (BGRA), for a
/// preview.
fn encode_all(
    req: &Request,
    plan: &Plan,
    cancel: &Arc<AtomicBool>,
    // dyn: one copy of this long function for exports and previews.
    progress: &mut dyn FnMut(Progress),
    warnings: &mut Vec<&'static str>,
    mut capture: Option<&mut Capture>,
) -> Result<bool> {
    use anyhow::anyhow;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    let compositor = Compositor::new()?;
    let settings = EncodeSettings {
        codec: plan.codec,
        width: plan.width,
        height: plan.height,
        fps: FPS as f64,
        timescale: TIMESCALE,
        bitrate: plan.bitrate,
        fast: req.fast,
    };
    let direct = cfg!(target_os = "macos") && std::env::var_os("SENTRY_EXPORT_PORTABLE").is_none() && std::env::var_os("SENTRY_EXPORT_GST").is_none();
    let mut sink = if capture.is_some() {
        Sink::Capture
    } else if direct {
        #[cfg(target_os = "macos")]
        {
            let encoder = super::encode::videotoolbox::Encoder::new(&settings)?;
            if !encoder.hardware() {
                log::warn!("export: the {:?} encoder isn't running on the GPU's media engine (slower)", plan.codec);
            }
            Sink::Direct(encoder)
        }
        #[cfg(not(target_os = "macos"))]
        unreachable!()
    } else {
        let s = super::encode::frame_sink(&settings, &req.output)?;
        log::info!("export: frames from memory to {}", s.name());
        Sink::Memory(s, Vec::new())
    };
    // Our MP4 writer, unless the encoder writes the file itself.
    let mut mp4 = match &sink {
        Sink::Memory(s, _) if s.writes_file() => None,
        Sink::Capture => None,
        _ => Some(Mp4Writer::create_with_index_space(&req.output, plan.width, plan.height, TIMESCALE, plan.frames.len())?),
    };

    // A decoding thread per camera, a few frames ahead of the encoder.
    let frames = Arc::new(match &capture {
        Some(c) => vec![plan.frames[c.k]],
        None => plan.frames.clone(),
    });
    let segments = Arc::new(req.segments.clone());
    let receivers: Vec<_> = req
        .tiles
        .iter()
        .map(|tile| {
            let (tx, rx) = mpsc::sync_channel::<Option<Arc<crate::decode::Frame>>>(6);
            let (frames, segments, cancel, camera) = (frames.clone(), segments.clone(), cancel.clone(), tile.camera);
            std::thread::Builder::new()
                .name(format!("export-{}", camera.key()))
                .spawn(move || {
                    let mut source = Source::new(camera);
                    for &(segment, t) in frames.iter() {
                        if cancel.load(Ordering::Relaxed) {
                            return;
                        }
                        if tx.send(source.frame_at(&segments, segment, t)).is_err() {
                            return;
                        }
                    }
                    log::debug!("export: {camera:?} decoded {} samples", source.decoded);
                })
                .map(|_| rx)
        })
        .collect::<std::io::Result<_>>()?;

    let cw = plan.cell.0 as f32;
    let total = frames.len();
    let layout = &plan.layout;
    // Each camera's place in the frame (x, y, width, height).
    let rects: Vec<(f32, f32, f32, f32)> = req.tiles.iter().map(|t| layout.camera(t.camera).map(|r| layout.in_frame(r)).unwrap_or_default()).collect();
    let at = |r: super::layout::Rect| {
        let (x, y, _, _) = layout.in_frame(r);
        (x, y)
    };

    // A dashboard with no telemetry anywhere in the range is left out, as
    // earlier versions did (looked for at the start of each minute and in
    // the middle of the range).
    let mut dashboard = req.dashboard;
    if capture.is_none() && dashboard.is_some_and(|d| d.style == super::overlay::DashStyle::Compact) {
        let mut probe = super::source::Telemetry::new();
        let mut seen = std::collections::HashSet::new();
        let mut points: Vec<(usize, f64)> = plan.frames.iter().copied().filter(|(s, _)| seen.insert(*s)).collect();
        points.push(plan.frames[plan.frames.len() / 2]);
        if !points.into_iter().any(|(s, t)| probe.at(&req.segments, s, t).is_some()) {
            log::warn!("export: no telemetry in this range; exporting without the dashboard");
            warnings.push("ui.notifications.noTelemetryData");
            dashboard = None;
        }
    }
    // Each camera's mask: its blur zones, and the glass under the
    // dashboard where the dashboard covers it.
    let frost = dashboard.zip(layout.dashboard).and_then(|(d, r)| {
        let (x, y, w, h) = layout.in_frame(r);
        d.frost([x, y, w, h])
    });
    let masks: Vec<Option<super::compose::BlurMask>> = req
        .tiles
        .iter()
        .zip(&rects)
        .map(|(tile, &(tx, ty, tw, _))| {
            let zones: Vec<&super::blur::BlurZone> = req.blur_zones.iter().filter(|z| z.camera == tile.camera && z.points.len() >= 3).collect();
            let privacy = (!zones.is_empty()).then(|| super::blur::mask(&zones, plan.cell.0, plan.cell.1));
            // The glass in the camera's own pixels (it may be drawn bigger
            // or smaller than a cell).
            let k = cw / tw.max(1.0);
            let glass = frost.and_then(|([x, y, w, h, r], sigma)| super::blur::rounded_mask([(x - tx) * k, (y - ty) * k, w * k, h * k, r * k], (0.0, 0.0), plan.cell.0, plan.cell.1).map(|m| (m, sigma * k)));
            if privacy.is_none() && glass.is_none() {
                return None;
            }
            let (glass, sigma) = glass.unwrap_or_default();
            Some(compositor.blur_mask(plan.cell.0, plan.cell.1, privacy.as_deref().unwrap_or(&[]), &glass, sigma))
        })
        .collect();
    // A preview's frame without the movable pieces has no glass either.
    let plain_masks: Vec<Option<super::compose::BlurMask>> = if capture.is_some() && frost.is_some() {
        req.tiles
            .iter()
            .map(|tile| {
                let zones: Vec<&super::blur::BlurZone> = req.blur_zones.iter().filter(|z| z.camera == tile.camera && z.points.len() >= 3).collect();
                (!zones.is_empty()).then(|| compositor.blur_mask(plan.cell.0, plan.cell.1, &super::blur::mask(&zones, plan.cell.0, plan.cell.1), &[], 0.0))
            })
            .collect()
    } else {
        Vec::new()
    };
    if !req.blur_zones.is_empty() || frost.is_some() {
        log::info!("export: blur zones or glass on {} camera(s)", masks.iter().filter(|m| m.is_some()).count());
    }
    // Overlays: drawn again only when what they show changes.
    let wants_overlays = req.timestamp.is_some() || dashboard.is_some() || req.minimap.is_some() || req.watermark.is_some();
    let mut painter = if wants_overlays { super::overlay::Painter::new() } else { None };
    if wants_overlays && painter.is_none() {
        log::warn!("export: no software renderer for the overlays; exporting without them");
    }
    // The watermark: drawn once, the same on every frame.
    let mut wm_picture = None;
    let watermark = match (req.watermark, layout.watermark, painter.as_mut()) {
        (Some(wm), Some(r), Some(p)) => {
            let (x, y) = at(r);
            let picture = wm.paint(p, layout.grid.0);
            let overlay = compositor.overlay(&picture, None);
            if capture.is_some() {
                wm_picture = Some(picture);
            }
            Some((overlay, x, y))
        }
        _ => None,
    };
    let mut dash_picture = None;
    let mut map_picture = None;
    let mut stamp_picture = None;
    let mut date_picture = None;
    let mut stamp: Option<(i64, super::compose::Overlay)> = None;
    let mut dash: Option<(String, super::compose::Overlay)> = None;
    let mut date_bar: Option<(String, super::compose::Overlay)> = None;
    // The dashboard's telemetry, read ahead on its own thread (a sample's
    // first few KB each frame: round trips on a network share).
    let telemetry = (dashboard.is_some() || req.minimap.is_some()).then(|| {
        let (tx, rx) = mpsc::sync_channel::<Option<crate::sei::SeiMetadata>>(256);
        let (frames, segments, cancel) = (frames.clone(), segments.clone(), cancel.clone());
        let _ = std::thread::Builder::new().name("export-telemetry".into()).spawn(move || {
            let mut reader = super::source::Telemetry::new();
            for &(segment, t) in frames.iter() {
                if cancel.load(Ordering::Relaxed) || tx.send(reader.at(&segments, segment, t)).is_err() {
                    return;
                }
            }
        });
        rx
    });
    // The wheel eases towards the telemetry's angle and the blinkers flash
    // from when they come on, frame by frame, as earlier versions did.
    let mut steering: Option<f32> = None;
    let mut blink_from: [Option<usize>; 2] = [None, None];
    let ease = 1.0 - (-45.0f32 * req.speed.max(0.01) as f32 / FPS as f32).exp();
    // The minimap: the route's map, drawn once, and the arrow on it.
    let minimap = match (&req.minimap, layout.map, painter.as_mut()) {
        (Some(mm), Some(r), Some(p)) => {
            let side = r.w as u32;
            let route = route_points(req, plan);
            match mm.fit(&route, side) {
                Some(fit) if mm.live => {
                    // Drawn frame by frame as the car moves (below).
                    let (x, y) = at(r);
                    log::info!("export: live minimap {side} px, {} route points", route.len());
                    let blank = super::overlay::Picture { width: side, height: side, rgba: vec![0; side as usize * side as usize * 4] };
                    Some((mm, fit, compositor.overlay(&blank, None), x, y, route))
                }
                Some(fit) => {
                    if !mm.fetch_tiles(&fit, std::time::Duration::from_secs(if capture.is_some() { 2 } else { 12 })) {
                        log::warn!("export: some map tiles didn't arrive in time; the minimap shows what there is");
                    }
                    let picture = mm.paint_map(p, &route, &fit);
                    let (x, y) = at(r);
                    log::info!("export: minimap {side} px at zoom {:.1}, {} route points", fit.zoom, route.len());
                    Some((mm, fit, compositor.overlay(&picture, None), x, y, route))
                }
                None => {
                    log::warn!("export: no GPS in this range; exporting without the minimap");
                    warnings.push("ui.export.minimapNoGpsDisabled");
                    None
                }
            }
        }
        _ => None,
    };
    let mut minimap = minimap;
    let mut arrow: Option<(i32, super::compose::Overlay)> = None;
    // The live map: where it was last drawn (half pixels, degrees).
    let mut live_at: Option<(i64, i64, i32)> = None;
    let mut tile_wait = std::time::Duration::ZERO;
    const TILE_WAIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);
    let mut last_report = Instant::now();
    for k in 0..total {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let mut pictures = Vec::with_capacity(req.tiles.len());
        let mut blurs = Vec::new();
        let mut plain_blurs = Vec::new();
        for (i, ((tile, rx), mask)) in req.tiles.iter().zip(&receivers).zip(&masks).enumerate() {
            let picture = rx.recv().map_err(|_| anyhow!("a camera's decoding stopped"))?;
            if let Some(p) = picture {
                let (x, y, width, height) = rects[i];
                let place = Placement { x, y, width, height, mirror: req.mirror && tile.camera.mirrored() };
                if let Some(m) = mask {
                    blurs.push((pictures.len(), m));
                }
                if let Some(Some(m)) = plain_masks.get(i) {
                    plain_blurs.push((pictures.len(), m));
                }
                pictures.push((p, place));
            }
        }
        // The recording time of this frame: its own minute's start, so it
        // is right across gaps between minutes.
        if let (Some(ts), Some(p)) = (req.timestamp, painter.as_mut()) {
            let (segment, secs) = frames[k];
            let wall = req.segments[segment].start + secs.floor() as i64;
            if stamp.as_ref().map(|(w, _)| *w) != Some(wall) {
                let picture = ts.paint(p, wall, layout.grid.0);
                if capture.is_some() {
                    stamp_picture = Some(picture.clone());
                }
                let old = stamp.take().map(|(_, o)| o);
                stamp = Some((wall, compositor.overlay(&picture, old)));
            }
        }
        let m = match telemetry.as_ref() {
            Some(rx) => rx.recv().map_err(|_| anyhow!("the telemetry reader stopped"))?,
            None => None,
        };
        let car = m.as_ref().and_then(crate::map::car);
        if let Some(d) = dashboard {
            if let Some(p) = painter.as_mut() {
                let (segment, secs) = frames[k];
                let wall = req.segments[segment].start + secs.floor() as i64;
                let target = m.as_ref().map(|m| m.steering_wheel_angle as f32).unwrap_or(0.0);
                let angle = steering.map_or(target, |a| a + (target - a) * ease);
                steering = Some(angle);
                let mut blink_ms = 0;
                for (i, on) in [m.as_ref().is_some_and(|m| m.blinker_on_left), m.as_ref().is_some_and(|m| m.blinker_on_right)].into_iter().enumerate() {
                    blink_from[i] = if on { Some(blink_from[i].unwrap_or(k)) } else { None };
                    if let Some(from) = blink_from[i] {
                        blink_ms = ((k - from) as u128 * 1000 / FPS as u128) % 700;
                    }
                }
                let state = super::overlay::DashState { telemetry: m.clone(), time: crate::dashboard::time_of_day(wall.rem_euclid(86400), d.h24), steering: angle, blink_ms };
                let signature = state.signature(d.metric);
                if dash.as_ref().map(|(s, _)| s) != Some(&signature) {
                    let picture = match (d.style, layout.dashboard) {
                        (super::overlay::DashStyle::TeslaMobile, Some(r)) => super::tesla_mobile::paint_data(p, r.w as u32, r.h as u32, &state, d.metric, !d.bar_on_top(), (d.sizes.label, d.sizes.value)),
                        _ => d.paint(p, &state, layout.grid.0),
                    };
                    if capture.is_some() {
                        dash_picture = Some(picture.clone());
                    }
                    let old = dash.take().map(|(_, o)| o);
                    dash = Some((signature, compositor.overlay(&picture, old)));
                }
                if let (super::overlay::DashStyle::TeslaMobile, Some(r)) = (d.style, layout.date_bar) {
                    let line = super::tesla_mobile::date_line(wall, d.h24);
                    if date_bar.as_ref().map(|(l, _)| l) != Some(&line) {
                        let picture = super::tesla_mobile::paint_date(p, r.w as u32, r.h as u32, &line, d.sizes.date);
                        if capture.is_some() {
                            date_picture = Some(picture.clone());
                        }
                        let old = date_bar.take().map(|(_, o)| o);
                        date_bar = Some((line, compositor.overlay(&picture, old)));
                    }
                }
            }
        }
        let mut overlays = Vec::new();
        // Which overlays the editor moves (left out of a preview's base).
        let mut kinds: Vec<Option<(PieceKind, f32, f32)>> = Vec::new();
        if let (Some((_, o)), Some(r)) = (stamp.as_ref(), layout.timestamp) {
            let (x, y) = at(r);
            overlays.push((o, x, y));
            kinds.push(Some((PieceKind::Timestamp, x, y)));
        }
        if let (Some(_), Some((_, o)), Some(r)) = (dashboard, dash.as_ref(), layout.dashboard) {
            let (x, y) = at(r);
            overlays.push((o, x, y));
            kinds.push(Some((PieceKind::Dashboard, x, y)));
        }
        if let (Some((_, o)), Some(r)) = (date_bar.as_ref(), layout.date_bar) {
            let (x, y) = at(r);
            overlays.push((o, x, y));
            kinds.push(Some((PieceKind::DateBar, x, y)));
        }
        // The live map: drawn again when the car moves half a pixel or turns.
        if let (Some((mm, _, map_overlay, _, _, route)), Some((lat, lon, heading)), Some(p)) = (minimap.as_mut(), car, painter.as_mut()) {
            if mm.live {
                let side = map_overlay.width;
                let (fit, _) = mm.follow(lat, lon, side);
                let world_px = 256.0 * 2f64.powf(fit.zoom as f64) * 2.0;
                let key = ((fit.center.0 * world_px).round() as i64, (fit.center.1 * world_px).round() as i64, heading.round() as i32);
                if live_at != Some(key) {
                    live_at = Some(key);
                    // Waiting for tiles: 3 s at a time, 15 s for the whole
                    // export. Offline, or with the tile server down, the
                    // map then draws with what there is instead of
                    // waiting at every redraw.
                    if tile_wait < TILE_WAIT_BUDGET && mm.tiles_ready(&fit) != Some(true) {
                        let began = Instant::now();
                        let wait = (TILE_WAIT_BUDGET - tile_wait).min(std::time::Duration::from_secs(3));
                        let ready = mm.fetch_tiles(&fit, wait);
                        tile_wait += began.elapsed();
                        if !ready && tile_wait >= TILE_WAIT_BUDGET {
                            log::warn!("export: map tiles aren't arriving; the minimap shows what there is from here on");
                        }
                    }
                    let picture = mm.paint_map_with(p, route, &fit, Some((lat, lon, heading)), side);
                    if capture.is_some() {
                        map_picture = Some(picture.clone());
                    }
                    let old = std::mem::replace(map_overlay, compositor.overlay(&picture, None));
                    drop(old);
                }
            }
        }
        if let Some((mm, fit, map_overlay, mx, my, _)) = minimap.as_ref() {
            overlays.push((map_overlay, *mx, *my));
            kinds.push(Some((PieceKind::Map, *mx, *my)));
            if let (Some((lat, lon, heading)), Some(p)) = (car.filter(|_| !mm.live), painter.as_mut()) {
                let a = mm.arrow_side(fit);
                let deg = heading.round() as i32;
                if arrow.as_ref().map(|(h, _)| *h) != Some(deg) {
                    let picture = mm.paint_arrow(p, deg as f32, a);
                    let old = arrow.take().map(|(_, o)| o);
                    arrow = Some((deg, compositor.overlay(&picture, old)));
                }
                let (px, py) = fit.pixel_of(lat, lon);
                let half = a as f32 / 2.0;
                // Only while the car is on the map.
                if px >= half && py >= half && px <= fit.side as f32 - half && py <= fit.side as f32 - half {
                    if let Some((_, o)) = arrow.as_ref() {
                        overlays.push((o, mx + px - half, my + py - half));
                        kinds.push(Some((PieceKind::Map, f32::NAN, f32::NAN)));
                    }
                }
            }
        }
        // The watermark over everything (Tesla Mobile's bars included).
        if let Some((o, x, y)) = watermark.as_ref() {
            overlays.push((o, *x, *y));
            kinds.push(Some((PieceKind::Watermark, *x, *y)));
        }
        let packets = match &mut sink {
            #[cfg(target_os = "macos")]
            Sink::Direct(encoder) => {
                let target = encoder.frame()?;
                compositor.draw_frame(&target, &pictures, &blurs, &overlays)?;
                encoder.encode(&target, k as i64 * 1000, 1000)?;
                encoder.take()
            }
            Sink::Memory(encoder, bytes) => {
                compositor.draw_to_bytes(plan.width, plan.height, &pictures, &blurs, &overlays, bytes)?;
                encoder.push_bgra(bytes, k as i64 * 1000, 1000)?;
                encoder.take()
            }
            Sink::Capture => {
                if let Some(c) = capture.as_mut() {
                    compositor.draw_to_bytes(plan.width, plan.height, &pictures, &blurs, &overlays, &mut c.full)?;
                }
                if let Some(c) = capture.as_mut().filter(|c| c.with_pieces) {
                    // Without the movable pieces (or the dashboard's glass).
                    let base: Vec<_> = overlays.iter().zip(&kinds).filter(|(_, k)| k.is_none()).map(|(o, _)| *o).collect();
                    let base_blurs = if plain_masks.is_empty() { &blurs } else { &plain_blurs };
                    compositor.draw_to_bytes(plan.width, plan.height, &pictures, base_blurs, &base, &mut c.base)?;
                    // Each camera as a piece of its own (first, so the
                    // overlays sit over them), and the base without them.
                    for (tile, (x, y, w, h)) in req.tiles.iter().zip(&rects) {
                        let picture = crop_bgra(&c.base, plan.width, (*x as u32, *y as u32, *w as u32, *h as u32));
                        c.pieces.push((PieceKind::Camera(tile.camera), picture));
                    }
                    for (x, y, w, h) in &rects {
                        clear_bgra(&mut c.base, plan.width, (*x as u32, *y as u32, *w as u32, *h as u32));
                    }
                    for (kind, x, _) in kinds.iter().flatten() {
                        let picture = match kind {
                            PieceKind::Timestamp => stamp_picture.take(),
                            PieceKind::Dashboard => dash_picture.take(),
                            PieceKind::DateBar => date_picture.take(),
                            PieceKind::Map if x.is_finite() => map_picture.take(),
                            PieceKind::Watermark => wm_picture.take(),
                            _ => None,
                        };
                        if let Some(p) = picture {
                            c.pieces.push((*kind, p));
                        }
                    }
                }
                Vec::new()
            }
        };
        if let Some(mp4) = mp4.as_mut() {
            for p in packets {
                mp4.write_frame(&p.data, 1000, p.sync, p.pts)?;
            }
        }
        if last_report.elapsed().as_millis() >= 100 || k + 1 == total {
            last_report = Instant::now();
            progress(Progress::Frames { done: k + 1, total });
        }
    }
    if matches!(sink, Sink::Capture) {
        return Ok(true);
    }
    progress(Progress::Finishing);
    let finished = match sink {
        #[cfg(target_os = "macos")]
        Sink::Direct(encoder) => {
            let (rest, config) = encoder.finish()?;
            super::encode::Finished::Packets(rest, config)
        }
        Sink::Memory(encoder, _) => encoder.finish()?,
        Sink::Capture => unreachable!(),
    };
    match (finished, mp4) {
        (super::encode::Finished::Packets(rest, config), Some(mut mp4)) => {
            for p in rest {
                mp4.write_frame(&p.data, 1000, p.sync, p.pts)?;
            }
            if mp4.samples() != total {
                bail!("the encoder returned {} of {total} frames", mp4.samples());
            }
            mp4.finish(&config)?;
        }
        // Written by the encoder (Media Foundation): its index goes first.
        (super::encode::Finished::File, None) => super::mp4_writer::fast_start(&req.output)?,
        _ => bail!("the encoder and the MP4 writer disagree about who writes the file"),
    }
    Ok(true)
}

#[cfg(test)]
mod rate_tests {
    use super::*;

    #[test]
    fn rates_follow_the_cars_quality() {
        let mbit = |q, f, w, h| bitrate(q, false, f, w, h) as f64 / 1e6;
        // Six cameras: Mobile keeps earlier versions' rate (above the car's).
        assert!((mbit(Quality::Mobile, Format::H264, 1740, 752) - 5.84).abs() < 0.01);
        assert!((mbit(Quality::Medium, Format::H264, 2172, 940) - 7.94).abs() < 0.05);
        assert!((mbit(Quality::High, Format::H264, 3258, 1408) - 15.16).abs() < 0.05);
        // HEVC: the same picture for less with B-frames (see Format::rate_share).
        let hevc = Format::Hevc.rate_share();
        assert!((mbit(Quality::High, Format::Hevc, 3258, 1408) - 15.16 * hevc).abs() < 0.05);
        assert!((mbit(Quality::Max, Format::Hevc, 4344, 1876) - 31.69 * hevc).abs() < 0.05);
        // The front camera alone at full size: the car's own 10.4 Mbit/s.
        assert!((bitrate(Quality::Max, true, Format::H264, 2896, 1876) as f64 / 1e6 - 10.37).abs() < 0.05);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::library::Segment;
    use std::collections::BTreeMap;
    use std::sync::atomic::Ordering;

    fn decode_all(path: &Path) -> Vec<Vec<u8>> {
        let file = std::fs::File::open(path).unwrap();
        let track = crate::mp4::read_video_track(&file).unwrap();
        let mut dec = crate::decode::Decoder::new(&track).unwrap();
        let mut reader = crate::reader::WindowReader::new(file).unwrap();
        let mut out = Vec::new();
        for s in &track.samples {
            let data = reader.read(s.offset, s.size as usize).unwrap();
            if let Some(f) = dec.decode(data).unwrap() {
                out.push(f.with_planes(|y, _| (0..y.height as usize).flat_map(|r| y.data[r * y.stride..r * y.stride + y.width as usize].to_vec()).collect()).unwrap());
            }
        }
        out
    }

    /// Two minutes: front and back in the first, only the front in the
    /// second. The back's tile goes black for the second minute, the front
    /// carries on in step, and a 4x time-lapse makes a quarter the frames.
    #[test]
    fn minutes_join_and_missing_cameras_go_black() {
        let dir = std::env::temp_dir().join(format!("sentry-studio-job-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h, n) = (320usize, 240usize, 72usize); // 2 s a minute, to keep it quick
        // Brightness tells the minutes apart: front 60 then 120, back 200.
        let flat = |v: u8| move |_: usize, _: usize, _: usize| [v, v, v, 255];
        crate::export::testing::clip(&dir.join("f0.mp4"), w, h, n, flat(60));
        crate::export::testing::clip(&dir.join("b0.mp4"), w, h, n, flat(200));
        crate::export::testing::clip(&dir.join("f1.mp4"), w, h, n, flat(120));
        let seg = |start: i64, files: &[(Camera, &str)]| Segment { start, files: files.iter().map(|(c, f)| (*c, dir.join(f))).collect::<BTreeMap<_, _>>() };
        let segments = vec![seg(0, &[(Camera::Front, "f0.mp4"), (Camera::Back, "b0.mp4")]), seg(60, &[(Camera::Front, "f1.mp4")])];
        let out = dir.join("out.mp4");
        let mut req = Request {
            segments,
            start: Position { segment: 0, secs: 0.5 },
            end: Position { segment: 1, secs: 1.5 },
            tiles: grid(&[Camera::Front, Camera::Back]),
            quality: Quality::Max,
            format: None,
            speed: 1.0,
            mirror: true,
            fast: false,
            timestamp: None,
            dashboard: None,
            minimap: None,
            watermark: None,
            blur_zones: Vec::new(),
            output: out.clone(),
        };
        let p = plan(&req).unwrap();
        assert_eq!((p.cell, p.width, p.height, p.codec), ((320, 240), 640, 240, Format::H264));
        // 1.5 s of the first minute and 1.5 s of the second.
        assert_eq!(p.frames.len(), 108);
        let cancel = Arc::new(AtomicBool::new(false));
        let mut last = None;
        let outcome = run(&req, &cancel, |p| last = Some(p)).unwrap();
        assert!(matches!(outcome, Outcome::Done { frames: 108, .. }), "{outcome:?}");
        assert!(matches!(last, Some(Progress::Finishing)));
        let luma = |f: &Vec<u8>, x: usize| f[120 * 640 + x] as i32;
        let frames = decode_all(&out);
        assert_eq!(frames.len(), 108);
        // Limited-range luma: 60 → ~68, 120 → ~119, 200 → ~188, black 16.
        let (a, b) = (&frames[10], &frames[100]);
        assert!((luma(a, 160) - 68).abs() < 12 && (luma(a, 480) - 188).abs() < 12, "minute 1: {} {}", luma(a, 160), luma(a, 480));
        assert!((luma(b, 160) - 119).abs() < 12 && luma(b, 480) < 24, "minute 2: {} {}", luma(b, 160), luma(b, 480));
        // Faststart: the index comes before the pictures.
        let head = std::fs::read(&out).unwrap();
        let moov = head.windows(4).position(|w| w == b"moov").unwrap();
        let mdat = head.windows(4).position(|w| w == b"mdat").unwrap();
        assert!(moov < mdat, "moov at {moov}, mdat at {mdat}");

        req.speed = 4.0;
        let p = plan(&req).unwrap();
        assert_eq!(p.frames.len(), 27);
        assert!(matches!(run(&req, &cancel, |_| {}).unwrap(), Outcome::Done { frames: 27, .. }));
        assert_eq!(decode_all(&out).len(), 27);

        // Cancelling removes the partial file.
        cancel.store(true, Ordering::Relaxed);
        assert!(matches!(run(&req, &cancel, |_| {}).unwrap(), Outcome::Cancelled));
        assert!(!out.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole export on real footage, or on six stand-in clips: a folder
    /// with cam0.mp4 (front) .. cam5.mp4 as one minute (cargo test --release
    /// job_speed -- --ignored --nocapture, with SENTRY_EXPORT_CLIPS).
    #[test]
    #[ignore]
    fn job_speed() {
        let Some(dir) = std::env::var_os("SENTRY_EXPORT_CLIPS").map(std::path::PathBuf::from) else { return };
        let cams = [Camera::Front, Camera::Back, Camera::LeftRepeater, Camera::RightRepeater, Camera::LeftPillar, Camera::RightPillar];
        let files: BTreeMap<_, _> = cams.iter().enumerate().map(|(i, c)| (*c, dir.join(format!("cam{i}.mp4")))).collect();
        let segments = vec![Segment { start: 0, files }];
        let length = track_of(&dir.join("cam0.mp4")).unwrap().duration;
        // Playback's layout: pillars and front on top, repeaters and back below.
        let tiles: Vec<Tile> = crate::library::GRID.iter().enumerate().map(|(i, &camera)| Tile { camera, col: i as u32 % 3, row: i as u32 / 3, free: None }).collect();
        let out = std::env::temp_dir().join(format!("sentry-studio-jobspeed-{}.mp4", std::process::id()));
        for (quality, speed, fast) in [(Quality::High, 1.0, false), (Quality::High, 1.0, true), (Quality::Max, 1.0, true), (Quality::Medium, 1.0, true), (Quality::High, 8.0, true)] {
            let req = Request {
                segments: segments.clone(),
                start: Position { segment: 0, secs: 0.0 },
                end: Position { segment: 0, secs: length },
                tiles: tiles.clone(),
                quality,
                format: None,
                speed,
                mirror: true,
                fast,
                timestamp: Some(super::super::overlay::Timestamp { corner: super::super::overlay::Corner::BottomCenter, date_format: crate::settings::DateFormat::Ymd, h24: false, free: None, scale: 1.0 }),
                dashboard: None,
                minimap: None,
            watermark: None,
                blur_zones: Vec::new(),
                output: out.clone(),
            };
            let p = plan(&req).unwrap();
            let Outcome::Done { bytes, seconds, .. } = run(&req, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap() else { panic!() };
            println!(
                "{quality:?} {}x{} {:?}{} at {speed}x: {length:.0} s of footage in {seconds:.2} s = {:.1}x real time, {:.1} MB",
                p.width,
                p.height,
                p.codec,
                if fast { " (speed mode)" } else { "" },
                length / seconds,
                bytes as f64 / 1e6
            );
        }
        let _ = std::fs::remove_file(&out);
    }

    /// A front clip with telemetry, exported with the dashboard: the bar
    /// sits 40 px above the bottom, centred, over the picture.
    #[test]
    fn dashboard_burns_in() {
        let dir = std::env::temp_dir().join(format!("sentry-studio-dash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h, n) = (640usize, 480usize, 36usize);
        let front = dir.join("front.mp4");
        crate::export::testing::clip_with_telemetry(&front, w, h, n, |_, _, _| [235, 235, 235, 255], |k| {
            Some(crate::sei::SeiMetadata { gear_state: 1, vehicle_speed_mps: 20.0 + k as f64 * 0.1, autopilot_state: 1, blinker_on_left: true, ..Default::default() })
        });
        let out = dir.join("out.mp4");
        let req = Request {
            segments: vec![Segment { start: 43_200, files: [(Camera::Front, front)].into_iter().collect() }],
            start: Position { segment: 0, secs: 0.0 },
            end: Position { segment: 0, secs: 1.0 },
            tiles: grid(&[Camera::Front]),
            quality: Quality::Max,
            format: None,
            speed: 1.0,
            mirror: false,
            fast: false,
            timestamp: None,
            dashboard: Some(super::super::overlay::Dashboard {
                style: super::super::overlay::DashStyle::Compact,
                corner: super::super::overlay::Corner::BottomCenter,
                share: super::super::overlay::DashSize::Medium.share(),
                metric: false,
                h24: false,
                accel: crate::dashboard::AccelMode::IconBar,
                glass: 0.0,
                free: None,
                data_bar: None,
                date_bar: None,
                sizes: Default::default(),
            }),
            minimap: None,
            watermark: None,
            blur_zones: Vec::new(),
            output: out.clone(),
        };
        assert!(matches!(run(&req, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap(), Outcome::Done { frames: 36, .. }));
        let frames = decode_all(&out);
        let f = &frames[18];
        // 560 x 65 bar (the frame less 80 px), its top at 480 - 40 - 65.
        let y = |row: usize| f[row * w + 100] as i32;
        assert!(y(200) > 180, "picture above: {}", y(200));
        assert!(y(375 + 32) < 110, "bar: {}", y(375 + 32));
        assert!(y(470) > 180, "picture below the bar: {}", y(470));
        if let Some(path) = std::env::var_os("SENTRY_DUMP_OVERLAY") {
            ::image::GrayImage::from_raw(w as u32, h as u32, f.clone()).unwrap().save(path).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A front clip driving north-east, exported with the
    /// minimap (real tiles: needs the network). Writes the export to
    /// SENTRY_DUMP_OVERLAY to look at (cargo test --release
    /// minimap_burns_in -- --ignored).
    #[test]
    #[ignore]
    fn minimap_burns_in() {
        let dir = std::env::temp_dir().join(format!("sentry-studio-map-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h, n) = (960usize, 720usize, 72usize);
        let front = dir.join("front.mp4");
        crate::export::testing::clip_with_telemetry(&front, w, h, n, |_, x, y| [(x / 4) as u8, (y / 3) as u8, 90, 255], |k| {
            Some(crate::sei::SeiMetadata { gear_state: 1, vehicle_speed_mps: 15.0, latitude_deg: 40.0000 + k as f64 * 0.00012, longitude_deg: -100.0000 + k as f64 * 0.00005, heading_deg: 20.0, ..Default::default() })
        });
        let out = std::env::var_os("SENTRY_DUMP_OVERLAY").map(std::path::PathBuf::from).unwrap_or_else(|| dir.join("out.mp4"));
        let req = Request {
            segments: vec![Segment { start: 43_200, files: [(Camera::Front, front)].into_iter().collect() }],
            start: Position { segment: 0, secs: 0.0 },
            end: Position { segment: 0, secs: 2.0 },
            tiles: grid(&[Camera::Front]),
            quality: Quality::Max,
            format: None,
            speed: 1.0,
            mirror: false,
            fast: false,
            timestamp: None,
            dashboard: None,
            minimap: Some(super::super::overlay::Minimap {
                corner: super::super::overlay::Corner::TopRight,
                share: super::super::overlay::DashSize::XLarge.share(),
                dark: false,
                tiles: super::super::overlay::MapTiles(crate::map::tiles::Tiles::new(Some(dir.join("map")))),
                live: std::env::var("SENTRY_DUMP_LIVE").is_ok(),
                free: None,
            }),
            watermark: None,
            blur_zones: Vec::new(),
            output: out.clone(),
        };
        let started = std::time::Instant::now();
        assert!(matches!(run(&req, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap(), Outcome::Done { frames: 72, .. }));
        println!("minimap export in {:.1} s: {}", started.elapsed().as_secs_f64(), out.display());
    }

    /// Front over back (both made smaller), with Tesla Mobile's data bar
    /// moved under them: the export is the box around them, tall, and
    /// each is where the layout put it.
    #[test]
    fn moved_layout_exports_its_box() {
        let dir = std::env::temp_dir().join(format!("sentry-studio-moved-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h, n) = (320usize, 240usize, 18usize);
        let flat = |v: u8| move |_: usize, _: usize, _: usize| [v, v, v, 255];
        crate::export::testing::clip(&dir.join("f.mp4"), w, h, n, flat(60));
        crate::export::testing::clip(&dir.join("b.mp4"), w, h, n, flat(200));
        let out = dir.join("out.mp4");
        let mut tiles = grid(&[Camera::Front, Camera::Back]);
        // Cells 320 x 240, grid 640 x 240, on a 16:9 canvas from -58 to
        // 302: each 0.3 of 640 = 192 x 144.
        tiles[0].free = Some((0.0, -54.0 / 240.0, 0.3));
        tiles[1].free = Some((0.0, 90.0 / 240.0, 0.3));
        let dashboard = super::super::overlay::Dashboard {
            style: super::super::overlay::DashStyle::TeslaMobile,
            corner: super::super::overlay::Corner::BottomCenter,
            share: 0.35,
            metric: false,
            h24: false,
            accel: crate::dashboard::AccelMode::IconBar,
            glass: 0.0,
            free: None,
            data_bar: Some((0.0, 234.0 / 240.0, 0.3)),
            date_bar: Some((0.0, -58.0 / 240.0, 0.3)),
            sizes: Default::default(),
        };
        let req = Request {
            segments: vec![Segment { start: 0, files: [(Camera::Front, dir.join("f.mp4")), (Camera::Back, dir.join("b.mp4"))].into_iter().collect() }],
            start: Position { segment: 0, secs: 0.0 },
            end: Position { segment: 0, secs: 0.4 },
            tiles,
            quality: Quality::Max,
            format: None,
            speed: 1.0,
            mirror: false,
            fast: false,
            timestamp: None,
            dashboard: Some(dashboard),
            minimap: None,
            watermark: None,
            blur_zones: Vec::new(),
            output: out.clone(),
        };
        let p = plan(&req).unwrap();
        let l = &p.layout;
        // Date bar 192 x 4 at -58, front at -54, back at 90, data bar
        // 192 x 6 at 234: 192 wide, -58 to 240.
        assert_eq!((l.in_frame(l.date_bar.unwrap()), l.in_frame(l.camera(Camera::Front).unwrap()), l.in_frame(l.camera(Camera::Back).unwrap())), ((0.0, 0.0, 192.0, 4.0), (0.0, 4.0, 192.0, 144.0), (0.0, 148.0, 192.0, 144.0)));
        assert_eq!(l.in_frame(l.dashboard.unwrap()), (0.0, 292.0, 192.0, 6.0));
        assert_eq!((p.width, p.height), (192, 298));
        assert!(matches!(run(&req, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap(), Outcome::Done { .. }));
        let frames = decode_all(&out);
        let luma = |y: usize| frames[5][y * 192 + 96] as i32;
        // Limited-range luma: front ~68, back ~188.
        assert!((luma(70) - 68).abs() < 12 && (luma(220) - 188).abs() < 12, "front {} back {}", luma(70), luma(220));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grids_have_their_shapes() {
        let cams = [Camera::Front, Camera::Back, Camera::LeftRepeater, Camera::RightRepeater, Camera::LeftPillar, Camera::RightPillar];
        let size = |n: usize| {
            let t = grid(&cams[..n]);
            (t.iter().map(|t| t.col).max().unwrap() + 1, t.iter().map(|t| t.row).max().unwrap() + 1)
        };
        assert_eq!([size(1), size(2), size(3), size(4), size(5), size(6)], [(1, 1), (2, 1), (3, 1), (2, 2), (3, 2), (3, 2)]);
        assert_eq!((make_even(1086.0), make_even(703.5), make_even(469.0)), (1086, 704, 470));
    }
}
