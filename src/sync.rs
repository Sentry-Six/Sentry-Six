//! Lining the cameras up. A minute's six clips don't start at the same
//! moment (up to about two thirds of a second apart), so starting them
//! together puts some cameras ahead of the others. Every frame carries the
//! car's frame counter, so each clip's first frame number says how far
//! after the minute's front clip it starts; playback and the export show
//! each camera that much later.
//!
//! The counter isn't quite the same moment on every camera: the telemetry
//! each camera stamps on its frames (speed, steering, signals) shows each
//! camera's counter running a few frames from the front's (the back
//! camera 13 on an HW4 car). That lag is measured for each car from a
//! minute of driving (`measure`) and taken off. A camera whose counter
//! can't be compared at all (an HW3 car's back camera) is lined up by the
//! telemetry's timing instead (`measure_times`).
//!
//! The car closes a minute's clips together, so each clip's length also
//! says when it started: a clip a third of a second shorter than the front
//! one started a third of a second later. That holds to about a frame on
//! HW3 and HW4 cars and needs no telemetry (a parked car's minutes have
//! none) or driving to match by, so it lines up every camera without a
//! measured counter lag, playback and export alike, and catches an HW3
//! back camera's counter that only happens to land near the front's. The
//! telemetry's timing is left for a clip cut short.

use crate::library::Camera;
use crate::mp4::VideoTrack;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// A clip's first frame number (0 without telemetry), the time between
/// its frames and its length.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Start {
    pub seq: f64,
    pub interval: f64,
    pub duration: f64,
}

/// Bytes of the first frame read for its telemetry (it comes first).
const HEAD: usize = 16 * 1024;
/// Further apart than this, the counters aren't comparable (not Tesla's,
/// or a clip from another drive): no adjustment.
const MOST: f64 = 3.0;
/// Clips of one minute start at most this far apart by their lengths
/// (2 in 1,000 are further: a clip cut short, so its length says nothing).
const END_MOST: f64 = 0.7;
/// A counter more than this from the clips' lengths only landed near the
/// front's by chance (an HW3 back camera's counter runs on its own).
const AGREE: f64 = 0.25;

/// Frames each camera's counter runs ahead of the front camera's for the
/// same moment, until measured (an HW4 car's).
fn default_lag(camera: Camera) -> f64 {
    match camera {
        Camera::Back => 13.0,
        Camera::LeftRepeater | Camera::RightRepeater => 1.0,
        _ => 0.0,
    }
}

/// The lags measured for the footage open now.
fn measured() -> &'static Mutex<HashMap<Camera, f64>> {
    static M: OnceLock<Mutex<HashMap<Camera, f64>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

/// Frames `camera`'s counter runs ahead of the front's for the same moment.
pub fn lag(camera: Camera) -> f64 {
    measured_lag(camera).unwrap_or_else(|| default_lag(camera))
}

fn measured_lag(camera: Camera) -> Option<f64> {
    measured().lock().unwrap_or_else(|e| e.into_inner()).get(&camera).copied()
}

/// A lag known for this car: measured, or the front's own (0).
fn known_lag(camera: Camera) -> Option<f64> {
    if camera == Camera::Front { Some(0.0) } else { measured_lag(camera) }
}

/// Bumped by `forget`: a measurement started before it is dropped.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The generation a lag measurement is running for (none: u64::MAX).
static RUNNING: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

/// New footage (perhaps another car's): measure again.
pub fn forget() {
    let mut m = measured().lock().unwrap_or_else(|e| e.into_inner());
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    m.clear();
}

/// The camera a clip file is from ("...-left_repeater.mp4").
pub fn camera_of(path: &Path) -> Option<Camera> {
    let stem = path.file_stem()?.to_str()?;
    Camera::from_suffix(stem.get(20..)?)
}

type Cache = Mutex<HashMap<PathBuf, Arc<OnceLock<Option<Start>>>>>;

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// A clip's start, from the cache or worked out by `read` (once: callers
/// at the same time wait for the first).
pub fn start_of(path: &Path, read: impl FnOnce() -> Option<Start>) -> Option<Start> {
    let cell = {
        let mut c = cache().lock().unwrap_or_else(|e| e.into_inner());
        // A few days of footage at most.
        if c.len() > 20_000 {
            c.clear();
        }
        c.entry(path.to_path_buf()).or_default().clone()
    };
    *cell.get_or_init(read)
}

/// A clip's start from its index and the first bytes of its first frame
/// (`read`: offset and length to bytes).
pub fn start_from(track: &VideoTrack, read: impl FnOnce(u64, usize) -> Option<Vec<u8>>) -> Option<Start> {
    let n = track.samples.len();
    let first = track.samples.first()?;
    if n < 2 || track.duration <= 0.0 {
        return None;
    }
    let seq = read(first.offset, (first.size as usize).min(HEAD))
        .and_then(|data| crate::telemetry::sample_telemetry(&data, track.nal_length_size as usize, track.codec))
        .map(|m| m.frame_seq_no)
        .filter(|s| *s > 0.0)
        .unwrap_or(0.0);
    Some(Start { seq, interval: track.duration / n as f64, duration: track.duration })
}

/// A clip's start, reading the file (its index and first frame).
pub fn read_start(path: &Path) -> Option<Start> {
    let file = std::fs::File::open(path).ok()?;
    let track = crate::mp4::read_video_track(&file).ok()?;
    start_from(&track, |offset, len| {
        let mut buf = vec![0u8; len];
        crate::mp4::read_at(&file, &mut buf, offset).ok().map(|_| buf)
    })
}

/// The cached start of `path`, read from the file if it isn't known yet.
pub fn start(path: &Path) -> Option<Start> {
    start_of(path, || read_start(path))
}

/// Seconds `camera`'s clip at `path`, starting at `own`, begins after the
/// minute's reference clip starting at `reference`: by the counters with
/// this car's measured lags taken off, else by the clips' lengths; for a
/// clip cut short, by the telemetry's timing against the front clip
/// (`measure_times`) once known; else 0.
///
/// `reference_camera`: the reference clip's camera (the front, or another
/// when the minute has no front clip); its lag counts too.
pub fn offset(path: &Path, own: Option<Start>, reference: Option<Start>, camera: Camera, reference_camera: Camera) -> f64 {
    if comparable(own, reference, camera, reference_camera) {
        if let (Some(a), Some(b)) = (known_lag(camera), known_lag(reference_camera)) {
            return offset_with(own, reference, a - b);
        }
    }
    if let Some(o) = end_offset(own, reference) {
        return o;
    }
    if reference_camera == Camera::Front {
        if let Some(t) = timed_offset(path) {
            return t;
        }
    }
    0.0
}

/// The offset against the front clip measured from the telemetry's timing
/// for `path`, once known.
pub fn timed_offset(path: &Path) -> Option<f64> {
    timed().lock().unwrap_or_else(|e| e.into_inner()).get(path).copied().flatten()
}

/// Whether `path`'s offset needs the telemetry's timing: its counter can't
/// be compared with the front's and the clips' lengths say nothing.
pub fn needs_timing(own: Option<Start>, front: Option<Start>, camera: Camera) -> bool {
    counted(own, front) && end_offset(own, front).is_none() && !comparable(own, front, camera, Camera::Front)
}

/// Seconds a clip starts after the minute's front clip by their lengths
/// (the car closes them together); None for a clip cut short.
pub fn end_offset(own: Option<Start>, reference: Option<Start>) -> Option<f64> {
    let (a, r) = (own?, reference?);
    let o = r.duration - a.duration;
    (o.abs() <= END_MOST).then_some(o)
}

/// Whether both clips carry the car's frame counter.
pub fn counted(own: Option<Start>, reference: Option<Start>) -> bool {
    matches!((own, reference), (Some(a), Some(r)) if a.seq > 0.0 && r.seq > 0.0)
}

/// Whether `camera`'s counter can be compared with the reference clip's:
/// both have one, close, and saying about the same start as the clips'
/// lengths. A clip cut short (lengths say nothing) is compared only with
/// a lag measured on this car, which an HW3 back camera never gets.
pub fn comparable(own: Option<Start>, reference: Option<Start>, camera: Camera, reference_camera: Camera) -> bool {
    let (Some(a), Some(r)) = (own, reference) else { return false };
    if !counted(own, reference) || ((a.seq - r.seq) * r.interval).abs() >= MOST {
        return false;
    }
    match end_offset(own, reference) {
        Some(e) => (offset_with_unchecked(a, r, lag(camera) - lag(reference_camera)) - e).abs() < AGREE,
        None => known_lag(camera).is_some() && known_lag(reference_camera).is_some(),
    }
}

fn offset_with(own: Option<Start>, reference: Option<Start>, lag: f64) -> f64 {
    match (own, reference) {
        (Some(a), Some(r)) if counted(own, reference) && ((a.seq - r.seq) * r.interval).abs() < MOST => offset_with_unchecked(a, r, lag),
        _ => 0.0,
    }
}

fn offset_with_unchecked(a: Start, r: Start, lag: f64) -> f64 {
    (a.seq - lag - r.seq) * r.interval
}

/// Offsets measured from the telemetry's timing, per clip (None: being
/// measured, or no answer).
fn timed() -> &'static Mutex<HashMap<PathBuf, Option<f64>>> {
    static T: OnceLock<Mutex<HashMap<PathBuf, Option<f64>>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Frames between the telemetry read for measuring (each read waits on the
/// drive or the share; speed and steering change smoothly between them).
const STRIDE: usize = 8;

/// One frame's telemetry: its counter, its time in the clip, speed and
/// steering.
type Point = (f64, f64, f64, f64);

/// One clip's telemetry along it, for every `stride`th frame.
fn series(path: &Path, stride: usize) -> Option<Vec<Point>> {
    let file = std::fs::File::open(path).ok()?;
    let track = crate::mp4::read_video_track(&file).ok()?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 2048];
    for (k, s) in track.samples.iter().enumerate().step_by(stride) {
        let n = (s.size as usize).min(buf.len());
        if crate::mp4::read_at(&file, &mut buf[..n], s.offset).is_err() {
            continue;
        }
        if let Some(m) = crate::telemetry::sample_telemetry(&buf[..n], track.nal_length_size as usize, track.codec) {
            out.push((m.frame_seq_no, track.pts_secs(k), m.vehicle_speed_mps, m.steering_wheel_angle));
        }
        // Playback reads the same share: leave it room.
        if k % (16 * STRIDE) == 0 {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    Some(out)
}

/// The lag (frames) at which `cam`'s speed and steering, by counter, best
/// match the front's; None without enough driving to tell, or no clear
/// best.
fn best_lag(front: &[Point], cam: &[Point]) -> Option<f64> {
    if !moving(front, cam) {
        return None;
    }
    let errors: Vec<(f64, f64)> = (-40..=40).filter_map(|lag| mismatch(front, cam, |f| f.0, lag as f64, 3.0 * STRIDE as f64).map(|e| (lag as f64, e))).collect();
    clear_best(&errors, 4.0)
}

/// The offset (seconds the camera's clip starts after the front's) at
/// which `cam`'s speed and steering, by their times in the clips, best
/// match the front's: for cameras whose counters can't be compared.
fn best_time(front: &[Point], cam: &[Point]) -> Option<f64> {
    if !moving(front, cam) {
        return None;
    }
    // The camera's time t + tau shows the front's moment t (half-frame steps).
    let gap = 3.0 * STRIDE as f64 / 30.0;
    let errors: Vec<(f64, f64)> = (-144..=144).filter_map(|k| {
        let tau = k as f64 / 72.0;
        mismatch(front, cam, |f| f.1, tau, gap).map(|e| (tau, e))
    }).collect();
    // A clip whose moment t is at its own t + tau started tau earlier.
    clear_best(&errors, 4.0 / 36.0).map(|tau| -tau)
}

/// Whether there's driving to match by (not parked or cruising dead
/// straight), with enough telemetry.
fn moving(front: &[Point], cam: &[Point]) -> bool {
    let std = |v: &mut dyn Iterator<Item = f64>| {
        let v: Vec<f64> = v.collect();
        let mean = v.iter().sum::<f64>() / v.len().max(1) as f64;
        (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / v.len().max(1) as f64).sqrt()
    };
    front.len() >= 200 && cam.len() >= 200 && (std(&mut front.iter().map(|f| f.2)) >= 0.5 || std(&mut front.iter().map(|f| f.3)) >= 3.0)
}

/// How far `cam`'s speed and steering are from the front's with `cam`
/// moved by `shift` along `key` (the counter or the time), between its
/// samples (no further apart than `gap`); None with too little overlap.
fn mismatch(front: &[Point], cam: &[Point], key: fn(&Point) -> f64, shift: f64, gap: f64) -> Option<f64> {
    let at = |x: f64| -> Option<(f64, f64)> {
        let i = cam.partition_point(|c| key(c) < x);
        let (a, b) = (cam.get(i.checked_sub(1)?)?, cam.get(i)?);
        let (ka, kb) = (key(a), key(b));
        if kb - ka > gap || kb <= ka {
            return None;
        }
        let k = (x - ka) / (kb - ka);
        Some((a.2 + (b.2 - a.2) * k, a.3 + (b.3 - a.3) * k))
    };
    let d: Vec<f64> = front.iter().filter_map(|f| at(key(f) + shift).map(|(sp, st)| (sp - f.2).powi(2) * 100.0 + (st - f.3).powi(2))).collect();
    (d.len() > front.len() / 2).then(|| d.iter().sum::<f64>() / d.len() as f64)
}

/// The best of `errors` ((shift, error) pairs), if clearly better than
/// anything at least `apart` away.
fn clear_best(errors: &[(f64, f64)], apart: f64) -> Option<f64> {
    let (best, err) = errors.iter().copied().min_by(|a, b| a.1.total_cmp(&b.1))?;
    let next = errors.iter().filter(|e| (e.0 - best).abs() >= apart - 1e-9).map(|e| e.1).fold(f64::MAX, f64::min);
    (err * 3.0 < next).then_some(best)
}

/// The time offset of `path` against the minute's front clip `front`,
/// measured now (the export, which can't wait for a background answer).
pub fn time_offset_now(path: &Path, front: &Path) -> Option<f64> {
    if let Some(known) = timed().lock().unwrap_or_else(|e| e.into_inner()).get(path).copied().flatten() {
        return Some(known);
    }
    let found = series(front, STRIDE).zip(series(path, STRIDE)).and_then(|(f, c)| best_time(&f, &c));
    remember_timing(path.to_path_buf(), found);
    found.or_else(|| timed_offset(path))
}

/// Keeps a measured timing; a measurement without an answer never replaces
/// one with an answer (two can run for the same clip).
fn remember_timing(path: PathBuf, found: Option<f64>) {
    let mut t = timed().lock().unwrap_or_else(|e| e.into_inner());
    if found.is_some() || !matches!(t.get(&path), Some(Some(_))) {
        t.insert(path, found);
    }
}

/// Measures, on a thread of its own, the time offsets of the minute's
/// clips (`files`) whose counters can't be compared with its front clip's.
pub fn measure_times(files: std::collections::BTreeMap<Camera, PathBuf>) {
    let Some(front) = files.get(&Camera::Front).cloned() else { return };
    // Only bookkeeping here (playback's thread): the clips are read on the
    // measuring thread.
    let todo: Vec<(Camera, PathBuf)> = {
        let mut t = timed().lock().unwrap_or_else(|e| e.into_inner());
        let todo: Vec<(Camera, PathBuf)> = files.into_iter().filter(|(_, p)| *p != front && !t.contains_key(p)).collect();
        for (_, p) in &todo {
            t.insert(p.clone(), None);
        }
        todo
    };
    if todo.is_empty() {
        return;
    }
    let _ = std::thread::Builder::new().name("camera-sync-time".into()).spawn(move || {
        let todo: Vec<PathBuf> = todo.into_iter().filter(|(c, p)| needs_timing(start(p), start(&front), *c)).map(|(_, p)| p).collect();
        if todo.is_empty() {
            return;
        }
        let Some(f) = series(&front, STRIDE) else { return };
        for path in todo {
            let found = series(&path, STRIDE).and_then(|c| best_time(&f, &c));
            if let Some(o) = found {
                log::info!("camera sync: {} starts {:+.0} ms from the front clip (by its timing)", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), o * 1000.0);
            }
            remember_timing(path, found);
        }
    });
}

/// Measures each camera's lag from one minute of driving (`files`), on a
/// thread of its own; the cameras still unmeasured are tried again on the
/// next minute asked about.
pub fn measure(files: std::collections::BTreeMap<Camera, PathBuf>) {
    use std::sync::atomic::Ordering::SeqCst;
    let Some(front) = files.get(&Camera::Front).cloned() else { return };
    let generation = GENERATION.load(SeqCst);
    let todo: Vec<(Camera, PathBuf)> = {
        let m = measured().lock().unwrap_or_else(|e| e.into_inner());
        files.into_iter().filter(|(c, _)| *c != Camera::Front && !m.contains_key(c)).collect()
    };
    // One measurement per footage at a time; one for older footage doesn't
    // hold up the new footage's.
    if todo.is_empty() || RUNNING.swap(generation, SeqCst) == generation {
        return;
    }
    let spawned = std::thread::Builder::new().name("camera-sync".into()).spawn(move || {
        if let Some(f) = series(&front, STRIDE) {
            for (camera, path) in todo {
                if let Some(lag) = series(&path, STRIDE).and_then(|c| best_lag(&f, &c)) {
                    // Only for the footage it was measured on.
                    let mut m = measured().lock().unwrap_or_else(|e| e.into_inner());
                    if GENERATION.load(SeqCst) != generation {
                        break;
                    }
                    log::info!("camera sync: {camera:?} runs {lag:+.0} frames from the front camera");
                    m.insert(camera, lag);
                }
            }
        }
        let _ = RUNNING.compare_exchange(generation, u64::MAX, SeqCst, SeqCst);
    });
    if spawned.is_err() {
        let _ = RUNNING.compare_exchange(generation, u64::MAX, SeqCst, SeqCst);
    }
}

/// The clip a minute's timeline follows (its front camera's, or the
/// first): the same one its length is read from.
pub fn reference(files: &std::collections::BTreeMap<crate::library::Camera, PathBuf>) -> Option<&PathBuf> {
    files.get(&crate::library::Camera::Front).or_else(|| files.values().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_from_frame_numbers() {
        let front = Some(Start { seq: 1_804_980.0, interval: 1.0 / 36.0, duration: 60.0 });
        let back = Some(Start { seq: 1_805_004.0, interval: 1.0 / 36.0, duration: 60.0 });
        assert!((offset_with(back, front, 0.0) - 24.0 / 36.0).abs() < 1e-9);
        assert!((offset_with(front, back, 0.0) + 24.0 / 36.0).abs() < 1e-9);
        // The back camera's counter 13 frames ahead: 11 frames later.
        assert!((offset_with(back, front, 13.0) - 11.0 / 36.0).abs() < 1e-9);
        assert_eq!(offset_with(None, front, 0.0), 0.0);
        // Not comparable.
        assert_eq!(offset_with(Some(Start { seq: 10.0, interval: 1.0 / 36.0, duration: 60.0 }), front, 0.0), 0.0);
    }

    fn clip(seq: f64, duration: f64) -> Option<Start> {
        Some(Start { seq, interval: 1.0 / 36.0, duration })
    }

    #[test]
    fn offsets_from_clip_lengths() {
        // A clip a third of a second shorter started a third of a second later.
        assert!((end_offset(clip(0.0, 59.4), clip(0.0, 59.733)).unwrap() - 0.333).abs() < 1e-9);
        assert!((end_offset(clip(0.0, 60.1), clip(0.0, 59.6)).unwrap() + 0.5).abs() < 1e-9);
        // A clip cut short says nothing.
        assert_eq!(end_offset(clip(0.0, 45.0), clip(0.0, 59.6)), None);
        assert_eq!(end_offset(None, clip(0.0, 59.6)), None);
    }

    #[test]
    fn counters_must_agree_with_lengths() {
        // An HW4 back camera: counter 19 ahead, lag 13, lengths say 0.17 s.
        let front = clip(1_000.0, 60.0);
        assert!(comparable(clip(1_019.0, 59.83), front, Camera::Back, Camera::Front));
        // An HW3 back camera whose own counter lands 52 frames from the
        // front's while its clip started 0.34 s later: not comparable.
        assert!(!comparable(clip(1_052.0, 59.66), front, Camera::Back, Camera::Front));
        // No telemetry: not counted, not comparable.
        assert!(!counted(clip(0.0, 59.7), front));
        assert!(!comparable(clip(0.0, 59.7), front, Camera::Back, Camera::Front));
    }

    #[test]
    fn offset_until_measured_is_by_lengths() {
        let p = Path::new("/nonexistent/2026-01-01_00-00-00-back.mp4");
        // Not comparable, not timed: by the lengths, not 0.
        assert!((offset(p, clip(5_000.0, 59.66), clip(1_000.0, 60.0), Camera::Back, Camera::Front) - 0.34).abs() < 1e-9);
        // No telemetry at all (parked): still by the lengths.
        assert!((offset(p, clip(0.0, 59.8), clip(0.0, 60.0), Camera::RightRepeater, Camera::Front) - 0.2).abs() < 1e-9);
        // A clip cut short and no counters: 0, as before.
        assert_eq!(offset(p, clip(0.0, 30.0), clip(0.0, 60.0), Camera::Back, Camera::Front), 0.0);
        // Counters close but the clip cut short, and no lag measured: not
        // trusted (an HW3 back camera's counter runs on its own).
        assert!(!comparable(clip(1_052.0, 30.0), clip(1_000.0, 60.0), Camera::Back, Camera::Front));
        // The front camera against another reference: its own lag is 0, and
        // by the lengths until the other camera's lag is measured.
        assert!((offset(p, clip(1_000.0, 59.9), clip(1_001.0, 60.0), Camera::Front, Camera::LeftRepeater) - 0.1).abs() < 1e-9);
        // A clip against itself (the minute's only camera): 0.
        assert_eq!(offset(p, clip(1_000.0, 60.0), clip(1_000.0, 60.0), Camera::LeftRepeater, Camera::LeftRepeater), 0.0);
    }

    /// Each camera's measured lag in a minute of driving (SENTRY_SYNC_DIR,
    /// SENTRY_SYNC_MINUTE: "2026-01-15_08-00-00").
    #[test]
    #[ignore]
    fn measured_lags() {
        let (Some(dir), Some(minute)) = (std::env::var_os("SENTRY_SYNC_DIR"), std::env::var("SENTRY_SYNC_MINUTE").ok()) else { return };
        let dir = PathBuf::from(dir);
        let file = |c: &str| dir.join(format!("{minute}-{c}.mp4"));
        let began = std::time::Instant::now();
        let front = series(&file("front"), STRIDE).unwrap();
        println!("front read in {:?}", began.elapsed());
        for c in ["back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"] {
            let began = std::time::Instant::now();
            let s = series(&file(c), STRIDE);
            let read = began.elapsed();
            println!("{c:15} {:?} (read {read:?}, matched {:?})", s.and_then(|s| best_lag(&front, &s)), began.elapsed() - read);
        }
    }

    /// Each camera's time offset in a minute (SENTRY_SYNC_DIR,
    /// SENTRY_SYNC_MINUTE), by the telemetry's timing.
    #[test]
    #[ignore]
    fn measured_times() {
        let (Some(dir), Some(minute)) = (std::env::var_os("SENTRY_SYNC_DIR"), std::env::var("SENTRY_SYNC_MINUTE").ok()) else { return };
        let dir = PathBuf::from(dir);
        let file = |c: &str| dir.join(format!("{minute}-{c}.mp4"));
        let front = series(&file("front"), STRIDE).unwrap();
        for c in ["back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"] {
            let Some(s) = series(&file(c), STRIDE) else { continue };
            println!("{c:15} time {:?}  counter comparable {}", best_time(&front, &s).map(|o| (o * 1000.0).round()), comparable(start(&file(c)), start(&file("front")), camera_named(c), Camera::Front));
        }
    }

    fn camera_named(c: &str) -> Camera {
        match c {
            "back" => Camera::Back,
            "left_repeater" => Camera::LeftRepeater,
            "right_repeater" => Camera::RightRepeater,
            "left_pillar" => Camera::LeftPillar,
            "right_pillar" => Camera::RightPillar,
            _ => Camera::Front,
        }
    }
}
