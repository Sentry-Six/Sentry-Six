//! An export from start to finish: the range worked out minute by minute,
//! a thread per camera decoding ahead, each output frame drawn on the GPU
//! straight into the encoder's frame, and the samples written to the MP4.
//!
//! Sizes, quality and time-lapse follow Electron Studio's export (see
//! docs/native-studio/export-spec.md); unlike it, a camera missing for a
//! minute shows black for that minute and stays in step with the others.

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

/// Output frames per second, whatever the footage (as Electron).
pub const FPS: u32 = 36;
/// Ticks per second in the output file: one frame is 1000.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const TIMESCALE: u32 = FPS * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Mobile,
    Medium,
    High,
    Max,
}

impl Quality {
    /// Each camera's size as a share of the footage's, and Electron's
    /// quality number (CRF) for it.
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

/// A camera's place in the output, in whole tiles (all the same size).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tile {
    pub camera: Camera,
    pub col: u32,
    pub row: u32,
}

/// Electron's plain grid: 1 → 1×1, 2 → 2×1, 3 → 3×1, 4 → 2×2, 5–6 → 3×2,
/// cameras in the given order.
pub fn grid(cameras: &[Camera]) -> Vec<Tile> {
    let cols = match cameras.len() {
        0..=3 => cameras.len().max(1),
        4 => 2,
        _ => 3,
    } as u32;
    cameras.iter().enumerate().map(|(i, &camera)| Tile { camera, col: i as u32 % cols, row: i as u32 / cols }).collect()
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
    /// Blur zones (Privacy); zones on cameras not in the export are ignored.
    pub blur_zones: Vec<super::blur::BlurZone>,
    pub output: PathBuf,
}

/// What an export will make, worked out before it starts.
#[derive(Debug, Clone)]
pub struct Plan {
    /// One camera's size.
    pub cell: (u32, u32),
    /// The whole picture.
    pub width: u32,
    pub height: u32,
    pub codec: Format,
    pub bitrate: u64,
    /// Where the cameras start, and the bars Tesla Mobile adds (date
    /// bar on top, data bar above or below the cameras), in pixels.
    pub video_top: u32,
    pub date_bar: u32,
    pub data_bar: u32,
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

/// The rate in bits/s for a frame whose longer side is `widest`.
/// Earlier versions' rate (8 Mbit/s at quality 18, less for lower
/// qualities, whatever the size) is H.264's; HEVC and AV1 get their
/// share of it for about the same picture. Past 4096, where earlier
/// versions switched to HEVC at that rate, it is HEVC's instead.
pub fn bitrate(quality: Quality, front_only: bool, format: Format, widest: u32) -> u64 {
    let (_, crf) = quality.factor_and_crf(front_only);
    let earlier = 8000.0 * (1.0 - (crf as f64 - 18.0) * 0.03).max(0.3);
    let reference = if widest > Format::H264.max_side() { Format::Hevc.rate_share() } else { 1.0 };
    (earlier * format.rate_share() / reference).round() as u64 * 1000
}

fn make_even(n: f64) -> u32 {
    let r = n.round() as u32;
    r + r % 2
}

fn track_of(path: &Path) -> Option<crate::mp4::VideoTrack> {
    std::fs::File::open(path).ok().and_then(|f| crate::mp4::read_video_track(&f).ok())
}

/// Each minute's length, from its front clip (or its first one), as
/// playback counts it. The index reads run a few at a time: on a network
/// share each one waits on the round trip.
fn lengths(segments: &[Segment]) -> Vec<f64> {
    let mut out = vec![60.0; segments.len()];
    std::thread::scope(|scope| {
        for (chunk, outs) in segments.chunks(8).zip(out.chunks_mut(8)) {
            let handles: Vec<_> = chunk
                .iter()
                .map(|s| {
                    let path = s.files.get(&Camera::Front).or_else(|| s.files.values().next()).cloned();
                    scope.spawn(move || path.and_then(|p| track_of(&p)).map(|t| t.duration).filter(|d| *d > 0.0))
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
    // first clip in the range (Electron's defaults when there is none).
    let size_of = |front: bool| {
        req.tiles
            .iter()
            .filter(|t| (t.camera == Camera::Front) == front)
            .find_map(|t| segments.iter().find_map(|seg| seg.files.get(&t.camera)).and_then(|p| track_of(p)))
            .map(|t| (t.width, t.height))
    };
    let front_only = req.tiles.len() == 1 && req.tiles[0].camera == Camera::Front;
    let base = if front_only { size_of(true).unwrap_or((2896, 1876)) } else { size_of(false).or_else(|| size_of(true)).unwrap_or((1448, 938)) };
    let cell = cell_size(base, req.quality, front_only);
    let cols = req.tiles.iter().map(|t| t.col).max().unwrap_or(0) + 1;
    let rows = req.tiles.iter().map(|t| t.row).max().unwrap_or(0) + 1;
    let (width, video_height) = (cell.0 * cols, cell.1 * rows);
    // Tesla Mobile adds its bars to the frame.
    let (date_bar, data_bar, video_top) = match req.dashboard {
        Some(d) if d.style == super::overlay::DashStyle::TeslaMobile => {
            let (date, data) = super::tesla_mobile::bar_heights(width);
            (date, data, date + if d.bar_on_top() { data } else { 0 })
        }
        _ => (0, 0, 0),
    };
    let height = video_height + date_bar + data_bar;
    // H.264 encoders stop at 4096; HEVC and AV1 go to 8192.
    let widest = width.max(height);
    let codec = match req.format {
        Some(f) if widest > f.max_side() => bail!("{width}×{height} is too big for {}; the most is {} on a side.", f.label(), f.max_side()),
        Some(f) => f,
        None if widest <= Format::H264.max_side() => Format::H264,
        None if widest <= Format::Hevc.max_side() => Format::Hevc,
        None => bail!("The layout is too big to export ({width}×{height}); the most is 8192 on a side."),
    };
    Ok(Plan { cell, width, height, codec, bitrate: bitrate(req.quality, front_only, codec, widest), video_top, date_bar, data_bar, frames })
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

/// The range's route for the minimap: each minute's GPS points (every
/// sixth frame of its front clip), kept within the range. Read a few
/// minutes at a time.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
                        let length = track_of(&path).map(|t| t.duration).unwrap_or(60.0).max(0.001);
                        let points = crate::map::clip_route(&path);
                        let n = points.len().max(2) - 1;
                        points.into_iter().enumerate().filter(|(i, _)| (from - 0.5..=to + 0.5).contains(&(*i as f64 / n as f64 * length))).map(|(_, p)| p).collect()
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

/// One frame of an export as it will look, for the dialog's preview.
#[derive(Debug)]
pub struct Preview {
    /// The export's own size.
    pub width: u32,
    pub height: u32,
    /// The frame, scaled down to the size asked for (RGBA).
    pub shown: (u32, u32),
    pub rgba: Vec<u8>,
}

/// Draws the export's frame nearest `at` through the same decoding,
/// compositing, overlays and blur as the export, without encoding, and
/// scales it to at most `max_width` wide.
pub fn preview(req: &Request, at: Position, max_width: u32) -> Result<Preview> {
    let plan = plan(req)?;
    let k = plan.frames.iter().position(|&(s, t)| s > at.segment || (s == at.segment && t >= at.secs - 0.5 / FPS as f64)).unwrap_or(plan.frames.len() - 1);
    let cancel = Arc::new(AtomicBool::new(false));
    let mut bgra = Vec::new();
    encode_all(req, &plan, &cancel, &mut |_| {}, &mut Vec::new(), Some((k, &mut bgra)))?;
    let (w, h) = (plan.width, plan.height);
    if bgra.len() < w as usize * h as usize * 4 {
        bail!("the preview frame came back short");
    }
    bgra.truncate(w as usize * h as usize * 4);
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let full = image::RgbaImage::from_raw(w, h, bgra).ok_or_else(|| anyhow::anyhow!("bad preview frame"))?;
    let scale = (max_width as f64 / w as f64).min(1.0);
    let (sw, sh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    let shown = if (sw, sh) == (w, h) { full } else { image::imageops::resize(&full, sw, sh, image::imageops::FilterType::Triangle) };
    Ok(Preview { width: w, height: h, shown: (sw, sh), rgba: shown.into_raw() })
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
    mut capture: Option<(usize, &mut Vec<u8>)>,
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
        Some((k, _)) => vec![plan.frames[*k]],
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

    let (cw, ch) = (plan.cell.0 as f32, plan.cell.1 as f32);
    let total = frames.len();

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
    let frost = dashboard.and_then(|d| d.frost(plan.width, plan.height));
    let masks: Vec<Option<super::compose::BlurMask>> = req
        .tiles
        .iter()
        .map(|tile| {
            let zones: Vec<&super::blur::BlurZone> = req.blur_zones.iter().filter(|z| z.camera == tile.camera && z.points.len() >= 3).collect();
            let privacy = (!zones.is_empty()).then(|| super::blur::mask(&zones, plan.cell.0, plan.cell.1));
            let cell = (tile.col as f32 * cw, plan.video_top as f32 + tile.row as f32 * ch);
            let glass = frost.and_then(|(rect, sigma)| super::blur::rounded_mask(rect, cell, plan.cell.0, plan.cell.1).map(|m| (m, sigma)));
            if privacy.is_none() && glass.is_none() {
                return None;
            }
            let (glass, sigma) = glass.unwrap_or_default();
            Some(compositor.blur_mask(plan.cell.0, plan.cell.1, privacy.as_deref().unwrap_or(&[]), &glass, sigma))
        })
        .collect();
    if !req.blur_zones.is_empty() || frost.is_some() {
        log::info!("export: blur zones or glass on {} camera(s)", masks.iter().filter(|m| m.is_some()).count());
    }
    // Overlays: drawn again only when what they show changes.
    let wants_overlays = req.timestamp.is_some() || dashboard.is_some() || req.minimap.is_some();
    let mut painter = if wants_overlays { super::overlay::Painter::new() } else { None };
    if wants_overlays && painter.is_none() {
        log::warn!("export: no software renderer for the overlays; exporting without them");
    }
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
    let minimap = match (&req.minimap, painter.as_mut()) {
        (Some(mm), Some(p)) => {
            let side = mm.side(plan.width, plan.height);
            let route = route_points(req, plan);
            match mm.fit(&route, side) {
                Some(fit) if mm.live => {
                    // Drawn frame by frame as the car moves (below).
                    let (x, y) = mm.place(side, plan.width, plan.height);
                    log::info!("export: live minimap {side} px, {} route points", route.len());
                    let blank = super::overlay::Picture { width: side, height: side, rgba: vec![0; side as usize * side as usize * 4] };
                    Some((mm, fit, compositor.overlay(&blank, None), x, y, route))
                }
                Some(fit) => {
                    mm.fetch_tiles(&fit, std::time::Duration::from_secs(if capture.is_some() { 2 } else { 12 }));
                    let picture = mm.paint_map(p, &route, &fit);
                    let (x, y) = mm.place(side, plan.width, plan.height);
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
    let mut last_report = Instant::now();
    for k in 0..total {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let mut pictures = Vec::with_capacity(req.tiles.len());
        let mut blurs = Vec::new();
        for ((tile, rx), mask) in req.tiles.iter().zip(&receivers).zip(&masks) {
            let picture = rx.recv().map_err(|_| anyhow!("a camera's decoding stopped"))?;
            if let Some(p) = picture {
                let place = Placement { x: tile.col as f32 * cw, y: plan.video_top as f32 + tile.row as f32 * ch, width: cw, height: ch, mirror: req.mirror && tile.camera.mirrored() };
                if let Some(m) = mask {
                    blurs.push((pictures.len(), m));
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
                let picture = ts.paint(p, wall, plan.width);
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
                    let picture = match d.style {
                        super::overlay::DashStyle::Compact => d.paint(p, &state, plan.width),
                        super::overlay::DashStyle::TeslaMobile => super::tesla_mobile::paint_data(p, plan.width, plan.data_bar, &state, d.metric, !d.bar_on_top()),
                    };
                    let old = dash.take().map(|(_, o)| o);
                    dash = Some((signature, compositor.overlay(&picture, old)));
                }
                if d.style == super::overlay::DashStyle::TeslaMobile {
                    let line = super::tesla_mobile::date_line(wall, d.h24);
                    if date_bar.as_ref().map(|(l, _)| l) != Some(&line) {
                        let picture = super::tesla_mobile::paint_date(p, plan.width, plan.date_bar, &line);
                        let old = date_bar.take().map(|(_, o)| o);
                        date_bar = Some((line, compositor.overlay(&picture, old)));
                    }
                }
            }
        }
        let mut overlays = Vec::new();
        if let (Some(ts), Some((_, o))) = (req.timestamp, stamp.as_ref()) {
            let (x, y) = ts.corner.place(o.width, o.height, plan.width, plan.height);
            overlays.push((o, x, y));
        }
        if let (Some(d), Some((_, o))) = (dashboard, dash.as_ref()) {
            let (x, y) = match d.style {
                super::overlay::DashStyle::Compact => d.place(o.width, o.height, plan.width, plan.height),
                super::overlay::DashStyle::TeslaMobile => (0.0, if d.bar_on_top() { plan.date_bar } else { plan.height - plan.data_bar } as f32),
            };
            overlays.push((o, x, y));
        }
        if let Some((_, o)) = date_bar.as_ref() {
            overlays.push((o, 0.0, 0.0));
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
                    if mm.tiles_ready(&fit) != Some(true) {
                        mm.fetch_tiles(&fit, std::time::Duration::from_secs(3));
                    }
                    let picture = mm.paint_map_with(p, route, &fit, Some((lat, lon, heading)), side);
                    let old = std::mem::replace(map_overlay, compositor.overlay(&picture, None));
                    drop(old);
                }
            }
        }
        if let Some((mm, fit, map_overlay, mx, my, _)) = minimap.as_ref() {
            overlays.push((map_overlay, *mx, *my));
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
                    }
                }
            }
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
                if let Some((_, bytes)) = capture.as_mut() {
                    compositor.draw_to_bytes(plan.width, plan.height, &pictures, &blurs, &overlays, bytes)?;
                }
                Vec::new()
            }
        };
        if let Some(mp4) = mp4.as_mut() {
            for p in packets {
                mp4.write_sample(&p.data, 1000, p.sync, 0)?;
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
                mp4.write_sample(&p.data, 1000, p.sync, 0)?;
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
        let tiles: Vec<Tile> = crate::library::GRID.iter().enumerate().map(|(i, &camera)| Tile { camera, col: i as u32 % 3, row: i as u32 / 3 }).collect();
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
                timestamp: Some(super::super::overlay::Timestamp { corner: super::super::overlay::Corner::BottomCenter, date_format: crate::settings::DateFormat::Ymd, h24: false }),
                dashboard: None,
                minimap: None,
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
                size: super::super::overlay::DashSize::Medium,
                metric: false,
                h24: false,
                accel: crate::dashboard::AccelMode::IconBar,
                glass: 0.0,
                free: None,
            }),
            minimap: None,
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

    /// A front clip driving north through Vancouver, exported with the
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
            Some(crate::sei::SeiMetadata { gear_state: 1, vehicle_speed_mps: 15.0, latitude_deg: 49.2800 + k as f64 * 0.00012, longitude_deg: -123.1200 + k as f64 * 0.00005, heading_deg: 20.0, ..Default::default() })
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
                size: super::super::overlay::DashSize::XLarge,
                dark: false,
                tiles: super::super::overlay::MapTiles(crate::map::tiles::Tiles::new(Some(dir.join("map")))),
                live: std::env::var("SENTRY_DUMP_LIVE").is_ok(),
                free: None,
            }),
            blur_zones: Vec::new(),
            output: out.clone(),
        };
        let started = std::time::Instant::now();
        assert!(matches!(run(&req, &Arc::new(AtomicBool::new(false)), |_| {}).unwrap(), Outcome::Done { frames: 72, .. }));
        println!("minimap export in {:.1} s: {}", started.elapsed().as_secs_f64(), out.display());
    }

    #[test]
    fn grids_match_electron() {
        let cams = [Camera::Front, Camera::Back, Camera::LeftRepeater, Camera::RightRepeater, Camera::LeftPillar, Camera::RightPillar];
        let size = |n: usize| {
            let t = grid(&cams[..n]);
            (t.iter().map(|t| t.col).max().unwrap() + 1, t.iter().map(|t| t.row).max().unwrap() + 1)
        };
        assert_eq!([size(1), size(2), size(3), size(4), size(5), size(6)], [(1, 1), (2, 1), (3, 1), (2, 2), (3, 2), (3, 2)]);
        assert_eq!((make_even(1086.0), make_even(703.5), make_even(469.0)), (1086, 704, 470));
    }
}
