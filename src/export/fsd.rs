//! The Self-Driving view: the car's path drawn on the road in the front
//! camera, as Tesla's Self-Driving display draws it, with the speed, gear
//! and Autopilot state in the camera's top corners.
//!
//! The car records no planned path, so this one is made from the front
//! clip's telemetry, laid on the road as the front camera sees it. Near
//! the car (the bottom of the path's picture) it is the arc the car is
//! turning along in that frame: where the steering wheel is turned to, as
//! sharp as the car's heading shows that to be, so it turns as the car
//! does. Further off (the top of its picture) it goes over to how the car
//! turned as it drove on, so its far end leans into the bend that is
//! coming. (All of it drawn from where the car drove next, the whole path
//! turned before the car did; all of it from the wheel, it showed nothing
//! of the road ahead.) The path is blue while Self-Driving or Autosteer
//! steers and grey while the driver does, and chevrons run down it towards
//! the car while it slows.
//!
//! The road is taken to be flat, and the camera to look straight ahead from
//! `CAMERA_HEIGHT` up: on a crest or in a dip the path floats or sinks a
//! little.

use super::overlay::{Painter, Picture};
use crate::library::{Camera, LocalSecs, Segment};
use crate::sei::SeiMetadata;
use iced::widget::canvas::{self, Frame, Path, Text};
use iced::{mouse, Color, Point, Rectangle, Renderer, Size, Theme};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// The Self-Driving view as set up.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SelfDriving {
    /// The speed, gear, Autopilot state and time in the camera's top corners.
    pub hud: bool,
    pub metric: bool,
    pub h24: bool,
    /// Where the road meets the sky in the front camera, as a share of its
    /// height from the top; None: the usual place for the footage.
    pub horizon: Option<f32>,
    /// Where a straight road runs to, as a share of the camera's width from
    /// the left; None: its middle. Cameras are fitted a degree or so to one
    /// side or the other.
    pub center: Option<f32>,
    /// How wide the front camera sees, in degrees; None: the footage's usual.
    pub fov: Option<f32>,
}

/// The front camera, as the path is laid on the road through it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lens {
    /// The horizon, as a share of the picture's height from its top.
    pub horizon: f32,
    /// Straight ahead, as a share of the picture's width from its left.
    pub center: f32,
    /// The focal length, as a share of the picture's width.
    pub focal: f32,
}

impl SelfDriving {
    /// How far the horizon, the centre and the camera's angle can be set.
    pub const HORIZONS: (f32, f32) = (0.30, 0.70);
    pub const CENTERS: (f32, f32) = (0.40, 0.60);
    pub const FOVS: (f32, f32) = (25.0, 100.0);

    /// The horizon in footage `front` big: the middle of the picture in the
    /// 1280 x 960 (HW3) front camera's footage, and taken to be in the
    /// 2896 x 1876 (HW4) one's (not measured).
    pub fn usual_horizon(_front: (u32, u32)) -> f32 {
        0.5
    }

    /// The front camera's angle. HW3's is measured from footage (road marks
    /// passing at a known speed); HW4's wider camera is an estimate.
    pub fn usual_fov(front: (u32, u32)) -> f32 {
        if front.0 >= 2000 {
            58.0
        } else {
            40.0
        }
    }

    /// The camera as set up, for footage `front` big.
    pub fn lens(&self, front: (u32, u32)) -> Lens {
        let horizon = self.horizon.unwrap_or_else(|| Self::usual_horizon(front)).clamp(Self::HORIZONS.0, Self::HORIZONS.1);
        let fov = self.fov.unwrap_or_else(|| Self::usual_fov(front)).clamp(Self::FOVS.0, Self::FOVS.1);
        let center = self.center.unwrap_or(0.5).clamp(Self::CENTERS.0, Self::CENTERS.1);
        Lens { horizon, center, focal: 0.5 / (fov.to_radians() / 2.0).tan() }
    }
}

impl Lens {
    /// How far ahead (metres) the road is at the bottom edge of the
    /// camera's picture, `camera` big: nothing nearer is in it.
    pub fn nearest(&self, camera: (f32, f32)) -> f32 {
        self.focal * camera.0 * CAMERA_HEIGHT / (camera.1 * (1.0 - self.horizon)).max(1.0)
    }
}

/// The front camera's height over the road in metres (a Model 3's; the
/// taller cars' are within a few tenths).
const CAMERA_HEIGHT: f32 = 1.25;
/// The path's width in metres: about the car's.
const WIDTH: f32 = 1.8;
/// The path's length, in seconds of driving at the car's speed: how far
/// ahead its far part looks. Long enough that, coming out of a turn in
/// town, it reaches the street the car is turning into (at 1.6 s it ended
/// in the junction, and seemed to point off the road).
const LOOK_SECS: f64 = 2.6;
/// Where the path goes over from the curve the car is turning along to
/// the curve it turns along as it drives on: between these shares of the
/// way up it as the camera sees it, from the picture's bottom edge to the
/// path's far end. Below, the wheel as it is; above, as it will be.
const HANDOVER: (f64, f64) = (0.35, 0.65);
/// The path's shortest and longest, in metres (longer, it would mostly lie
/// over the car in front).
const REACH: (f64, f64) = (7.0, 32.0);
/// Every other frame's telemetry is read (18 a second; the heading changes
/// 10 times a second).
const STRIDE: usize = 2;

// ---------------------------------------------------------------------------
// A clip's telemetry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct Sample {
    /// Seconds into the clip.
    t: f64,
    /// Metres a second.
    speed: f64,
    /// How sharply the car turns (1/m, right positive).
    curve: f64,
}

/// A clip's telemetry along it, as the path needs it.
#[derive(Debug, Default)]
pub struct Series {
    samples: Vec<Sample>,
}

/// The road's curve (1/m, right positive) the steering wheel is turned to
/// at `speed`: 0.0005 a degree at a crawl and less the faster it goes, as
/// measured from a Model 3's telemetry (its heading against its steering).
fn curvature(steering: f64, speed: f64) -> f64 {
    5.0e-4 * steering / (1.0 + (speed / 34.0).powi(2))
}

/// How many frames late the heading's turn (`heading`: radians a second at
/// each frame read, `per_frame` seconds apart) runs behind the steering
/// wheel's (`wheel`). The heading in a frame is an old one: on the car
/// measured, its turn matched the picture's own (the far scenery sliding
/// sideways between frames) 0.58 s after it, and the wheel's with no delay
/// at all. Compared frame for frame, the heading made the path too gentle
/// going into a turn and too tight coming out of it. How late is found for
/// each clip, as the delay (up to 1.2 s) at which the two match best; where
/// the car hardly turns, or they never match well, it is taken to be 0.55 s.
fn lateness(wheel: &[f64], heading: &[Option<f64>], per_frame: f64) -> usize {
    let frames = |secs: f64| (secs / per_frame.max(1e-3)).round() as usize;
    let mut best = (0.0, frames(0.55));
    // Turning 2 degrees a second on the whole, or there is nothing to match.
    if wheel.iter().map(|w| w * w).sum::<f64>() < 0.035f64.powi(2) * wheel.len() as f64 {
        return best.1;
    }
    for late in 0..=frames(1.2) {
        let (mut both, mut w2, mut h2) = (0.0, 0.0, 0.0);
        for (i, w) in wheel.iter().enumerate() {
            if let Some(Some(h)) = heading.get(i + late) {
                both += w * h;
                w2 += w * w;
                h2 += h * h;
            }
        }
        let alike = if w2 > 0.0 && h2 > 0.0 { both / (w2 * h2).sqrt() } else { 0.0 };
        if alike > best.0 {
            best = (alike, late);
        }
    }
    if best.0 >= 0.6 {
        best.1
    } else {
        frames(0.55)
    }
}

impl Series {
    /// Reads a clip's telemetry: the start of every `STRIDE`th frame (the
    /// SEI comes before the picture).
    fn read(path: &std::path::Path) -> Series {
        let Ok(file) = std::fs::File::open(path) else { return Series::default() };
        let Ok(track) = crate::mp4::read_video_track(&file) else { return Series::default() };
        let mut raw: Vec<(f64, SeiMetadata)> = Vec::with_capacity(track.samples.len() / STRIDE + 1);
        let mut buf = vec![0u8; 1024];
        for (k, s) in track.samples.iter().enumerate().step_by(STRIDE) {
            let n = (s.size as usize).min(buf.len());
            if crate::mp4::read_at(&file, &mut buf[..n], s.offset).is_err() {
                continue;
            }
            if let Some(m) = crate::telemetry::sample_telemetry(&buf[..n], track.nal_length_size as usize, track.codec) {
                raw.push((track.pts_secs(k), m));
            }
        }
        raw.sort_by(|a, b| a.0.total_cmp(&b.0));
        Series::from_telemetry(&raw)
    }

    /// `raw`: each frame's time in the clip and telemetry, in order.
    fn from_telemetry(raw: &[(f64, SeiMetadata)]) -> Series {
        let Some(first) = raw.first() else { return Series::default() };
        let n = raw.len();
        let speed = |i: usize| raw[i].1.vehicle_speed_mps.abs();
        // What the steering wheel is turned to: it says when the car turns
        // and which way, at once and smoothly.
        let by_wheel: Vec<f64> = (0..n).map(|i| curvature(raw[i].1.steering_wheel_angle, speed(i))).collect();
        // How sharp that really is depends on the car (its steering's
        // gearing, its wheelbase): the heading's turn for the distance
        // covered says, once it is put back in step with the wheel.
        // Without GPS there is no heading: the wheel alone.
        let compass = raw.iter().filter(|(_, m)| crate::sei::has_valid_gps(m)).count() * 2 >= n;
        let mut by_heading = vec![None; n];
        if compass {
            // The heading arrives 10 times a second and is held between:
            // each new value is taken to be from halfway back to the frame
            // read before, and the frames between two values lie on the
            // line between them.
            let mut knots: Vec<(f64, f64)> = vec![(first.0, first.1.heading_deg)];
            for pair in raw.windows(2) {
                let ((before, a), (t, b)) = (&pair[0], &pair[1]);
                if b.heading_deg != a.heading_deg {
                    let turned = (b.heading_deg - a.heading_deg + 540.0).rem_euclid(360.0) - 180.0;
                    let so_far = knots.last().map_or(0.0, |k| k.1);
                    knots.push(((before + t) / 2.0, so_far + turned));
                }
            }
            let mut headings = Vec::with_capacity(n);
            let mut k = 0;
            for (t, _) in raw {
                while k + 2 < knots.len() && knots[k + 1].0 <= *t {
                    k += 1;
                }
                let (a, b) = (knots[k], knots.get(k + 1).copied().unwrap_or(knots[k]));
                // Past the last value: on along the last line, for at most
                // the 0.1 s until the next would have come.
                let x = if b.0 > a.0 { ((t - a.0) / (b.0 - a.0)).clamp(0.0, 1.0 + 0.1 / (b.0 - a.0)) } else { 0.0 };
                headings.push(a.1 + (b.1 - a.1) * x);
            }
            // How fast it turns (radians a second), over a third of a second.
            let turning: Vec<Option<f64>> = (0..n)
                .map(|i| {
                    let (a, b) = (i.saturating_sub(3), (i + 3).min(n - 1));
                    let dt = raw[b].0 - raw[a].0;
                    (dt >= 0.05).then(|| (headings[b] - headings[a]).to_radians() / dt)
                })
                .collect();
            // The heading runs late (see `lateness`): each frame's is the
            // one that many frames on. Per metre covered; at a crawl that
            // says nothing, and is left out.
            let wheel_turning: Vec<f64> = (0..n).map(|i| speed(i) * by_wheel[i]).collect();
            let late = lateness(&wheel_turning, &turning, (raw[n - 1].0 - first.0) / (n - 1).max(1) as f64);
            for (i, turn) in by_heading.iter_mut().enumerate() {
                if let Some(rate) = turning.get(i + late).copied().flatten().filter(|_| speed(i) >= 1.0) {
                    *turn = Some(rate / speed(i));
                }
            }
        }
        let samples = (0..n)
            .map(|i| {
                // The wheel's curve times how the heading's has compared
                // with it over the two seconds around. Frames count from
                // 2 m/s (fully from 5: slower, the heading's turn per metre
                // is mostly noise), and two frames' worth always says 1:
                // as the car slows to a stop the wheel is taken more and
                // more at its word, with no jump when the last moving
                // frame is two seconds gone.
                let (mut both, mut wheel, mut all) = (0.0, 0.0, 0.0);
                let around = i.saturating_sub(18)..=(i + 18).min(n - 1);
                let frames = (around.end() - around.start() + 1) as f64;
                for j in around {
                    all += by_wheel[j] * by_wheel[j];
                    if let Some(turn) = by_heading[j] {
                        let x = ((speed(j) - 2.0) / 3.0).clamp(0.0, 1.0);
                        let moving = x * x * (3.0 - 2.0 * x);
                        both += moving * turn * by_wheel[j];
                        wheel += moving * by_wheel[j] * by_wheel[j];
                    }
                }
                let word = 2.0 * all / frames + 1e-12;
                let geared = ((both + word) / (wheel + word)).clamp(0.4, 2.5);
                // No sharper than a car can turn.
                Sample { t: raw[i].0, speed: speed(i), curve: (by_wheel[i] * geared).clamp(-0.25, 0.25) }
            })
            .collect();
        Series { samples }
    }

    /// The telemetry `t` seconds into the clip, between the frames read;
    /// None past the clip's ends (by more than a few frames).
    fn at(&self, t: f64) -> Option<Sample> {
        let (first, last) = (self.samples.first()?, self.samples.last()?);
        if t < first.t - 0.25 || t > last.t + 0.25 {
            return None;
        }
        let i = self.samples.partition_point(|s| s.t <= t);
        if i == 0 {
            return Some(*first);
        }
        let Some(b) = self.samples.get(i) else { return Some(*last) };
        let a = self.samples[i - 1];
        let x = if b.t > a.t { (t - a.t) / (b.t - a.t) } else { 0.0 };
        let mix = |p: f64, q: f64| p + (q - p) * x;
        Some(Sample { t, speed: mix(a.speed, b.speed), curve: mix(a.curve, b.curve) })
    }
}

/// The clips' telemetry, kept for the rest of the session: None while one
/// is being read.
fn cache() -> &'static Mutex<HashMap<PathBuf, Option<Arc<Series>>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<Arc<Series>>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn keep(path: &std::path::Path, series: Arc<Series>) {
    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    // A few days of driving at most.
    if cache.len() >= 5000 {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), Some(series));
}

/// A clip's telemetry, read now if it hasn't been (an export's thread).
fn series(path: &std::path::Path) -> Arc<Series> {
    if let Some(Some(s)) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        return s.clone();
    }
    let s = Arc::new(Series::read(path));
    keep(path, s.clone());
    s
}

/// A clip's telemetry if it has been read; if not, it is read on a thread
/// of its own for next time (the window's drawing can't wait for a share).
fn series_soon(path: &std::path::Path) -> Option<Arc<Series>> {
    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    match cache.get(path) {
        Some(s) => s.clone(),
        None => {
            cache.insert(path.to_path_buf(), None);
            let path = path.to_path_buf();
            let spawned = std::thread::Builder::new().name("self-driving-path".into()).spawn({
                let path = path.clone();
                move || keep(&path, Arc::new(Series::read(&path)))
            });
            if spawned.is_err() {
                cache.remove(&path);
            }
            None
        }
    }
}

// ---------------------------------------------------------------------------
// The path ahead
// ---------------------------------------------------------------------------

/// The road ahead of the car at one moment.
#[derive(Debug, Clone, PartialEq)]
pub struct Ahead {
    /// The path from the car, along it: metres to the right and ahead.
    pub points: Vec<(f32, f32)>,
    /// How the speed is changing, in m/s² (slowing is negative).
    pub accel: f32,
}

/// The path from the car `t` seconds into `clip`, as far as it drives in
/// `LOOK_SECS` at its speed (never shorter than a stub in front of the
/// car), and how its speed is changing. Near the car it curves as the car
/// is turning just then; further off, as the car turns by the time it is
/// there (on into `next`, the clip after); see `HANDOVER`. `near`: how far
/// ahead the road is at the bottom of the camera's picture
/// (`Lens::nearest`). None without telemetry there.
fn ahead(clip: &Series, next: Option<&Series>, t: f64, near: f64) -> Option<Ahead> {
    let now = clip.at(t)?;
    let reach = (now.speed * LOOK_SECS).clamp(REACH.0, REACH.1);
    // The frames that follow, the next clip's taken to come straight after
    // this one's last.
    let end = clip.samples.last()?.t;
    let later = |at: f64| -> Option<Sample> {
        match next.and_then(|n| Some((n, n.samples.first()?.t))) {
            Some((n, first)) if at > end => n.at(at - end + first),
            _ => clip.at(at),
        }
    };
    // How the car turns over the next `LOOK_SECS`: its curve, by how far
    // along it has driven.
    const STEP: f64 = 0.05;
    let mut drive = vec![(0.0f64, now.curve)];
    let mut length = 0.0f64;
    let mut last = now;
    for step in 0..(LOOK_SECS / STEP).round() as usize {
        if length >= reach {
            break;
        }
        let Some(s) = later(t + (step as f64 + 0.5) * STEP) else { break };
        let d = s.speed * STEP;
        if d > 0.0 {
            drive.push((length + d / 2.0, s.curve));
        }
        length += d;
        last = s;
    }
    let driven = |s: f64| -> f64 {
        let i = drive.partition_point(|p| p.0 <= s);
        match (i.checked_sub(1).map(|i| drive[i]), drive.get(i)) {
            (Some(a), Some(b)) => a.1 + (b.1 - a.1) * (s - a.0) / (b.0 - a.0).max(1e-9),
            // Further than it gets in that time (it is stopping, or the
            // footage ends): as it is turning by then.
            _ => last.curve,
        }
    };
    // How much of that, against its curve now, `s` metres along: by how
    // far up the path's picture that is (the road `s` ahead is 1 / s below
    // the horizon), eased from one to the other.
    let share = |s: f64| -> f64 {
        if s <= near || reach <= near {
            return 0.0;
        }
        let up = (1.0 / near - 1.0 / s) / (1.0 / near - 1.0 / reach);
        let k = ((up - HANDOVER.0) / (HANDOVER.1 - HANDOVER.0)).clamp(0.0, 1.0);
        k * k * (3.0 - 2.0 * k)
    };
    // One line, curving more or less as it goes: the two can't come apart
    // (going over from one line to another instead, it stepped sideways
    // wherever they were apart, on the way into every tight turn).
    let (mut x, mut z, mut turned) = (0.0f64, 0.0f64, 0.0f64);
    let mut points = vec![(0.0f32, 0.0f32)];
    let steps = (reach / 0.25).ceil().max(1.0) as usize;
    let d = reach / steps as f64;
    for k in 0..steps {
        let s = (k as f64 + 0.5) * d;
        // Near the car: as it is turning now, but no sharper than it is
        // turning by the time it is there. Coming out of a turn the wheel
        // is already unwinding: held as it is now, the path pointed off to
        // the inside of where the car goes.
        let later = driven(s);
        let by_the_car = if now.curve * later <= 0.0 {
            0.0
        } else if later.abs() < now.curve.abs() {
            later
        } else {
            now.curve
        };
        let curve = by_the_car + (later - by_the_car) * share(s);
        // Along each step's middle.
        turned += curve * d / 2.0;
        x += d * turned.sin();
        z += d * turned.cos();
        turned += curve * d / 2.0;
        points.push((x as f32, z as f32));
    }
    // The speed's change over the 0.7 s around now (or what there is of it).
    let (before, after) = (clip.at(t - 0.35).unwrap_or(now), clip.at(t + 0.35).unwrap_or(now));
    let accel = if after.t > before.t + 0.05 { (after.speed - before.speed) / (after.t - before.t) } else { 0.0 };
    Some(Ahead { points, accel: accel as f32 })
}

/// Minute `segment`'s front clip.
fn front(segments: &[Segment], segment: usize) -> Option<&std::path::Path> {
    segments.get(segment).and_then(|s| s.files.get(&Camera::Front)).map(PathBuf::as_path)
}

/// The path ahead `t` seconds into minute `segment` (see `ahead`), reading
/// the clips' telemetry if it hasn't been (an export's thread). `near`:
/// `Lens::nearest`.
pub fn ahead_at(segments: &[Segment], segment: usize, t: f64, near: f32) -> Option<Ahead> {
    let clip = series(front(segments, segment)?);
    // The next minute's clip only once the path's far part reaches it.
    let next = front(segments, segment + 1).filter(|_| clip.samples.last().is_some_and(|s| t + LOOK_SECS + 0.5 > s.t)).map(series);
    ahead(&clip, next.as_deref(), t, near as f64)
}

/// As `ahead_at`, without waiting: None until the clip's telemetry has
/// been read (on a thread of its own), for the editor while it plays.
pub fn ahead_soon(segments: &[Segment], segment: usize, t: f64, near: f32) -> Option<Ahead> {
    let next = front(segments, segment + 1).and_then(series_soon);
    ahead(&*series_soon(front(segments, segment)?)?, next.as_deref(), t, near as f64)
}

// ---------------------------------------------------------------------------
// The path on the road
// ---------------------------------------------------------------------------

/// The chevrons' run towards the car, in spacings a second.
pub const CHEVRON_RATE: f32 = 0.8;

/// What the path shows in one frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Ribbon {
    /// From the car, along the path: metres to the right and ahead.
    pub points: Vec<(f32, f32)>,
    /// Self-Driving or Autosteer steers (blue), or the driver (grey).
    pub engaged: bool,
    /// How strongly the car slows, 0 to 1: the chevrons' strength.
    pub slowing: f32,
    /// How far the chevrons have run towards the car, 0 to 1 of the way to
    /// the next one's place.
    pub phase: f32,
}

impl Ribbon {
    /// The path for a frame with telemetry `m`: only in Drive. `phase`:
    /// see `Ribbon::phase`.
    pub fn new(m: &SeiMetadata, ahead: Ahead, phase: f32) -> Option<Ribbon> {
        if m.gear_state != 1 || ahead.points.len() < 2 {
            return None;
        }
        // Chevrons from 0.4 m/s² of slowing, full by 1.1 (in sixteenths, so
        // a steady frame is drawn once).
        let x = ((-ahead.accel - 0.4) / 0.7).clamp(0.0, 1.0);
        let slowing = ((x * x * (3.0 - 2.0 * x)) * 16.0).round() / 16.0;
        Some(Ribbon { points: ahead.points, engaged: matches!(m.autopilot_state, 1 | 2), slowing, phase: if slowing > 0.0 { (phase.rem_euclid(1.0) * 64.0).round() / 64.0 } else { 0.0 } })
    }
}

const PATH_BLUE: Color = Color { r: 0x21 as f32 / 255.0, g: 0x96 as f32 / 255.0, b: 0xf3 as f32 / 255.0, a: 0.86 };
const PATH_GREY: Color = Color { r: 0.88, g: 0.90, b: 0.93, a: 0.50 };

/// The path's drawing: in a canvas over the camera's picture from `top`
/// down (the horizon: nothing is drawn above it).
struct RibbonView {
    ribbon: Ribbon,
    lens: Lens,
    /// The camera's picture in the canvas's pixels.
    camera: (f32, f32),
    top: f32,
}

/// A path's points with the distance along it to each.
struct Line {
    points: Vec<(f32, f32)>,
    along: Vec<f32>,
}

impl Line {
    fn new(points: &[(f32, f32)]) -> Line {
        let mut along = Vec::with_capacity(points.len());
        let mut s = 0.0;
        for (i, p) in points.iter().enumerate() {
            if i > 0 {
                s += ((p.0 - points[i - 1].0).powi(2) + (p.1 - points[i - 1].1).powi(2)).sqrt();
            }
            along.push(s);
        }
        Line { points: points.to_vec(), along }
    }

    fn length(&self) -> f32 {
        self.along.last().copied().unwrap_or(0.0)
    }

    /// The point `s` metres along, `side` metres to its right.
    fn at(&self, s: f32, side: f32) -> (f32, f32) {
        let n = self.points.len();
        let i = self.along.partition_point(|a| *a <= s).clamp(1, n - 1);
        let (a, b) = (self.points[i - 1], self.points[i]);
        let span = (self.along[i] - self.along[i - 1]).max(1e-6);
        let x = (s - self.along[i - 1]) / span;
        // The direction over the points around, so the edges don't kink.
        let (p, q) = (self.points[i.saturating_sub(2)], self.points[(i + 1).min(n - 1)]);
        let (dx, dz) = (q.0 - p.0, q.1 - p.1);
        let d = (dx * dx + dz * dz).sqrt().max(1e-6);
        (a.0 + (b.0 - a.0) * x + dz / d * side, a.1 + (b.1 - a.1) * x - dx / d * side)
    }
}

impl RibbonView {
    /// A point on the road (metres right and ahead of the camera) in the
    /// canvas; None when it is too near to be in the picture.
    fn project(&self, (x, z): (f32, f32)) -> Option<Point> {
        let (w, h) = self.camera;
        let f = self.lens.focal * w;
        (z > 0.8).then(|| Point::new(self.lens.center * w + f * x / z, self.lens.horizon * h + f * CAMERA_HEIGHT / z - self.top))
    }
}

impl<M> canvas::Program<M> for RibbonView {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, b: Rectangle, _: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut f = Frame::new(renderer, b.size());
        let line = Line::new(&self.ribbon.points);
        let length = line.length();
        let (w, h) = self.camera;
        // From just under the picture's bottom edge.
        let from = (self.lens.nearest((w, h)) * 0.8).max(1.0);
        if length <= from + 0.5 {
            return vec![f.into_geometry()];
        }
        let half = WIDTH / 2.0;
        // The edges, as far as the path stays ahead of the camera (it ends
        // where it turns back or runs off to the side of it).
        let (mut left, mut right) = (Vec::new(), Vec::new());
        let mut reached = from;
        let steps = ((length - from) / 0.5).ceil().max(1.0) as usize;
        for k in 0..=steps {
            let s = (from + (length - from) * k as f32 / steps as f32).min(length);
            let (Some(l), Some(r)) = (self.project(line.at(s, -half)), self.project(line.at(s, half))) else { break };
            left.push(l);
            right.push(r);
            reached = s;
        }
        if left.len() < 2 {
            return vec![f.into_geometry()];
        }
        let shape = Path::new(|p| {
            p.move_to(left[0]);
            for q in &left[1..] {
                p.line_to(*q);
            }
            for q in right.iter().rev() {
                p.line_to(*q);
            }
            p.close();
        });
        // Fading out towards its far end, over the last `FADE` of its length
        // as the camera sees it: the far half of the road is only a few
        // rows of the picture, so a fade measured along the road is over
        // at once and the path seems to stop dead.
        const FADE: f32 = 0.45;
        let color = if self.ribbon.engaged { PATH_BLUE } else { PATH_GREY };
        let middle: Vec<Point> = left.iter().zip(&right).map(|(l, r)| Point::new((l.x + r.x) / 2.0, (l.y + r.y) / 2.0)).collect();
        let last = middle.len() - 1;
        // Its length in the picture: from the far end back to the bottom edge.
        let mut seen = 0.0;
        for i in (1..=last).rev() {
            let (far, near) = (middle[i], middle[i - 1]);
            if far.y >= b.height {
                break;
            }
            let inside = if near.y > b.height { (b.height - far.y) / (near.y - far.y) } else { 1.0 };
            seen += far.distance(near) * inside;
        }
        // Where it is whole again: that far back along its middle.
        let mut back = (seen * FADE).max(24.0 * h / 720.0);
        let mut whole = middle[0];
        for i in (1..=last).rev() {
            let (far, near) = (middle[i], middle[i - 1]);
            let d = far.distance(near);
            if d >= back {
                let x = back / d.max(1e-6);
                whole = Point::new(far.x + (near.x - far.x) * x, far.y + (near.y - far.y) * x);
                break;
            }
            back -= d;
        }
        // Square to its far edge, so it fades evenly across its width and
        // that whole edge is clear: fading along the line from the tip to
        // `whole` instead, round a bend one side went before the other.
        let tip = middle[last];
        let (ex, ey) = (right[last].x - left[last].x, right[last].y - left[last].y);
        let edge = (ex * ex + ey * ey).sqrt();
        let fade = (edge >= 0.5 && tip.distance(whole) >= 1.0).then(|| {
            // Towards the car: the side of the edge `whole` is on.
            let (back_x, back_y) = (whole.x - tip.x, whole.y - tip.y);
            let (mut nx, mut ny) = (-ey / edge, ex / edge);
            if nx * back_x + ny * back_y < 0.0 {
                (nx, ny) = (-nx, -ny);
            }
            // As deep as `whole` is behind the edge (on a tight bend it is
            // off to one side: then no shallower than a third of the way).
            let depth = (nx * back_x + ny * back_y).max(tip.distance(whole) / 3.0);
            (tip, Point::new(tip.x + nx * depth, tip.y + ny * depth))
        });
        // A colour fading as the path does (eased in and out, so neither
        // end of the fade shows as a line).
        let fading = |c: Color| -> canvas::Fill {
            let Some((clear, whole)) = fade else { return c.into() };
            let mut gradient = canvas::gradient::Linear::new(clear, whole);
            for k in 0..=6 {
                let t = k as f32 / 6.0;
                gradient = gradient.add_stop(t, Color { a: c.a * t * t * (3.0 - 2.0 * t), ..c });
            }
            gradient.into()
        };
        f.fill(&shape, fading(color));
        // Chevrons while it slows: darker bands across the path, their
        // points towards the car, each 1.3 times as far as the one before
        // (evenly spread as the camera sees them), running towards the car.
        if self.ribbon.slowing > 0.0 {
            const RATIO: f32 = 1.3;
            const POINT: f32 = 0.055;
            // Each band's thickness, as a share of its distance: two fifths
            // of the way to the next, so they read as stripes (a quarter of
            // this, they were hairlines once the video was made smaller).
            const THICK: f32 = 0.12;
            // Darker on the grey path, which the road shows through more.
            let shade = if self.ribbon.engaged { 0.72 } else { 0.5 };
            let dark = Color { r: color.r * shade, g: color.g * shade, b: color.b * (shade + 0.06), a: 1.0 };
            let mut s = 1.5 * RATIO.powf(1.0 - self.ribbon.phase);
            while s * (1.0 + THICK) < reached {
                if s > from * 0.9 {
                    let corners = [
                        line.at(s, -half),
                        line.at(s * (1.0 - POINT), 0.0),
                        line.at(s, half),
                        line.at(s * (1.0 + THICK), half),
                        line.at(s * (1.0 - POINT) * (1.0 + THICK), 0.0),
                        line.at(s * (1.0 + THICK), -half),
                    ];
                    let on_screen: Vec<Point> = corners.iter().filter_map(|c| self.project(*c)).collect();
                    if on_screen.len() == corners.len() {
                        let band = Path::new(|p| {
                            p.move_to(on_screen[0]);
                            for q in &on_screen[1..] {
                                p.line_to(*q);
                            }
                            p.close();
                        });
                        // Fading out with the path.
                        f.fill(&band, fading(Color { a: 0.55 * self.ribbon.slowing, ..dark }));
                    }
                }
                s *= RATIO;
            }
        }
        vec![f.into_geometry()]
    }
}

/// Where the path's picture starts in a camera `height` high: the horizon.
pub fn ribbon_top(lens: Lens, height: f32) -> f32 {
    (lens.horizon * height).floor().clamp(0.0, (height - 1.0).max(0.0))
}

/// The path, filling what it's given: the camera's picture (`camera` big)
/// from `ribbon_top` down (the editor while it plays).
pub fn ribbon_view<'a, M: 'a>(ribbon: Ribbon, lens: Lens, camera: (f32, f32)) -> iced::Element<'a, M> {
    let top = ribbon_top(lens, camera.1);
    iced::widget::canvas(RibbonView { ribbon, lens, camera, top }).width(iced::Length::Fill).height(iced::Length::Fill).into()
}

/// The path's picture for a camera `camera` big in the export: as wide,
/// from `ribbon_top` down.
pub fn paint_ribbon(painter: &mut Painter, ribbon: &Ribbon, lens: Lens, camera: (u32, u32)) -> Picture {
    let (w, h) = (camera.0 as f32, camera.1 as f32);
    let top = ribbon_top(lens, h);
    let size = Size::new(camera.0.max(1), ((h - top) as u32).max(1));
    let c = iced::widget::canvas(RibbonView { ribbon: ribbon.clone(), lens, camera: (w, h), top }).width(size.width as f32).height(size.height as f32);
    painter.paint::<()>(c.into(), size)
}

// ---------------------------------------------------------------------------
// Speed, gear and Autopilot state
// ---------------------------------------------------------------------------

/// What the camera's top corners show in one frame.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Hud {
    /// Gear, speed (in the unit shown) and Autopilot state; None without
    /// telemetry (parked): only the time is shown.
    pub driving: Option<(i32, u32, i32)>,
    pub metric: bool,
    /// "4:18 pm".
    pub time: String,
    /// The bar at the left: how hard the car speeds up (to 16) or slows
    /// (to -16).
    pub power: i8,
    /// Each blinker: None when off, else whether it's lit just now.
    pub blink_left: Option<bool>,
    pub blink_right: Option<bool>,
}

/// "4:18 pm", or "16:18".
pub fn clock(secs_of_day: i64, h24: bool) -> String {
    let t = secs_of_day.rem_euclid(86400);
    let (h, m) = (t / 3600, t / 60 % 60);
    if h24 {
        format!("{h:02}:{m:02}")
    } else {
        format!("{}:{m:02} {}", if h % 12 == 0 { 12 } else { h % 12 }, if h >= 12 { "pm" } else { "am" })
    }
}

impl Hud {
    /// The corners for a frame recorded at `wall` with telemetry `m`, its
    /// speed changing by `accel` m/s²; `blink_ms`: milliseconds into the
    /// blinkers' 700 ms.
    pub fn new(view: &SelfDriving, m: Option<&SeiMetadata>, accel: f32, wall: LocalSecs, blink_ms: u128) -> Hud {
        let lit = blink_ms < 400;
        Hud {
            driving: m.map(|m| {
                let mps = m.vehicle_speed_mps.abs();
                (m.gear_state, if view.metric { mps * 3.6 } else { mps * 2.236_936_292_054_402 }.round() as u32, m.autopilot_state)
            }),
            metric: view.metric,
            time: clock(wall, view.h24),
            // Full at 3 m/s² (a firm stop, or a quick start).
            power: if m.is_some() { ((accel / 3.0).clamp(-1.0, 1.0) * 16.0).round() as i8 } else { 0 },
            blink_left: m.filter(|m| m.blinker_on_left).map(|_| lit),
            blink_right: m.filter(|m| m.blinker_on_right).map(|_| lit),
        }
    }
}

const HUD_BLUE: Color = Color { r: 0x5c as f32 / 255.0, g: 0xb0 as f32 / 255.0, b: 1.0, a: 1.0 };
const HUD_GREEN: Color = Color { r: 0x2f as f32 / 255.0, g: 0xe0 as f32 / 255.0, b: 0x62 as f32 / 255.0, a: 1.0 };

/// The corners' height in a camera `height` high.
pub fn hud_height(height: f32) -> f32 {
    (height * 150.0 / 720.0).ceil().clamp(1.0, height.max(1.0))
}

/// The corners' drawing, across the camera's top. Everything is sized from
/// the camera's height, as on a 720 px high picture.
struct HudView {
    hud: Hud,
    /// The camera's height in the canvas's pixels.
    height: f32,
}

impl<M> canvas::Program<M> for HudView {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, b: Rectangle, _: mouse::Cursor) -> Vec<canvas::Geometry> {
        use iced::widget::text::Alignment::{Left, Right};
        let mut f = Frame::new(renderer, b.size());
        let u = self.height / 720.0;
        let white = |a: f32| Color { a, ..Color::WHITE };
        // A little shade along the top, for white type on a bright sky.
        let shade = canvas::gradient::Linear::new(Point::ORIGIN, Point::new(0.0, 70.0 * u)).add_stop(0.0, Color { a: 0.42, ..Color::BLACK }).add_stop(0.35, Color { a: 0.2, ..Color::BLACK }).add_stop(1.0, Color::TRANSPARENT);
        f.fill_rectangle(Point::ORIGIN, Size::new(b.width, 70.0 * u), shade);
        // Type with a soft shadow under it.
        let write = |f: &mut Frame, s: String, x: f32, y: f32, size: f32, color: Color, font: iced::Font, align: iced::widget::text::Alignment| {
            for (dx, dy, color) in [(0.0, 1.2 * u, Color { a: 0.38 * color.a, ..Color::BLACK }), (0.0, 0.0, color)] {
                f.fill_text(Text { content: s.clone(), position: Point::new(x + dx, y + dy), color, size: size.into(), font, align_x: align, align_y: iced::alignment::Vertical::Center, ..Text::default() });
            }
        };
        let inter = crate::theme::INTER;
        write(&mut f, self.hud.time.clone(), b.width - 14.0 * u, 18.0 * u, 13.5 * u, white(0.94), crate::theme::medium(inter), Right);
        let Some((gear, speed, autopilot)) = self.hud.driving else { return vec![f.into_geometry()] };
        let engaged = matches!(autopilot, 1 | 2);
        // The bar: up from its middle while the car speeds up, down in
        // green while it slows.
        let (bar_top, bar_bottom) = (27.0 * u, 137.0 * u);
        let (middle, reach) = ((bar_top + bar_bottom) / 2.0, (bar_bottom - bar_top) / 2.0);
        let bar = |f: &mut Frame, y0: f32, y1: f32, color: Color| {
            f.fill(&Path::rounded_rectangle(Point::new(10.5 * u, y0), Size::new(3.2 * u, (y1 - y0).max(0.0)), (1.6 * u).into()), color);
        };
        bar(&mut f, bar_top, bar_bottom, white(0.24));
        let power = self.hud.power as f32 / 16.0;
        if power < 0.0 {
            bar(&mut f, middle, middle - power * reach, HUD_GREEN);
        } else if power > 0.0 {
            bar(&mut f, middle - power * reach, middle, white(0.95));
        }
        // P R N D, the gear lit.
        for (i, (letter, state)) in [("P", 0), ("R", 2), ("N", 3), ("D", 1)].into_iter().enumerate() {
            let on = state == gear;
            let color = if !on { white(0.5) } else if engaged { HUD_BLUE } else { Color::WHITE };
            write(&mut f, letter.to_string(), 20.0 * u + i as f32 * 12.6 * u, 19.0 * u, 12.5 * u, color, crate::theme::bold(inter), Left);
        }
        // The blinkers beside the gears (their icons are 200 x 175).
        let icons = crate::dashboard::icon_set();
        for (blink, x, icon) in [(self.hud.blink_left, 80.0, &icons.blink_left), (self.hud.blink_right, 100.0, &icons.blink_right)] {
            if let Some(lit) = blink {
                let (iw, ih) = (14.0 * u * 200.0 / 175.0, 14.0 * u);
                f.draw_svg(
                    Rectangle::new(Point::new(x * u, 19.0 * u - ih / 2.0), Size::new(iw, ih)),
                    iced::advanced::svg::Svg::new(icon.clone()).color(HUD_GREEN).opacity(if lit { 1.0_f32 } else { 0.25 }),
                );
            }
        }
        write(&mut f, speed.to_string(), 17.5 * u, 64.0 * u, 66.0 * u, Color::WHITE, crate::theme::bold(inter), Left);
        let unit = crate::i18n::t(if self.hud.metric { "ui.dashboard.kmh" } else { "ui.dashboard.mph" });
        write(&mut f, unit.to_string(), 20.0 * u, 104.0 * u, 13.5 * u, white(0.66), crate::theme::medium(inter), Left);
        let words = crate::dashboard::autopilot_words(autopilot);
        write(&mut f, words.to_string(), 20.0 * u, 123.0 * u, 13.5 * u, if engaged { HUD_BLUE } else { white(0.66) }, crate::theme::semibold(inter), Left);
        vec![f.into_geometry()]
    }
}

/// The corners, filling what it's given: the camera's width, `hud_height`
/// high, for a camera `height` high (the editor while it plays).
pub fn hud_view<'a, M: 'a>(hud: Hud, height: f32) -> iced::Element<'a, M> {
    iced::widget::canvas(HudView { hud, height }).width(iced::Length::Fill).height(iced::Length::Fill).into()
}

/// The corners' picture for a camera `camera` big in the export: across
/// its top, `hud_height` high.
pub fn paint_hud(painter: &mut Painter, hud: &Hud, camera: (u32, u32)) -> Picture {
    let size = Size::new(camera.0.max(1), hud_height(camera.1 as f32) as u32);
    let c = iced::widget::canvas(HudView { hud: hud.clone(), height: camera.1 as f32 }).width(size.width as f32).height(size.height as f32);
    painter.paint::<()>(c.into(), size)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 18 frames a second for `secs`, each from `frame(t)`: speed (m/s),
    /// heading (degrees) and steering (degrees). The heading is held for
    /// 0.1 s at a time, as the car reports it.
    fn series(secs: f64, gps: bool, frame: impl Fn(f64) -> (f64, f64, f64)) -> Series {
        let raw: Vec<(f64, SeiMetadata)> = (0..=(secs * 18.0) as usize)
            .map(|k| {
                let t = k as f64 / 18.0;
                let (speed, _, steering) = frame(t);
                let heading = frame((t * 10.0).floor() / 10.0).1.rem_euclid(360.0);
                let (lat, lon) = if gps { (38.5, -121.5) } else { (0.0, 0.0) };
                (t, SeiMetadata { gear_state: 1, frame_seq_no: (k * 2) as f64, vehicle_speed_mps: speed, heading_deg: heading, steering_wheel_angle: steering, latitude_deg: lat, longitude_deg: lon, ..Default::default() })
            })
            .collect();
        Series::from_telemetry(&raw)
    }

    fn end(a: &Ahead) -> (f32, f32) {
        *a.points.last().unwrap()
    }

    /// The wheel's angle for a curve of `curve` (1/m) at `speed`, as
    /// `curvature` has it.
    fn wheel(curve: f64, speed: f64) -> f64 {
        curve / curvature(1.0, speed)
    }

    /// The road at the bottom edge of the 1280 x 960 front camera's
    /// picture: 4.58 m ahead.
    const NEAR: f64 = 4.58;

    #[test]
    fn straight_ahead_at_a_steady_speed() {
        // 30 m/s north: it drives further than the longest path in the time.
        let s = series(10.0, true, |_| (30.0, 0.0, 0.0));
        let a = ahead(&s, None, 3.0, NEAR).unwrap();
        let (x, z) = end(&a);
        assert!(x.abs() < 0.01 && (z - REACH.1 as f32).abs() < 0.01, "{x} {z}");
        assert!(a.accel.abs() < 0.01);
        // 6 m/s east: as far as it drives in the time.
        let s = series(10.0, true, |_| (6.0, 90.0, 0.0));
        let (x, z) = end(&ahead(&s, None, 3.0, NEAR).unwrap());
        assert!(x.abs() < 0.01 && (z - 6.0 * LOOK_SECS as f32).abs() < 0.01, "{x} {z}");
        // No telemetry there.
        assert!(ahead(&s, None, 30.0, NEAR).is_none() && ahead(&Series::default(), None, 0.0, NEAR).is_none());
    }

    #[test]
    fn near_the_car_the_wheel_further_off_where_it_drives() {
        // 10 m/s, straight for 4 s, then turning right at 18 degrees a
        // second (a 31.8 m circle), across north (350 to 10 and on), the
        // wheel turned to that curve over the 4th second's last half.
        let curve = 18f64.to_radians() / 10.0;
        let turn = |t: f64| (10.0, 350.0 + 18.0 * (t - 4.0).max(0.0), wheel(curve, 10.0) * ((t - 3.5) / 0.5).clamp(0.0, 1.0));
        let s = series(12.0, true, turn);
        // Long before the bend: straight all the way.
        let far = 10.0 * LOOK_SECS as f32;
        let (x, z) = end(&ahead(&s, None, 0.5, NEAR).unwrap());
        assert!(x.abs() < 0.02 && (z - far).abs() < 0.02, "{x} {z}");
        // 0.7 s before the wheel moves. Near the car (the bottom third of
        // its picture: the first 6 m) the path is still straight, as the
        // wheel is: it doesn't turn before the car does.
        let a = ahead(&s, None, 2.8, NEAR).unwrap();
        let line = Line::new(&a.points);
        for along in [2.0, 4.0, 6.0] {
            assert!(line.at(along, 0.0).0.abs() < 0.01, "{along} m along: {:?}", line.at(along, 0.0));
        }
        // Further off it turns as the car will: from 7 m on, well off to
        // the right by its end.
        let (x, z) = end(&a);
        assert!(x > 2.0 && z < far, "{x} {z}");
        // In one sweep: no step sideways where it goes over (each quarter
        // metre turns it a little more than the last, never back).
        let turns: Vec<f32> = a.points.windows(3).map(|p| (p[2].0 - p[1].0) - (p[1].0 - p[0].0)).collect();
        assert!(turns.iter().all(|t| *t > -1e-4 && *t < 0.003), "{turns:?}");
        // In the turn the two agree: the circle the car is on.
        let r = 1.0 / curve as f32;
        let round = 10.0 * LOOK_SECS as f32 / r;
        let (ex, ez) = (r * (1.0 - round.cos()), r * round.sin());
        for t in [5.0, 7.0, 10.0] {
            let (x, z) = end(&ahead(&s, None, t, NEAR).unwrap());
            assert!((x - ex).abs() < 0.8 && (z - ez).abs() < 0.8, "at {t} s: {x} {z}, expected {ex} {ez}");
        }
        // Steady in a steady turn: no steps from the heading's 10 values a second.
        let curves: Vec<f64> = (0..40).map(|k| s.at(6.0 + k as f64 / 36.0).unwrap().curve).collect();
        assert!(curves.iter().all(|c| (c / curve - 1.0).abs() < 0.05), "{curves:?}");
    }

    /// Coming out of a turn the wheel is unwinding: the path eases off with
    /// it and runs on where the car goes, straight down the road it has
    /// turned into. (Held as the wheel is now, it carried on round the
    /// turn, off the inside of that road.)
    #[test]
    fn coming_out_of_a_turn_it_goes_where_the_car_does() {
        // 8 m/s round a 25 m circle until 4 s, the wheel unwinding over
        // the half second after, then straight.
        let curve = 0.04f64;
        let turning = |t: f64| (1.0 - (t - 4.0) / 0.5).clamp(0.0, 1.0);
        // Seconds of the full turn made by `t`.
        let turned = |t: f64| match t {
            t if t < 4.0 => t,
            t if t < 4.5 => 4.0 + (t - 4.0) - (t - 4.0).powi(2),
            _ => 4.25,
        };
        let s = series(12.0, true, |t| (8.0, (8.0 * curve).to_degrees() * turned(t), wheel(curve * turning(t), 8.0)));
        // From 0.1 s before it starts to unwind: where the car goes from
        // there (0.8 m more of the circle, 4 m easing off, then straight).
        let a = ahead(&s, None, 3.9, NEAR).unwrap();
        let (mut x, mut z, mut heading) = (0.0f64, 0.0f64, 0.0f64);
        let step = 0.01;
        for k in 0..(8.0 * LOOK_SECS / step) as usize {
            let along = (k as f64 + 0.5) * step;
            heading += curve * turning(3.9 + along / 8.0) * step;
            x += step * heading.sin();
            z += step * heading.cos();
        }
        let (px, pz) = end(&a);
        assert!((px as f64 - x).abs() < 0.5 && (pz as f64 - z).abs() < 0.5, "{px} {pz}, the car goes to {x:.2} {z:.2}");
        // Round the circle the wheel is on now, it would be metres inside that.
        let round = curve * 8.0 * LOOK_SECS;
        assert!((1.0 - round.cos()) / curve > x + 3.0);
    }

    #[test]
    fn the_far_part_carries_on_into_the_next_clip() {
        // 10 m/s east; the next clip turns right from its start.
        let curve = 18f64.to_radians() / 10.0;
        let first = series(10.0, true, |_| (10.0, 90.0, 0.0));
        let second = series(10.0, true, |t| (10.0, 90.0 + 18.0 * t, wheel(curve, 10.0)));
        // 0.8 s from the clip's end. Alone it goes straight on; with the
        // next clip its far end turns (round that circle for the rest of
        // the time), the part near the car straight either way.
        let alone = ahead(&first, None, 9.2, NEAR).unwrap();
        let joined = ahead(&first, Some(&second), 9.2, NEAR).unwrap();
        assert!(end(&alone).0.abs() < 0.02, "{:?}", end(&alone));
        assert!(end(&joined).0 > 2.0, "{:?}", end(&joined));
        assert!(Line::new(&joined.points).at(6.0, 0.0).0.abs() < 0.01);
    }

    #[test]
    fn as_sharp_as_the_car_turns_whatever_its_steering() {
        // A car whose wheel turns half as far again for the same curve (a
        // slower steering rack): the heading says how sharp it is.
        let curve = 18f64.to_radians() / 10.0;
        let s = series(12.0, true, |t| (10.0, 18.0 * t, wheel(curve, 10.0) * 1.5));
        assert!((s.at(6.0).unwrap().curve / curve - 1.0).abs() < 0.05, "{}", s.at(6.0).unwrap().curve);
        // Going straight with the wheel held a degree off (a cambered
        // road): straighter than the wheel has it, never the other way.
        let s = series(12.0, true, |_| (20.0, 90.0, 1.0));
        let (held, by_wheel) = (s.at(6.0).unwrap().curve, curvature(1.0, 20.0));
        assert!(held > 0.0 && held < by_wheel * 0.6, "{held} of {by_wheel}");
    }

    /// The heading comes 0.6 s late, as the car records it: the path is
    /// still as sharp as the car turns, into the turn, through it and out
    /// of it (compared frame for frame, it was half as sharp going in and
    /// over twice as sharp coming out).
    #[test]
    fn the_heading_runs_late() {
        // 8 m/s; a turn of 0.04 / m that builds from 4 s to 4.5 s, holds,
        // and eases from 6.5 s to 7 s. The wheel turns a third further for
        // it than `curvature` has it, so the heading has to say how sharp.
        let curve = |t: f64| 0.04 * ((t - 4.0) / 0.5).clamp(0.0, 1.0).min(((7.0 - t) / 0.5).clamp(0.0, 1.0));
        // How far it has turned by `t` (the turn's share of a full one, in seconds of it).
        let turned = |t: f64| match t {
            t if t < 4.0 => 0.0,
            t if t < 4.5 => (t - 4.0).powi(2),
            t if t < 6.5 => 0.25 + (t - 4.5),
            t if t < 7.0 => 2.25 + (t - 6.5) - (t - 6.5).powi(2),
            _ => 2.5,
        };
        let s = series(12.0, true, |t| (8.0, (8.0f64 * 0.04).to_degrees() * turned(t - 0.6), wheel(curve(t), 8.0) * 4.0 / 3.0));
        for t in [4.3, 4.6, 5.5, 6.4, 6.7, 6.85] {
            let (found, real) = (s.at(t).unwrap().curve, curve(t));
            assert!((found / real - 1.0).abs() < 0.1, "at {t} s: {found}, really {real}");
        }
    }

    #[test]
    fn stopping_shortens_it_to_a_stub_along_the_steering() {
        // Braking from 8 m/s at 4 m/s², stopped from 2 s on, the wheel
        // turned 200 degrees to the right from 3.2 s.
        let s = series(8.0, true, |t| ((8.0 - 4.0 * t).max(0.0), 0.0, if t > 3.2 { 200.0 } else { 0.0 }));
        // At 8 m/s, 8 m from the stop, the wheel straight for as far
        // ahead as it looks: straight on, as far as it would drive at
        // that speed.
        let a = ahead(&s, None, 0.0, NEAR).unwrap();
        let (x, z) = end(&a);
        assert!(x.abs() < 0.02 && (z - 8.0 * LOOK_SECS as f32).abs() < 0.02, "{x} {z}");
        // At 4 m/s, 2 m from the stop. Near the car it is straight, as the
        // wheel is now; its far end turns as the wheel will be turned by
        // then.
        let a = ahead(&s, None, 1.0, NEAR).unwrap();
        assert!((a.accel + 4.0).abs() < 0.2, "{}", a.accel);
        let (x, z) = end(&a);
        assert!(x > 0.3 && x < 1.5 && z > 9.5, "{x} {z}");
        assert!(Line::new(&a.points).at(5.0, 0.0).0.abs() < 0.01);
        // Stopped with the wheel turned: the stub from the car, all of it
        // round the 10 m circle the wheel is turned to.
        let a = ahead(&s, None, 5.0, NEAR).unwrap();
        assert!((Line::new(&a.points).length() - 7.0).abs() < 0.05 && a.accel.abs() < 0.01);
        let (x, z) = end(&a);
        assert!((x - 10.0 * (1.0 - 0.7f32.cos())).abs() < 0.1 && (z - 10.0 * 0.7f32.sin()).abs() < 0.1, "{x} {z}");
    }

    #[test]
    fn without_gps_the_steering_alone() {
        // 5 m/s with the wheel at 100 degrees: a curve of 0.049 / m.
        let s = series(10.0, false, |_| (5.0, 0.0, 100.0));
        let k = curvature(100.0, 5.0) as f32;
        let (x, z) = end(&ahead(&s, None, 2.0, NEAR).unwrap());
        let far = 5.0 * LOOK_SECS as f32;
        let (ex, ez) = ((1.0 - (far * k).cos()) / k, (far * k).sin() / k);
        assert!((x - ex).abs() < 0.05 && (z - ez).abs() < 0.05, "{x} {z}, expected {ex} {ez}");
    }

    fn ribbon(points: Vec<(f32, f32)>, engaged: bool, slowing: f32) -> Ribbon {
        Ribbon { points, engaged, slowing, phase: 0.25 }
    }

    /// Alpha at a pixel.
    fn alpha(p: &Picture, x: u32, y: u32) -> u8 {
        p.rgba[((y * p.width + x) * 4 + 3) as usize]
    }

    #[test]
    fn the_path_lies_on_the_road() {
        let view = SelfDriving { hud: true, metric: false, h24: false, horizon: None, center: None, fov: None };
        let lens = view.lens((1280, 960));
        assert!((lens.horizon - 0.5).abs() < 1e-6 && (lens.focal - 1.3737).abs() < 0.01, "{lens:?}");
        let mut p = Painter::new().unwrap();
        let straight: Vec<(f32, f32)> = (0..=180).map(|k| (0.0, k as f32 * 0.25)).collect();
        let started = std::time::Instant::now();
        let pic = paint_ribbon(&mut p, &ribbon(straight.clone(), true, 0.0), lens, (1280, 960));
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        // From the horizon down, as wide as the camera.
        assert_eq!((pic.width, pic.height), (1280, 480));
        // Blue in the middle at the bottom, nothing beside it or over its end.
        let px = |x: u32, y: u32| pic.rgba[((y * 1280 + x) * 4) as usize..][..4].to_vec();
        let bottom = px(640, 470);
        assert!(bottom[3] > 200 && bottom[2] > bottom[0] + 100, "{bottom:?}");
        assert_eq!((alpha(&pic, 60, 470), alpha(&pic, 1220, 470), alpha(&pic, 640, 20)), (0, 0, 0));
        // 1.8 m wide from 1.25 m up: 1.44 times as wide as it is below the horizon.
        let row = 300;
        let wide = (0..1280).filter(|x| alpha(&pic, *x, row) > 110).count() as f32;
        assert!((wide - 1.44 * row as f32).abs() < 6.0, "{wide}");
        // A right turn leans right.
        let r = 30.0f32;
        let right: Vec<(f32, f32)> = (0..=160).map(|k| k as f32 * 0.25 / r).map(|a| (r * (1.0 - a.cos()), r * a.sin())).collect();
        let pic = paint_ribbon(&mut p, &ribbon(right, false, 0.0), lens, (1280, 960));
        let middle = |row: u32| {
            let lit: Vec<u32> = (0..1280).filter(|x| alpha(&pic, *x, row) > 40).collect();
            lit.iter().sum::<u32>() as f32 / lit.len().max(1) as f32
        };
        assert!(middle(120) > middle(400) + 60.0 && middle(400) > 660.0, "{} {}", middle(120), middle(400));
        // Chevrons across it while it slows: bands that cover more.
        let slow = paint_ribbon(&mut p, &ribbon(straight.clone(), true, 1.0), lens, (1280, 960));
        let plain = paint_ribbon(&mut p, &ribbon(straight, true, 0.0), lens, (1280, 960));
        let bands = (150..470).filter(|y| alpha(&slow, 640, *y) > alpha(&plain, 640, *y) + 8).count();
        // Stripes: a good part of those 320 rows, with path between them.
        assert!(bands > 60 && bands < 220, "{bands}");
        let again = std::time::Instant::now();
        for _ in 0..10 {
            paint_ribbon(&mut p, &ribbon(vec![(0.0, 0.0), (0.0, 45.0)], true, 1.0), SelfDriving { fov: Some(58.0), ..view }.lens((2896, 1876)), (2896, 1876));
        }
        println!("path: first {ms:.1} ms; 2896 x 1876 with chevrons {:.1} ms each", again.elapsed().as_secs_f64() * 100.0);
        if let Some(path) = std::env::var_os("SENTRY_DUMP_OVERLAY") {
            dump(&slow, path.as_ref());
        }
    }

    /// Round a bend the path fades the same on both sides: clear along
    /// its far end, then stronger towards the car, each line across it one
    /// strength (fading along the line from its tip instead, the inside of
    /// the bend went long before the outside).
    #[test]
    fn it_fades_evenly_across_its_far_end() {
        let lens = SelfDriving { hud: false, metric: false, h24: false, horizon: None, center: None, fov: None }.lens((1280, 960));
        // A bend to the right, 120 m round and 30 m long.
        let round = 120.0f32;
        let bend: Vec<(f32, f32)> = (0..=120).map(|k| k as f32 * 0.25 / round).map(|a| (round * (1.0 - a.cos()), round * a.sin())).collect();
        let shown = ribbon(bend.clone(), true, 0.0);
        let mut p = Painter::new().unwrap();
        let pic = paint_ribbon(&mut p, &shown, lens, (1280, 960));
        let view = RibbonView { ribbon: shown, lens, camera: (1280.0, 960.0), top: ribbon_top(lens, 960.0) };
        let line = Line::new(&bend);
        // How strong it is across the path (0.7 m either side of its
        // middle), `back` metres from its end.
        let across = |back: f32| -> Vec<i32> {
            [-0.7, -0.35, 0.0, 0.35, 0.7]
                .iter()
                .map(|side| {
                    let at = view.project(line.at(line.length() - back, *side)).unwrap();
                    alpha(&pic, at.x.round() as u32, at.y.round() as u32) as i32
                })
                .collect()
        };
        assert!(across(0.1).iter().all(|a| *a <= 4), "{:?}", across(0.1));
        let mut before = 0;
        for back in [4.0, 8.0, 12.0, 16.0] {
            let row = across(back);
            let (lo, hi) = (*row.iter().min().unwrap(), *row.iter().max().unwrap());
            assert!(hi - lo <= 10 && lo > before, "{back} m back: {row:?} (after {before})");
            before = lo;
        }
        // Whole by the car.
        assert!(across(24.0).iter().all(|a| *a > 210), "{:?}", across(24.0));
        if let Some(path) = std::env::var_os("SENTRY_DUMP_FADE") {
            dump(&pic, path.as_ref());
        }
    }

    #[test]
    fn the_corners_show_speed_gear_and_time() {
        let view = SelfDriving { hud: true, metric: false, h24: false, horizon: None, center: None, fov: None };
        let m = SeiMetadata { gear_state: 1, vehicle_speed_mps: 28.61, autopilot_state: 1, blinker_on_right: true, ..Default::default() };
        let wall = crate::library::parse_stamp("2026-11-07_16-18-40").unwrap();
        let hud = Hud::new(&view, Some(&m), -1.5, wall, 100);
        assert_eq!(hud, Hud { driving: Some((1, 64, 1)), metric: false, time: "4:18 pm".into(), power: -8, blink_left: None, blink_right: Some(true) });
        assert_eq!((clock(0, false), clock(13 * 3600 + 5 * 60, true), clock(12 * 3600, false)), ("12:00 am".to_string(), "13:05".to_string(), "12:00 pm".to_string()));
        assert_eq!(Hud::new(&SelfDriving { metric: true, ..view }, Some(&m), 0.0, wall, 500).driving, Some((1, 103, 1)));
        let mut p = Painter::new().unwrap();
        let pic = paint_hud(&mut p, &hud, (1280, 960));
        assert_eq!((pic.width, pic.height), (1280, 200));
        // White type where the speed is, the time at the right, nothing
        // under the shade in the middle.
        let white = |x0: u32, x1: u32, y0: u32, y1: u32| (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).filter(|(x, y)| pic.rgba[((y * 1280 + x) * 4) as usize] > 230 && alpha(&pic, *x, *y) > 230).count();
        assert!(white(24, 150, 55, 115) > 1500, "{}", white(24, 150, 55, 115));
        assert!(white(1180, 1270, 12, 36) > 30, "{}", white(1180, 1270, 12, 36));
        assert_eq!(white(500, 800, 100, 200), 0);
        // Parked (no telemetry): only the time.
        let parked = paint_hud(&mut p, &Hud::new(&view, None, 0.0, wall, 0), (1280, 960));
        assert!((55..115).all(|y| (24..150).all(|x| parked.rgba[((y * 1280 + x) * 4) as usize] < 200)));
        if let Some(path) = std::env::var_os("SENTRY_DUMP_HUD") {
            dump(&pic, path.as_ref());
        }
    }

    /// A picture over grey, to see it as it would sit on video.
    fn dump(pic: &Picture, path: &std::path::Path) {
        let mut img = ::image::RgbaImage::from_pixel(pic.width, pic.height, ::image::Rgba([110, 116, 112, 255]));
        for (px, s) in img.pixels_mut().zip(pic.rgba.chunks(4)) {
            for c in 0..3 {
                px.0[c] = (s[c] as u32 + px.0[c] as u32 * (255 - s[3] as u32) / 255).min(255) as u8;
            }
        }
        img.save(path).unwrap();
    }

    /// Prints where the path ends and how the speed changes at every frame
    /// of a clip (cargo test fsd_path -- --ignored --nocapture, with
    /// SENTRY_FSD_CLIP), for seeing how steady the path is.
    #[test]
    #[ignore]
    fn fsd_path() {
        let Some(path) = std::env::var_os("SENTRY_FSD_CLIP") else { return };
        let s = Series::read(path.as_ref());
        println!("t,x,z,length,accel,turning");
        let last = s.samples.last().map_or(0.0, |s| s.t);
        for k in 0..(last * 36.0) as usize {
            let t = k as f64 / 36.0;
            if let (Some(a), Some(now)) = (ahead(&s, None, t, NEAR), s.at(t)) {
                let (x, z) = end(&a);
                // The last: how fast the path has the car turning, in degrees a second.
                println!("{t:.3},{x:.3},{z:.3},{:.2},{:.3},{:.3}", Line::new(&a.points).length(), a.accel, (now.curve * now.speed).to_degrees());
            }
        }
    }

    /// Prints a clip's telemetry (cargo test fsd_dump -- --ignored
    /// --nocapture, with SENTRY_FSD_CLIP), for measuring a car's steering
    /// or a camera's angle from footage.
    #[test]
    #[ignore]
    fn fsd_dump() {
        let Some(path) = std::env::var_os("SENTRY_FSD_CLIP") else { return };
        let file = std::fs::File::open(&path).unwrap();
        let track = crate::mp4::read_video_track(&file).unwrap();
        let mut buf = vec![0u8; 4096];
        let stride: usize = std::env::var("SENTRY_FSD_STRIDE").ok().and_then(|s| s.parse().ok()).unwrap_or(6);
        println!("frames {} duration {:.2}", track.samples.len(), track.duration);
        println!("k,t,seq,speed,steer,heading,ax,ay,az,accel_pedal,brake,gear,ap,lat,lon,bl,br");
        for (k, s) in track.samples.iter().enumerate().step_by(stride) {
            let n = (s.size as usize).min(buf.len());
            if crate::mp4::read_at(&file, &mut buf[..n], s.offset).is_err() {
                continue;
            }
            match crate::telemetry::sample_telemetry(&buf[..n], track.nal_length_size as usize, track.codec) {
                Some(m) => println!(
                    "{k},{:.3},{},{:.3},{:.2},{:.3},{:.3},{:.3},{:.3},{:.2},{},{},{},{:.6},{:.6},{},{}",
                    track.pts_secs(k),
                    m.frame_seq_no,
                    m.vehicle_speed_mps,
                    m.steering_wheel_angle,
                    m.heading_deg,
                    m.linear_acceleration_mps2_x,
                    m.linear_acceleration_mps2_y,
                    m.linear_acceleration_mps2_z,
                    m.accelerator_pedal_position,
                    m.brake_applied as u8,
                    m.gear_state,
                    m.autopilot_state,
                    m.latitude_deg,
                    m.longitude_deg,
                    m.blinker_on_left as u8,
                    m.blinker_on_right as u8
                ),
                None => println!("{k},{:.3},none", track.pts_secs(k)),
            }
        }
    }
}
