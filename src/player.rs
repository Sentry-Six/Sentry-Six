//! Synced six-camera playback.
//!
//! One clock drives every tile. Each camera has a worker thread that reads
//! and decodes a few frames ahead of the clock into a small queue (so memory
//! stays bounded no matter how long the clip). On every display frame the UI
//! asks each tile for the newest frame at or before the clock time, so all
//! six show the same moment. If any tile falls behind (a slow share), the
//! clock waits for it instead of letting the cameras drift apart.

use crate::applog::stats;
use crate::decode::{Decoder, Frame};
use crate::library::{Camera, LocalSecs, Segment, GRID};
use crate::mp4::{read_video_track, VideoTrack};
use crate::reader::WindowReader;
use crate::telemetry::{sample_telemetry, SeiMetadata};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Frames decoded ahead per camera (about 1/6 s at 36 fps).
const AHEAD: usize = 6;
/// The next minute's clips are got ready this long before the change.
const PRELOAD_BEFORE: f64 = 5.0;
/// A Tesla segment is about a minute; used until the real length is known.
const DEFAULT_SEGMENT: f64 = 60.0;

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Clock {
    anchor: f64,
    since: Instant,
    playing: bool,
    rate: f64,
}

impl Clock {
    fn new() -> Self {
        Self { anchor: 0.0, since: Instant::now(), playing: false, rate: 1.0 }
    }
    fn now(&self) -> f64 {
        if self.playing {
            self.anchor + self.since.elapsed().as_secs_f64() * self.rate
        } else {
            self.anchor
        }
    }
    fn set(&mut self, t: f64) {
        self.anchor = t;
        self.since = Instant::now();
    }
    fn set_playing(&mut self, playing: bool) {
        let t = self.now();
        self.playing = playing;
        self.set(t);
    }
    fn set_rate(&mut self, rate: f64) {
        let t = self.now();
        self.rate = rate;
        self.set(t);
    }
}

// ---------------------------------------------------------------------------
// Worker per camera
// ---------------------------------------------------------------------------

enum Cmd {
    /// `reference`: the minute's front clip, which the cameras are lined
    /// up with (see crate::sync).
    Open { path: PathBuf, at: f64, generation: u64, reference: Option<PathBuf>, camera: Camera },
    /// Get the next minute's clip ready (index and first data read on a
    /// helper thread), so the change of minute doesn't wait on the share;
    /// and where it starts against `reference`.
    Preload { path: PathBuf, reference: Option<PathBuf> },
    Seek { at: f64, generation: u64 },
    Close,
}

#[derive(Clone)]
pub struct Shown {
    /// Changes whenever a different picture is shown.
    pub id: u64,
    pub frame: Arc<Frame>,
    pub pts: f64,
    /// That frame's telemetry, if the clip carries any there.
    pub telemetry: Option<Arc<SeiMetadata>>,
}

#[derive(Default)]
struct TileState {
    generation: u64,
    frames: VecDeque<(f64, Arc<Frame>, Option<Arc<SeiMetadata>>)>,
    /// The worker has decoded the last frame of the clip.
    eof: bool,
    duration: Option<f64>,
    error: Option<String>,
    /// The open clip's format (codec, size, frame rate), for the log.
    format: Option<String>,
}

type SharedTile = Arc<(Mutex<TileState>, Condvar)>;

struct OpenClip {
    reader: WindowReader,
    track: VideoTrack,
    decoder: Decoder,
    /// Samples given to the decoder whose pictures haven't come back yet,
    /// with their telemetry.
    waiting: VecDeque<(f64, Option<Arc<SeiMetadata>>)>,
    next: usize,
    /// While seeking: frames before this time are decoded but not shown.
    skip_before: f64,
    generation: u64,
    /// Pictures decoded so far, and damaged frames since the last one.
    shown: usize,
    failed: usize,
    /// Decoded pictures held back until nothing still to decode is shown
    /// before them (B-frames), in display order; and, per decode position,
    /// the earliest display time from there on.
    held: Vec<(f64, Arc<Frame>, Option<Arc<SeiMetadata>>)>,
    earliest: Vec<i64>,
    /// Display time of the keyframe decoding last started from: frames
    /// shown before it (open-GOP leading pictures) may fail harmlessly.
    gop_start: f64,
    /// Pictures queued since the last open or seek.
    queued: usize,
    /// Seconds this clip starts after the minute's front clip: its pictures
    /// are shown that much later (on the minute's timeline).
    offset: f64,
}

/// A clip's index and its first window of data, read ahead of time.
struct Preloaded {
    reader: WindowReader,
    track: VideoTrack,
}

fn preload(path: &PathBuf, reference: Option<&PathBuf>) -> anyhow::Result<Preloaded> {
    let file = std::fs::File::open(path)?;
    let track = read_video_track(&file)?;
    let mut reader = WindowReader::new(file)?;
    if let Some(first) = track.samples.first() {
        reader.warm(first.offset)?;
    }
    // Where it and the minute's front clip start, ready for the open.
    crate::sync::start_of(path, || crate::sync::start_from(&track, |o, n| reader.read(o, n).ok().map(<[u8]>::to_vec)));
    if let Some(r) = reference.filter(|r| *r != path) {
        crate::sync::start(r);
    }
    Ok(Preloaded { reader, track })
}

/// Seconds `clip` (at `path`) starts after the minute's `reference` clip.
fn clip_offset(clip: &mut OpenClip, path: &PathBuf, reference: Option<&PathBuf>, camera: Camera) -> f64 {
    let reference_path = reference;
    let own = crate::sync::start_of(path, || crate::sync::start_from(&clip.track, |o, n| clip.reader.read(o, n).ok().map(<[u8]>::to_vec)));
    let (reference, ref_camera) = match reference {
        Some(r) if r != path => (crate::sync::start(r), crate::sync::camera_of(r).unwrap_or(Camera::Front)),
        _ => (own, camera),
    };
    // A clip cut short that only the telemetry's timing can line up: measured
    // now, as the export does, so playback and the export agree.
    if let Some(r) = reference_path.filter(|r| *r != path && ref_camera == Camera::Front && crate::sync::needs_timing(own, reference, camera)) {
        crate::sync::time_offset_now(path, r);
    }
    crate::sync::offset(path, own, reference, camera, ref_camera)
}

fn open_clip(path: &PathBuf, at: f64, generation: u64) -> anyhow::Result<OpenClip> {
    let file = std::fs::File::open(path)?;
    let track = read_video_track(&file)?;
    let reader = WindowReader::new(file)?;
    clip_from(Preloaded { reader, track }, at, generation)
}

fn clip_from(Preloaded { mut reader, track }: Preloaded, at: f64, generation: u64) -> anyhow::Result<OpenClip> {
    let bytes: u64 = track.samples.iter().map(|s| s.size as u64).sum();
    if track.duration > 0.0 {
        reader.set_rate(bytes as f64 / track.duration);
    }
    let decoder = Decoder::new(&track)?;
    let earliest = track.earliest_from();
    let mut clip = OpenClip {
        reader,
        track,
        decoder,
        next: 0,
        skip_before: 0.0,
        generation,
        shown: 0,
        failed: 0,
        held: Vec::new(),
        waiting: VecDeque::new(),
        earliest,
        gop_start: 0.0,
        queued: 0,
        offset: 0.0,
    };
    seek_clip(&mut clip, at);
    Ok(clip)
}

fn seek_clip(clip: &mut OpenClip, at: f64) {
    let target = clip.track.sample_at(at);
    clip.next = clip.track.sync_at_or_before(target);
    clip.skip_before = clip.track.pts_secs(target);
    clip.decoder.reset();
    clip.held.clear();
    clip.waiting.clear();
    clip.queued = 0;
}

fn worker(rx: &Receiver<Cmd>, shared: &SharedTile) {
    let (lock, cvar) = &**shared;
    // The camera, for the log (the thread is named after it).
    let camera = std::thread::current().name().unwrap_or("decode").trim_start_matches("decode-").to_string();
    let mut clip: Option<OpenClip> = None;
    // Why the current clip couldn't be opened, shown again after a seek.
    let mut open_error: Option<String> = None;
    // The next minute's clip, being read ahead.
    let mut preloading: Option<(PathBuf, Receiver<anyhow::Result<Preloaded>>)> = None;
    loop {
        // Commands: block when there is nothing to decode.
        let idle = clip.as_ref().is_none_or(|c| c.next >= c.track.samples.len());
        let cmd = if idle {
            match rx.recv() {
                Ok(c) => Some(c),
                Err(_) => return,
            }
        } else {
            match rx.try_recv() {
                Ok(c) => Some(c),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return,
            }
        };
        match cmd {
            Some(Cmd::Open { path, at, generation, reference, camera: cam }) => {
                clip = None;
                open_error = None;
                let began = Instant::now();
                let ready = match preloading.take() {
                    // Waits for the read ahead if it isn't done yet (it is
                    // further along than starting over).
                    Some((p, rx)) if p == path => rx.recv().ok().and_then(|r| r.ok()),
                    _ => None,
                };
                let opened = match ready {
                    Some(pre) => clip_from(pre, at, generation),
                    None => open_clip(&path, at, generation),
                };
                let open_ms = began.elapsed().as_secs_f64() * 1000.0;
                let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                crate::trace::trace!("opened {file} in {open_ms:.0} ms");
                stats::CLIP_OPENS.add(open_ms);
                if open_ms > 3000.0 {
                    log::warn!("{camera}: opening {file} took {open_ms:.0} ms");
                }
                match opened {
                    Ok(mut c) => {
                        // Lined up with the minute's front clip: opened that
                        // much earlier (or later) in its own time.
                        c.offset = clip_offset(&mut c, &path, reference.as_ref(), cam);
                        if c.offset.abs() > 1e-6 {
                            crate::trace::trace!("{file} starts {:+.0} ms from the front clip", c.offset * 1000.0);
                            let local = (at - c.offset).max(0.0);
                            seek_clip(&mut c, local);
                        }
                        let t = &c.track;
                        let format = format!("{:?} {}x{}, {:.0} fps", t.codec, t.width, t.height, t.samples.len() as f64 / t.duration.max(0.001));
                        let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                        st.format = Some(format);
                        if st.generation == generation {
                            st.duration = Some(c.track.duration + c.offset);
                        }
                        clip = Some(c);
                    }
                    Err(e) => {
                        log::warn!("{camera}: {file} could not be opened: {e:#}");
                        let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                        open_error = Some(format!("{e:#}"));
                        if st.generation == generation {
                            st.error = open_error.clone();
                            st.eof = true;
                        }
                    }
                }
                continue;
            }
            Some(Cmd::Preload { path, reference }) => {
                if preloading.as_ref().is_none_or(|(p, _)| *p != path) {
                    let (tx, rx) = channel();
                    let p = path.clone();
                    let spawned = std::thread::Builder::new().name("preload".into()).spawn(move || {
                        let _ = tx.send(preload(&p, reference.as_ref()));
                    });
                    if spawned.is_ok() {
                        preloading = Some((path, rx));
                    }
                }
                continue;
            }
            Some(Cmd::Seek { at, generation }) => {
                match clip.as_mut() {
                    Some(c) => {
                        c.generation = generation;
                        seek_clip(c, (at - c.offset).max(0.0));
                    }
                    // No clip (it couldn't be opened): nothing to show, so
                    // the camera is done and doesn't hold the others back.
                    None => {
                        let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                        if st.generation == generation {
                            st.eof = true;
                            st.error = open_error.clone();
                        }
                        cvar.notify_all();
                    }
                }
                continue;
            }
            Some(Cmd::Close) => {
                clip = None;
                open_error = None;
                continue;
            }
            None => {}
        }
        let Some(c) = clip.as_mut() else { continue };

        // Wait for room in the queue (or a new command).
        {
            let st = lock.lock().unwrap_or_else(|e| e.into_inner());
            if st.generation != c.generation {
                drop(st);
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }
            if st.frames.len() >= AHEAD {
                let _ = cvar.wait_timeout(st, Duration::from_millis(15)).unwrap_or_else(|e| e.into_inner());
                continue;
            }
        }

        let i = c.next;
        c.next += 1;
        let sample = c.track.samples[i];
        let pts = c.track.pts_secs(i);
        if sample.sync {
            c.gop_start = pts;
        }
        let nal_length = c.track.nal_length_size as usize;
        let codec = c.track.codec;
        let began = Instant::now();
        let mut read_ms = 0.0;
        let mut telemetry = None;
        let result = c.reader.read(sample.offset, sample.size as usize).and_then(|data| {
            read_ms = began.elapsed().as_secs_f64() * 1000.0;
            telemetry = sample_telemetry(data, nal_length, codec).map(Arc::new);
            c.decoder.decode_at(data, pts)
        });
        let total_ms = began.elapsed().as_secs_f64() * 1000.0;
        stats::FRAMES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if total_ms > 25.0 {
            stats::SLOW_FRAMES.add(total_ms);
            crate::trace::trace!("slow frame {i} ({} B): read {read_ms:.0} ms, decode {:.0} ms", sample.size, total_ms - read_ms);
            if total_ms > 500.0 {
                stats::very_slow_frame(&camera, total_ms, read_ms);
            }
        }
        let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
        if st.generation != c.generation {
            continue;
        }
        // A decoder may hand back an earlier sample's picture (GStreamer's
        // can lag a frame or two): each picture is filed under its own
        // sample, with that sample's telemetry.
        c.waiting.push_back((pts, telemetry));
        let mut pictures = Vec::new();
        match result {
            Ok(Some(frame)) => {
                if c.failed > 0 {
                    // Pictures again after a damaged frame: clear its message.
                    c.failed = 0;
                    st.error = None;
                }
                pictures.push(frame);
            }
            Ok(None) => {}
            // A leading picture of an open GOP after a seek (it needs frames
            // from before the keyframe): not damage, just not shown.
            Err(_) if pts + 1e-6 < c.gop_start => {}
            Err(e) => {
                // A damaged frame (often the last, half-written one of a
                // clip): skip to the next keyframe. Only a clip that shows
                // nothing at all is reported.
                stats::DECODE_ERRORS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                log::warn!("{camera}: frame {i} could not be decoded: {e:#}");
                c.failed = c.failed.max(1);
                if c.shown == 0 {
                    st.error = Some(format!("{e:#}"));
                }
                if let Some(k) = (c.next..c.track.samples.len()).find(|&k| c.track.samples[k].sync) {
                    c.next = k;
                } else {
                    c.next = c.track.samples.len();
                }
                // Start the decoder afresh from that keyframe: a decoder that
                // hit an error may produce nothing more until it is reset.
                c.decoder.reset();
                c.waiting.clear();
            }
        }
        if c.next >= c.track.samples.len() {
            // The end of the clip: what the decoder still holds.
            pictures.extend(c.decoder.drain());
        }
        for frame in pictures {
            let at_pts = frame.pts().unwrap_or(pts);
            let telemetry = match c.waiting.iter().position(|w| (w.0 - at_pts).abs() < 1e-4) {
                Some(k) => c.waiting.remove(k).and_then(|w| w.1),
                None => None,
            };
            c.shown += 1;
            let at = c.held.partition_point(|h| h.0 < at_pts);
            c.held.insert(at, (at_pts, Arc::new(frame), telemetry));
        }
        // Samples whose pictures will never come (dropped by the decoder)
        // shouldn't pile up.
        while c.waiting.len() > 32 {
            c.waiting.pop_front();
        }
        // Show held pictures that nothing left to decode comes before. Pre-roll
        // after a seek: show the target frame, not the keyframe it is decoded
        // from (but at the very end, at least the last picture).
        let end = c.next >= c.track.samples.len();
        let horizon = c.earliest.get(c.next).copied().unwrap_or(i64::MAX) as f64 / c.track.timescale as f64;
        while c.held.first().is_some_and(|h| end || h.0 < horizon - 1e-9) {
            let h = c.held.remove(0);
            let only_one_left = end && c.held.is_empty() && c.queued == 0;
            if h.0 + 1e-6 >= c.skip_before || only_one_left {
                // On the minute's timeline.
                st.frames.push_back((h.0 + c.offset, h.1, h.2));
                c.queued += 1;
            }
        }
        if c.next >= c.track.samples.len() {
            st.eof = true;
        }
    }
}

struct Tile {
    camera: Camera,
    tx: Sender<Cmd>,
    shared: SharedTile,
    active: bool,
    shown: Option<Shown>,
    /// After a seek or a new clip: no picture for the new position yet
    /// (the old picture stays on screen meanwhile).
    awaiting: bool,
    /// Its clip has ended with nothing left to show.
    finished: bool,
}

impl Tile {
    /// Starts a new generation (dropping queued frames) and sends `make`'s
    /// command for it. A seek keeps the clip's known length; opening or
    /// closing a clip forgets it.
    fn send(&mut self, keep_duration: bool, make: impl FnOnce(u64) -> Cmd) {
        self.awaiting = true;
        let generation = {
            let (lock, cvar) = &*self.shared;
            let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
            st.generation += 1;
            st.frames.clear();
            st.eof = false;
            st.error = None;
            if !keep_duration {
                st.duration = None;
            }
            cvar.notify_all();
            st.generation
        };
        let _ = self.tx.send(make(generation));
    }
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

pub struct Player {
    clock: Clock,
    tiles: Vec<Tile>,
    segments: Vec<Segment>,
    durations: Vec<f64>,
    segment: usize,
    next_id: u64,
    /// Waiting for the first frames after a load or seek.
    pending: bool,
    /// A seek asked for while the last one is still arriving: the newest
    /// target wins, and it runs once every camera has caught up.
    queued_seek: Option<f64>,
    /// Real segment lengths, read from each minute's front clip in the
    /// background after a load (until then a minute counts as 60 s).
    lengths: Option<Receiver<(usize, f64)>>,
    /// Stops the running length reader when another collection loads.
    lengths_cancel: Arc<std::sync::atomic::AtomicBool>,
    /// The length reader has finished.
    lengths_done: bool,
    /// Tells the length reader to hold off (see `read_lengths`).
    busy: Arc<std::sync::atomic::AtomicBool>,
    /// When a camera last held the clock back.
    last_hold: Option<Instant>,
    /// The segment whose clips were last sent for preloading.
    preloaded: Option<usize>,
    /// When the pending seek started (for the trace).
    pending_since: Option<Instant>,
    /// When tick last ran (for display pauses).
    last_tick: Option<Instant>,
    /// When the clock began waiting for a camera (for diagnostics).
    hold_started: Option<Instant>,
    /// When playback health was last logged.
    last_summary: Option<Instant>,
    /// The cameras' formats as last logged, and a new set waiting to hold
    /// steady before it's logged (cameras open their clips one by one).
    formats_logged: String,
    formats_seen: Option<(String, Instant)>,
    formats_checked: Option<Instant>,
}

/// Clip lengths remembered between runs (clip-lengths.json in the data
/// folder), so a day opened before shows its full length at once. Each is
/// kept with the file's size and modification time and used only while
/// those still match.
mod length_cache {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    type Entry = (u64, i64, f64);

    fn file() -> Option<PathBuf> {
        crate::settings::data_dir().map(|d| d.join("clip-lengths.json"))
    }

    fn cache() -> &'static Mutex<(HashMap<String, Entry>, bool)> {
        static CACHE: OnceLock<Mutex<(HashMap<String, Entry>, bool)>> = OnceLock::new();
        CACHE.get_or_init(|| {
            let map = file().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            Mutex::new((map, false))
        })
    }

    fn stamp(path: &Path) -> Option<(u64, i64)> {
        let meta = std::fs::metadata(path).ok()?;
        let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
        Some((meta.len(), modified))
    }

    /// The remembered length, without looking at the file (no disk or
    /// network access: for the UI thread). The length reader checks it.
    pub fn remembered(path: &Path) -> Option<f64> {
        let c = cache().lock().unwrap_or_else(|e| e.into_inner());
        c.0.get(&path.to_string_lossy().into_owned()).map(|(_, _, d)| *d)
    }

    /// The remembered length, if the file is unchanged (reads its size and
    /// time: slow on a network share, so off the UI thread only).
    pub fn get(path: &Path) -> Option<f64> {
        let (size, modified) = stamp(path)?;
        let c = cache().lock().unwrap_or_else(|e| e.into_inner());
        c.0.get(&path.to_string_lossy().into_owned()).filter(|(s, m, _)| *s == size && *m == modified).map(|(_, _, d)| *d)
    }

    pub fn put(path: &Path, length: f64) {
        let Some((size, modified)) = stamp(path) else { return };
        let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
        c.0.insert(path.to_string_lossy().into_owned(), (size, modified, length));
        c.1 = true;
    }

    /// Writes what's new (at most 200,000 clips are kept).
    pub fn save() {
        let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
        if !c.1 {
            return;
        }
        if c.0.len() > 200_000 {
            c.0.clear();
        }
        c.1 = false;
        if let (Some(f), Ok(bytes)) = (file(), serde_json::to_vec(&c.0)) {
            let tmp = f.with_extension("json.tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &f);
            }
        }
    }
}

/// A clip's remembered length, without touching the file (see
/// `length_cache::remembered`).
pub fn remembered_length(path: &std::path::Path) -> Option<f64> {
    length_cache::remembered(path)
}

/// The clip a minute's length is read from: its front camera's, or any.
fn length_clip(s: &Segment) -> Option<&PathBuf> {
    s.files.get(&Camera::Front).or_else(|| s.files.values().next())
}

/// Reads the length of every segment's clip (front camera, or the first
/// one there is) and sends `(segment, seconds)`. Stops early when the
/// receiver is dropped (another collection was loaded). It runs alongside
/// playback on the same drive or share, so it stays out of the way: no
/// reads while `busy` is set (a clip opening, a seek, or a camera waiting
/// for data). `LENGTH_READERS` files at a time: each read is two small
/// reads at the file's ends, so the time goes on waiting for the drive (a
/// USB stick or a network share), which several at once overlap. On a USB
/// drive: 62 ms a clip one at a time, 18 ms four at a time, 13.5 ms eight
/// at a time, no better with sixteen.
fn read_lengths(segments: &[Segment], tx: Sender<(usize, f64)>, busy: Arc<std::sync::atomic::AtomicBool>, cancel: Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let paths: Vec<(usize, PathBuf)> = segments
        .iter()
        .enumerate()
        .filter_map(|(i, s)| length_clip(s).map(|p| (i, p.clone())))
        .collect();
    let next = AtomicUsize::new(0);
    let cancelled = || cancel.load(Ordering::Relaxed);
    std::thread::scope(|scope| {
        for _ in 0..LENGTH_READERS {
            let tx = tx.clone();
            let (next, paths, busy) = (&next, &paths, &busy);
            scope.spawn(move || loop {
                while busy.load(Ordering::Relaxed) && !cancelled() {
                    std::thread::sleep(Duration::from_millis(50));
                }
                if cancelled() {
                    return;
                }
                let Some((i, path)) = paths.get(next.fetch_add(1, Ordering::Relaxed)) else { return };
                // Remembered and unchanged: already in (Player::load).
                if length_cache::get(path).is_some() {
                    continue;
                }
                let began = Instant::now();
                let length = std::fs::File::open(path).ok().and_then(|f| read_video_track(&f).ok()).map(|t| t.duration);
                crate::trace::trace!("length of segment {i}: {:.0} ms", began.elapsed().as_secs_f64() * 1000.0);
                if let Some(d) = length.filter(|d| *d > 0.0) {
                    length_cache::put(path, d);
                    if tx.send((*i, d)).is_err() {
                        return;
                    }
                }
            });
        }
    });
    length_cache::save();
}

/// Clip lengths read at once (see `read_lengths`).
const LENGTH_READERS: usize = 8;

/// A minute's length until its clip is read: the time to the next minute
/// by their file names (Tesla starts the next file as one closes, so this
/// is right to about a second), or 60 s before a gap or at the end.
fn estimated_lengths(segments: &[Segment]) -> Vec<f64> {
    segments
        .iter()
        .enumerate()
        .map(|(i, s)| match segments.get(i + 1).map(|n| (n.start - s.start) as f64) {
            Some(gap) if (50.0..=62.0).contains(&gap) => gap,
            _ => DEFAULT_SEGMENT,
        })
        .collect()
}

impl Player {
    pub fn new() -> Self {
        let tiles = GRID
            .iter()
            .map(|&camera| {
                let (tx, rx) = channel();
                let shared: SharedTile = Arc::new((Mutex::new(TileState::default()), Condvar::new()));
                let s = shared.clone();
                std::thread::Builder::new()
                    .name(format!("decode-{camera:?}"))
                    .spawn(move || {
                        // A panic (a malformed file the parser didn't expect)
                        // ends that clip, not the camera: its error shows and
                        // the worker carries on with the next command.
                        while std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker(&rx, &s))).is_err() {
                            log::error!("{camera:?}: its clip stopped after a crash (logged above); the camera carries on");
                            let mut st = s.0.lock().unwrap_or_else(|e| e.into_inner());
                            st.frames.clear();
                            st.eof = true;
                            st.error = Some("This clip couldn't be played.".into());
                            s.1.notify_all();
                        }
                    })
                    .expect("start decoder thread");
                Tile { camera, tx, shared, active: false, shown: None, awaiting: false, finished: false }
            })
            .collect();
        Self {
            clock: Clock::new(),
            tiles,
            segments: Vec::new(),
            durations: Vec::new(),
            segment: 0,
            next_id: 1,
            pending: false,
            queued_seek: None,
            lengths: None,
            lengths_done: false,
            lengths_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pending_since: None,
            last_tick: None,
            hold_started: None,
            last_summary: None,
            formats_logged: String::new(),
            formats_seen: None,
            formats_checked: None,
            busy: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            preloaded: None,
            last_hold: None,
        }
    }

    pub fn load(&mut self, segments: Vec<Segment>, start: f64) {
        // Other footage, perhaps another car: its cameras' lags are measured again.
        crate::sync::forget();
        self.queued_seek = None;
        self.pending = false;
        // Lengths remembered from before go in at once, without touching the
        // files (each would be a round trip on a network share); the reader
        // checks them and reads the rest. All remembered: the total is
        // known now.
        let remembered: Vec<Option<f64>> = segments.iter().map(|s| length_clip(s).and_then(|p| length_cache::remembered(p))).collect();
        self.lengths_done = remembered.iter().all(Option::is_some);
        let estimated = estimated_lengths(&segments);
        self.durations = remembered.into_iter().zip(estimated).map(|(d, e)| d.unwrap_or(e)).collect();
        let (tx, rx) = channel();
        let list = segments.clone();
        std::thread::Builder::new()
            .name("segment-lengths".into())
            .spawn({
                let busy = self.busy.clone();
                // Stop the previous collection's reader, which may be
                // waiting for playback to settle.
                self.lengths_cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                self.lengths_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let cancel = self.lengths_cancel.clone();
                move || read_lengths(&list, tx, busy, cancel)
            })
            .expect("start length reader");
        self.lengths = Some(rx);
        self.segments = segments;
        self.clock.set_playing(false);
        let (seg, local) = self.locate(start);
        self.open_segment(seg, local);
    }

    /// The file one camera is playing from now.
    pub fn current_file(&self, camera: Camera) -> Option<&PathBuf> {
        self.segments.get(self.segment)?.files.get(&camera)
    }

    pub fn has_media(&self) -> bool {
        !self.segments.is_empty()
    }

    /// The collection's minutes.
    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// The minute at collection seconds `t`, and the seconds into it.
    pub fn locate_at(&self, t: f64) -> (usize, f64) {
        self.locate(t)
    }

    /// Collection seconds of `secs` into minute `segment` (the end of the
    /// last minute for `segment == len`).
    pub fn position_at(&self, segment: usize, secs: f64) -> f64 {
        self.durations.iter().take(segment).sum::<f64>() + secs
    }

    fn locate(&self, t: f64) -> (usize, f64) {
        let mut acc = 0.0;
        for (i, d) in self.durations.iter().enumerate() {
            if t < acc + d || i + 1 == self.durations.len() {
                return (i, (t - acc).clamp(0.0, *d));
            }
            acc += d;
        }
        (0, 0.0)
    }

    fn open_segment(&mut self, seg: usize, at: f64) {
        self.segment = seg;
        self.clock.set(at);
        self.pending = true;
        self.pending_since = Some(Instant::now());
        let files = self.segments.get(seg).map(|s| s.files.clone()).unwrap_or_default();
        let reference = crate::sync::reference(&files).cloned();
        // Each camera's lag behind the front, from this car's driving; and
        // the timing of cameras whose counters can't be compared, for this
        // minute and the next.
        crate::sync::measure(files.clone());
        crate::sync::measure_times(files.clone());
        if let Some(next) = self.segments.get(seg + 1) {
            crate::sync::measure_times(next.files.clone());
        }
        for tile in &mut self.tiles {
            // The last picture stays up until the new clip's first one.
            match files.get(&tile.camera) {
                Some(path) => {
                    tile.active = true;
                    let path = path.clone();
                    let reference = reference.clone();
                    let camera = tile.camera;
                    tile.send(false, |generation| Cmd::Open { path, at, generation, reference, camera });
                }
                None => {
                    tile.active = false;
                    tile.shown = None;
                    tile.send(false, |_| Cmd::Close);
                }
            }
        }
    }

    pub fn is_playing(&self) -> bool {
        self.clock.playing
    }

    pub fn set_playing(&mut self, playing: bool) {
        if self.has_media() {
            self.clock.set_playing(playing);
        }
        if !playing && !self.pending {
            // Paused: ticks stop, so free the length reader here.
            self.last_hold = None;
            self.busy.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    pub fn rate(&self) -> f64 {
        self.clock.rate
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.clock.set_rate(rate);
    }

    /// Seeks to `t` seconds from the start of the collection.
    pub fn seek(&mut self, t: f64) {
        if !self.has_media() {
            return;
        }
        if self.pending {
            // Still showing the last jump: run this one after it, instead of
            // restarting every camera on each key repeat.
            self.queued_seek = Some(t);
            return;
        }
        let (seg, local) = self.locate(t);
        if seg != self.segment {
            self.open_segment(seg, local);
            return;
        }
        self.clock.set(local);
        self.pending = true;
        self.pending_since = Some(Instant::now());
        for tile in self.tiles.iter_mut().filter(|t| t.active) {
            tile.send(true, |generation| Cmd::Seek { at: local, generation });
        }
    }

    /// Needs a redraw every display frame (playing, or frames on the way).
    pub fn wants_frames(&self) -> bool {
        self.has_media() && (self.clock.playing || self.pending)
    }

    /// Picks each tile's frame for the clock time. Call once per display frame.
    pub fn tick(&mut self) {
        if !self.has_media() {
            return;
        }
        let now = Instant::now();
        // Playback health in the log every 5 minutes of playing, so a
        // session that crashes still has it.
        if self.clock.playing && self.last_summary.is_none_or(|t| now.duration_since(t).as_secs() >= 300) {
            if self.last_summary.is_some() {
                log::info!("playback so far: {}", stats::summary());
            }
            self.last_summary = Some(now);
        }
        self.log_formats(now);
        if let Some(last) = self.last_tick.replace(now) {
            let gap = now.duration_since(last).as_secs_f64() * 1000.0;
            if gap > 40.0 && self.clock.playing {
                stats::DISPLAY_GAPS.add(gap);
                crate::trace::trace!("display gap {gap:.0} ms");
                if gap > 1000.0 {
                    log::warn!("the picture paused {gap:.0} ms while playing");
                }
            }
        }
        // Real lengths of the other minutes as they come in.
        if let Some(rx) = &self.lengths {
            loop {
                match rx.try_recv() {
                    Ok((i, d)) => {
                        if i != self.segment {
                            if let Some(slot) = self.durations.get_mut(i) {
                                *slot = d;
                            }
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        self.lengths_done = true;
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                }
            }
        }
        let t = self.clock.now();
        // After a jump, no camera changes picture until every camera has its
        // picture for the new spot, so they always move together.
        if self.pending {
            let ready = self.tiles.iter().filter(|t| t.active).all(|tile| {
                let st = tile.shared.0.lock().unwrap_or_else(|e| e.into_inner());
                !st.frames.is_empty() || st.eof
            });
            if !ready {
                if self.clock.playing {
                    self.clock.set(t);
                }
                return;
            }
        }
        // The moment every camera can show: a camera that has nothing
        // decoded past its current picture holds everyone back, so no
        // camera ever shows a later moment than the slowest one.
        const FRAME: f64 = 1.0 / 36.0;
        let mut t_show = t;
        for tile in self.tiles.iter().filter(|t| t.active) {
            let st = tile.shared.0.lock().unwrap_or_else(|e| e.into_inner());
            if st.eof && st.frames.len() <= 1 {
                continue; // finished: shows its last picture
            }
            let reach = match st.frames.iter().take_while(|f| f.0 <= t + 1e-4).last() {
                // Has a picture for t, and the next one is on its way or here.
                Some(_) if st.frames.iter().any(|f| f.0 > t + 1e-4) => t,
                // Its newest picture is before t and nothing after it yet.
                Some(f) => f.0 + FRAME,
                None if !st.frames.is_empty() => t,
                None => tile.shown.as_ref().map_or(t, |s| s.pts + FRAME),
            };
            t_show = t_show.min(reach);
        }

        let mut all_done = true;
        let mut seg_len: f64 = 0.0;
        let mut any_active = false;
        for tile in self.tiles.iter_mut().filter(|t| t.active) {
            any_active = true;
            let (lock, cvar) = &*tile.shared;
            let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(d) = st.duration {
                seg_len = seg_len.max(d);
            }
            while st.frames.len() >= 2 && st.frames[1].0 <= t_show + 1e-4 {
                st.frames.pop_front();
            }
            // Not before it's due: a camera whose clip starts later than the
            // front's keeps its last picture until then.
            if let Some((pts, frame, telemetry)) = st.frames.front().filter(|f| f.0 <= t_show + 1e-4 || tile.shown.is_none()) {
                let new_pic = tile.shown.as_ref().is_none_or(|s| !Arc::ptr_eq(&s.frame, frame));
                if new_pic {
                    tile.shown = Some(Shown { id: self.next_id, frame: frame.clone(), pts: *pts, telemetry: telemetry.clone() });
                    self.next_id += 1;
                }
                // The queue only ever holds frames for the latest seek.
                tile.awaiting = false;
            }
            // Finished with nothing to show (its clip couldn't be opened or
            // decoded): it has caught up as far as it ever will.
            tile.finished = st.eof && st.frames.is_empty();
            if tile.finished {
                tile.awaiting = false;
            }
            cvar.notify_all();
            if !st.eof || st.frames.len() >= 2 {
                all_done = false;
            }
        }
        if !any_active {
            self.pending = false;
            return;
        }
        let waiting = self.tiles.iter().any(|t| t.active && (t.awaiting || (t.shown.is_none() && !t.finished)));
        let holding = t_show < t - 1e-3 && self.clock.playing;
        match (holding, self.hold_started) {
            (true, None) => self.hold_started = Some(Instant::now()),
            (false, Some(began)) => {
                self.hold_started = None;
                let ms = began.elapsed().as_secs_f64() * 1000.0;
                stats::CLOCK_HOLDS.add(ms);
                if ms > 1500.0 {
                    log::warn!("playback waited {ms:.0} ms for a camera to catch up");
                }
            }
            _ => {}
        }
        if holding {
            self.last_hold = Some(Instant::now());
            if crate::trace::on() {
                let behind: Vec<String> = self
                    .tiles
                    .iter()
                    .filter(|tile| tile.active)
                    .map(|tile| format!("{:?} {}", tile.camera, tile.shared.0.lock().unwrap_or_else(|e| e.into_inner()).frames.len()))
                    .collect();
                crate::trace::trace!("clock held {:.0} ms (queues: {})", (t - t_show) * 1000.0, behind.join(", "));
            }
            // Hold the clock at what every camera can show (never later than
            // a picture already on screen, so it never jumps back past one).
            self.clock.set(t_show);
        }
        // Busy: starting up, seeking, or a camera short of data within the
        // last second.
        let busy = self.pending || waiting || self.last_hold.is_some_and(|h| h.elapsed() < Duration::from_secs(1));
        self.busy.store(busy, std::sync::atomic::Ordering::Relaxed);
        if !waiting {
            if self.pending {
                if let Some(since) = self.pending_since.take() {
                    let ms = since.elapsed().as_secs_f64() * 1000.0;
                    crate::trace::trace!("seek ready in {ms:.0} ms");
                    stats::SEEKS.add(ms);
                    if ms > 3000.0 {
                        log::warn!("a seek took {ms:.0} ms to show every camera");
                    }
                }
            }
            self.pending = false;
        }
        // Every camera is on the last jump: now run the newest one asked for.
        if !self.pending {
            if let Some(q) = self.queued_seek.take() {
                self.seek(q);
                return;
            }
        }
        if seg_len > 0.0 {
            if let Some(d) = self.durations.get_mut(self.segment) {
                *d = seg_len;
            }
        }
        // Nearly the end of this minute: get the next one's clips ready.
        if self.clock.playing && seg_len > 0.0 && t >= seg_len - PRELOAD_BEFORE && self.preloaded != Some(self.segment + 1) {
            if let Some(next) = self.segments.get(self.segment + 1) {
                let reference = crate::sync::reference(&next.files).cloned();
                for tile in &self.tiles {
                    if let Some(path) = next.files.get(&tile.camera) {
                        let _ = tile.tx.send(Cmd::Preload { path: path.clone(), reference: reference.clone() });
                    }
                }
                self.preloaded = Some(self.segment + 1);
                crate::trace::trace!("preloading segment {}", self.segment + 1);
            }
        }
        // End of this minute: go on to the next one.
        if all_done && self.clock.playing && t >= seg_len - 0.05 {
            if self.segment + 1 < self.segments.len() {
                let next = self.segment + 1;
                self.open_segment(next, 0.0);
            } else {
                self.clock.set_playing(false);
                self.clock.set(seg_len);
            }
        }
    }

    pub fn shown(&self, slot: usize) -> Option<&Shown> {
        self.tiles.get(slot).and_then(|t| t.shown.as_ref())
    }

    pub fn slot_active(&self, slot: usize) -> bool {
        self.tiles.get(slot).is_some_and(|t| t.active)
    }

    pub fn slot_error(&self, slot: usize) -> Option<String> {
        self.tiles.get(slot).and_then(|t| t.shared.0.lock().unwrap_or_else(|e| e.into_inner()).error.clone())
    }

    /// Logs the cameras' formats in one line when they change (grouped:
    /// "H264 1448x938, 36 fps: Back, LeftPillar, …"), once they have held
    /// for a second.
    fn log_formats(&mut self, now: Instant) {
        // Four times a second is plenty.
        if self.formats_checked.is_some_and(|t| now.duration_since(t) < Duration::from_millis(250)) {
            return;
        }
        self.formats_checked = Some(now);
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for tile in self.tiles.iter().filter(|t| t.active) {
            let Some(f) = tile.shared.0.lock().unwrap_or_else(|e| e.into_inner()).format.clone() else { continue };
            match groups.iter_mut().find(|(g, _)| *g == f) {
                Some((_, cams)) => cams.push(format!("{:?}", tile.camera)),
                None => groups.push((f, vec![format!("{:?}", tile.camera)])),
            }
        }
        if groups.is_empty() {
            return;
        }
        groups.sort();
        let line = groups.iter().map(|(f, cams)| format!("{f}: {}", cams.join(", "))).collect::<Vec<_>>().join("; ");
        if line == self.formats_logged {
            self.formats_seen = None;
            return;
        }
        match &self.formats_seen {
            Some((seen, at)) if *seen == line => {
                if now.duration_since(*at) >= Duration::from_secs(1) {
                    log::info!("cameras: {line}");
                    self.formats_logged = line;
                    self.formats_seen = None;
                }
            }
            _ => self.formats_seen = Some((line, now)),
        }
    }

    /// For diagnostics: where playback is and how each camera is doing.
    pub fn describe(&self) -> Vec<String> {
        if !self.has_media() {
            return vec!["Nothing loaded".into()];
        }
        let mut out = vec![format!(
            "Minute {} of {}, at {:.1} s of {:.1} s, {}, speed {}x{}",
            self.segment + 1,
            self.segments.len(),
            self.position(),
            self.total(),
            if self.clock.playing { "playing" } else { "paused" },
            self.clock.rate,
            if self.pending { ", waiting for cameras after a seek or load" } else { "" },
        )];
        for tile in &self.tiles {
            let st = tile.shared.0.lock().unwrap_or_else(|e| e.into_inner());
            let state = if !tile.active {
                "no clip this minute".to_string()
            } else if let Some(e) = &st.error {
                format!("error: {e}")
            } else if tile.finished {
                "clip ended".into()
            } else {
                let shown = tile.shown.as_ref().map_or("nothing shown yet".to_string(), |s| format!("showing {}x{} at {:.2} s", s.frame.width(), s.frame.height(), s.pts));
                format!("{shown}, {} pictures queued{}", st.frames.len(), if tile.awaiting { ", waiting for the new spot" } else { "" })
            };
            out.push(format!("{:?}: {state}", tile.camera));
        }
        out
    }

    /// Seconds from the start of the collection.
    pub fn position(&self) -> f64 {
        if let Some(t) = self.queued_seek {
            return t;
        }
        let before: f64 = self.durations.iter().take(self.segment).sum();
        before + self.clock.now()
    }

    /// Seconds into the clip that is playing.
    pub fn local_time(&self) -> f64 {
        self.clock.now()
    }

    pub fn total(&self) -> f64 {
        self.durations.iter().sum()
    }

    /// Whether every minute's real length is in (until then the total
    /// would change as they arrive).
    pub fn total_known(&self) -> bool {
        self.lengths_done
    }

    /// Local wall-clock time of what is on screen.
    pub fn wall_clock(&self) -> Option<LocalSecs> {
        self.segments.get(self.segment).map(|s| s.start + self.clock.now().floor() as i64)
    }

    /// Collection seconds where `wall` falls, for jumping to an event time.
    pub fn offset_of(segments: &[Segment], wall: LocalSecs) -> f64 {
        let Some(first) = segments.first() else { return 0.0 };
        (wall - first.start).max(0) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_estimated_from_file_names() {
        let seg = |start: i64| Segment { start, files: Default::default() };
        // Back to back, then a 10-minute gap, then the last minute.
        let s = [seg(0), seg(60), seg(121), seg(721)];
        assert_eq!(estimated_lengths(&s), vec![60.0, 61.0, DEFAULT_SEGMENT, DEFAULT_SEGMENT]);
        assert!(estimated_lengths(&[]).is_empty());
    }
}
