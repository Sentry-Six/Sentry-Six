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

use crate::library::Camera;
use crate::mp4::VideoTrack;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// A clip's first frame number and the time between its frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Start {
    pub seq: f64,
    pub interval: f64,
}

/// Bytes of the first frame read for its telemetry (it comes first).
const HEAD: usize = 16 * 1024;
/// Further apart than this, the counters aren't comparable (not Tesla's,
/// or a clip from another drive): no adjustment.
const MOST: f64 = 3.0;

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
    measured().lock().unwrap_or_else(|e| e.into_inner()).get(&camera).copied().unwrap_or_else(|| default_lag(camera))
}

/// New footage (perhaps another car's): measure again.
pub fn forget() {
    measured().lock().unwrap_or_else(|e| e.into_inner()).clear();
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
    let data = read(first.offset, (first.size as usize).min(HEAD))?;
    let m = crate::telemetry::sample_telemetry(&data, track.nal_length_size as usize, track.codec)?;
    (m.frame_seq_no > 0.0).then_some(Start { seq: m.frame_seq_no, interval: track.duration / n as f64 })
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
/// minute's reference clip (its front camera's) starting at `reference`:
/// by the counter with its lag taken off or, when the counters aren't
/// comparable (an HW3 car's back camera), as measured from the
/// telemetry's timing (`measure_times`); 0 until then, or without either.
pub fn offset(path: &Path, own: Option<Start>, reference: Option<Start>, camera: Camera) -> f64 {
    if comparable(own, reference) {
        offset_with(own, reference, lag(camera))
    } else {
        timed().lock().unwrap_or_else(|e| e.into_inner()).get(path).copied().flatten().unwrap_or(0.0)
    }
}

/// Whether two clips' counters can be compared (both have one, close).
pub fn comparable(own: Option<Start>, reference: Option<Start>) -> bool {
    matches!((own, reference), (Some(a), Some(r)) if ((a.seq - r.seq) * r.interval).abs() < MOST)
}

fn offset_with(own: Option<Start>, reference: Option<Start>, lag: f64) -> f64 {
    match (own, reference) {
        (Some(a), Some(r)) if comparable(own, reference) => (a.seq - lag - r.seq) * r.interval,
        _ => 0.0,
    }
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
    timed().lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf(), found);
    found
}

/// Measures, on a thread of its own, the time offsets of the minute's
/// clips (`files`) whose counters can't be compared with its front clip's.
pub fn measure_times(files: std::collections::BTreeMap<Camera, PathBuf>) {
    let Some(front) = files.get(&Camera::Front).cloned() else { return };
    // Only bookkeeping here (playback's thread): the clips are read on the
    // measuring thread.
    let todo: Vec<PathBuf> = {
        let mut t = timed().lock().unwrap_or_else(|e| e.into_inner());
        let todo: Vec<PathBuf> = files.into_values().filter(|p| *p != front && !t.contains_key(p)).collect();
        for p in &todo {
            t.insert(p.clone(), None);
        }
        todo
    };
    if todo.is_empty() {
        return;
    }
    let _ = std::thread::Builder::new().name("camera-sync-time".into()).spawn(move || {
        let todo: Vec<PathBuf> = todo.into_iter().filter(|p| !comparable(start(p), start(&front))).collect();
        if todo.is_empty() {
            return;
        }
        let Some(f) = series(&front, STRIDE) else { return };
        for path in todo {
            let found = series(&path, STRIDE).and_then(|c| best_time(&f, &c));
            if let Some(o) = found {
                log::info!("camera sync: {} starts {:+.0} ms from the front clip (by its timing)", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), o * 1000.0);
            }
            timed().lock().unwrap_or_else(|e| e.into_inner()).insert(path, found);
        }
    });
}

/// Measures each camera's lag from one minute of driving (`files`), on a
/// thread of its own; the cameras still unmeasured are tried again on the
/// next minute asked about.
pub fn measure(files: std::collections::BTreeMap<Camera, PathBuf>) {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(front) = files.get(&Camera::Front).cloned() else { return };
    let todo: Vec<(Camera, PathBuf)> = {
        let m = measured().lock().unwrap_or_else(|e| e.into_inner());
        files.into_iter().filter(|(c, _)| *c != Camera::Front && !m.contains_key(c)).collect()
    };
    if todo.is_empty() || RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("camera-sync".into()).spawn(move || {
        if let Some(f) = series(&front, STRIDE) {
            for (camera, path) in todo {
                if let Some(lag) = series(&path, STRIDE).and_then(|c| best_lag(&f, &c)) {
                    log::info!("camera sync: {camera:?} runs {lag:+.0} frames from the front camera");
                    measured().lock().unwrap_or_else(|e| e.into_inner()).insert(camera, lag);
                }
            }
        }
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
    if spawned.is_err() {
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
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
        let front = Some(Start { seq: 1_804_980.0, interval: 1.0 / 36.0 });
        let back = Some(Start { seq: 1_805_004.0, interval: 1.0 / 36.0 });
        assert!((offset_with(back, front, 0.0) - 24.0 / 36.0).abs() < 1e-9);
        assert!((offset_with(front, back, 0.0) + 24.0 / 36.0).abs() < 1e-9);
        // The back camera's counter 13 frames ahead: 11 frames later.
        assert!((offset_with(back, front, 13.0) - 11.0 / 36.0).abs() < 1e-9);
        assert_eq!(offset_with(None, front, 0.0), 0.0);
        // Not comparable.
        assert_eq!(offset_with(Some(Start { seq: 10.0, interval: 1.0 / 36.0 }), front, 0.0), 0.0);
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
            println!("{c:15} time {:?}  counter comparable {}", best_time(&front, &s).map(|o| (o * 1000.0).round()), comparable(start(&file(c)), start(&file("front"))));
        }
    }
}
