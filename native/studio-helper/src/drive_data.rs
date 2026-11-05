//! SentryUSB `drive-data.json` loading: port of `src/main/driveLoadWorker.js`,
//! `src/main/driveTagsWorker.js` and `groupStoreDataIntoDrives` from
//! `src/renderer/scripts/core/driveGrouper.js`.
//!
//! Electron stream-parses the routes array in one worker thread and the drive
//! tags in a second (two full passes over a file that is >1 GB), then groups in
//! JavaScript. Here one serde pass keeps only the route fields the grouper
//! reads and skips every other top-level section without materialising it.
//! The grouping follows the JavaScript control flow line for line.

use std::fmt;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::Result;
use base64::Engine;
use chrono::{Local, LocalResult, NaiveDate, TimeZone, Timelike};
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::crmath;

const DRIVE_GAP_MS: f64 = 5.0 * 60.0 * 1000.0;
const CLIP_DURATION_MS: f64 = 60_000.0;
const PARK_GAP_SECONDS: f64 = 2.0;
const GEAR_PARK: f64 = 0.0;

/// JavaScript `Math.round` (round half toward +∞).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

// ---------------------------------------------------------------------------
// Route model (only the fields the grouper reads)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
pub struct Pt {
    pub lat: f64,
    pub lng: f64,
    /// Present only for object-form points ({Lat, Lng, Speed}).
    pub speed: Option<f64>,
    pub is_array: bool,
}

impl<'de> Deserialize<'de> for Pt {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Pt;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a point array or object")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Pt, A::Error> {
                let lat: Option<f64> = a.next_element::<Option<f64>>()?.flatten();
                let lng: Option<f64> = a.next_element::<Option<f64>>()?.flatten();
                while a.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Pt { lat: lat.unwrap_or(f64::NAN), lng: lng.unwrap_or(f64::NAN), speed: None, is_array: true })
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Pt, A::Error> {
                let (mut lat, mut lng, mut speed) = (None, None, None);
                while let Some(k) = a.next_key::<std::borrow::Cow<'de, str>>()? {
                    match k.as_ref() {
                        "Lat" | "lat" => lat = a.next_value::<Option<f64>>()?,
                        "Lng" | "lng" => lng = a.next_value::<Option<f64>>()?,
                        "Speed" | "speed" => speed = a.next_value::<Option<f64>>()?,
                        _ => {
                            a.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(Pt { lat: lat.unwrap_or(f64::NAN), lng: lng.unwrap_or(f64::NAN), speed, is_array: false })
            }
        }
        d.deserialize_any(V)
    }
}

/// A Go `[]uint8` field: base64 string (encoding/json default) or a number array.
#[derive(Debug, Clone, Default)]
pub enum U8Field {
    #[default]
    Missing,
    Str(String),
    Arr(Vec<f64>),
}

impl<'de> Deserialize<'de> for U8Field {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = U8Field;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("base64 string or byte array")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<U8Field, E> {
                Ok(U8Field::Str(v.to_string()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<U8Field, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = a.next_element::<Option<f64>>()? {
                    out.push(v.unwrap_or(0.0));
                }
                Ok(U8Field::Arr(out))
            }
            fn visit_unit<E: de::Error>(self) -> Result<U8Field, E> {
                Ok(U8Field::Missing)
            }
            fn visit_none<E: de::Error>(self) -> Result<U8Field, E> {
                Ok(U8Field::Missing)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<U8Field, E> {
                Ok(U8Field::Missing)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<U8Field, E> {
                Ok(U8Field::Missing)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<U8Field, E> {
                Ok(U8Field::Missing)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<U8Field, E> {
                Ok(U8Field::Missing)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<U8Field, A::Error> {
                while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(U8Field::Missing)
            }
        }
        d.deserialize_any(V)
    }
}

/// `decodeUint8Field`: base64 → bytes, array → as-is, anything else → null.
fn decode_u8(f: &U8Field) -> Option<Vec<f64>> {
    match f {
        U8Field::Arr(a) => Some(a.clone()),
        U8Field::Str(s) if !s.is_empty() => {
            let cleaned: String = s.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            let engine = base64::engine::GeneralPurpose::new(
                &base64::alphabet::STANDARD,
                base64::engine::GeneralPurposeConfig::new()
                    .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                    .with_decode_allow_trailing_bits(true),
            );
            engine.decode(cleaned).ok().map(|v| v.into_iter().map(|b| b as f64).collect())
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GearRun {
    #[serde(alias = "Gear", default)]
    pub gear: Option<f64>,
    #[serde(alias = "Frames", default)]
    pub frames: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    #[serde(alias = "File", default)]
    pub file: Option<String>,
    #[serde(alias = "Points", default)]
    pub points: Option<Vec<Pt>>,
    #[serde(alias = "Speeds", default)]
    pub speeds: Option<Vec<Option<f64>>>,
    #[serde(alias = "AutopilotStates", default)]
    pub autopilot_states: U8Field,
    #[serde(alias = "AccelPositions", default)]
    pub accel_positions: Option<Vec<Option<f64>>>,
    #[serde(alias = "GearStates", default)]
    pub gear_states: U8Field,
    #[serde(alias = "GearRuns", default)]
    pub gear_runs: Option<Vec<GearRun>>,
    #[serde(alias = "RawFrameCount", default)]
    pub raw_frame_count: Option<f64>,
    #[serde(alias = "RawParkCount", default)]
    pub raw_park_count: Option<f64>,
    #[serde(skip)]
    pub start_ms: f64,
}

impl Route {
    fn file_str(&self) -> &str {
        self.file.as_deref().unwrap_or("")
    }
}

/// What the grouper needs from drive-data.json.
#[derive(Default)]
pub struct StoreData {
    pub routes: Vec<Route>,
    pub drive_tags: Map<String, Value>,
    pub top_keys: Vec<String>,
}

/// Faster path: deserialize routes directly (no intermediate Value).
struct RoutesDirect<'a>(&'a mut Vec<Route>);
impl<'de, 'a> DeserializeSeed<'de> for RoutesDirect<'a> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        struct V<'a>(&'a mut Vec<Route>);
        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = ();
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("routes array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<(), A::Error> {
                while let Some(r) = a.next_element::<Route>()? {
                    self.0.push(r);
                }
                Ok(())
            }
        }
        d.deserialize_seq(V(self.0))
    }
}

impl<'de> Deserialize<'de> for StoreData {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StoreData;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("drive-data.json object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<StoreData, A::Error> {
                let mut s = StoreData::default();
                while let Some(k) = a.next_key::<String>()? {
                    let lower = k.to_ascii_lowercase();
                    if lower == "routes" {
                        a.next_value_seed(RoutesDirect(&mut s.routes))?;
                    } else if lower == "drivetags" || lower == "drive_tags" {
                        let m: Option<Map<String, Value>> = a.next_value()?;
                        if let Some(m) = m {
                            for (k, v) in m {
                                s.drive_tags.insert(k, v);
                            }
                        }
                    } else {
                        a.next_value::<IgnoredAny>()?;
                    }
                    s.top_keys.push(k);
                }
                Ok(s)
            }
        }
        d.deserialize_map(V)
    }
}

pub fn read_store_data(path: &Path) -> Result<StoreData> {
    let f = File::open(path)?;
    let reader = BufReader::with_capacity(4 << 20, f);
    let mut de = serde_json::Deserializer::from_reader(reader);
    let s = StoreData::deserialize(&mut de)?;
    Ok(s)
}

// ---------------------------------------------------------------------------
// Local-time helpers (Tesla filenames are vehicle local time)
// ---------------------------------------------------------------------------

/// `new Date(Y, Mo-1, D, h, mi, s).getTime()` in the process time zone.
pub fn local_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<f64> {
    let naive = NaiveDate::from_ymd_opt(y, mo, d)?.and_hms_opt(h, mi, s)?;
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(t) => Some(t.timestamp_millis() as f64),
        LocalResult::Ambiguous(a, _) => Some(a.timestamp_millis() as f64),
        LocalResult::None => {
            // Spring-forward gap: JS moves the wall time forward by the gap.
            let later = naive + chrono::Duration::hours(1);
            Local.from_local_datetime(&later).earliest().map(|t| t.timestamp_millis() as f64)
        }
    }
}

fn basename(file: &str) -> &str {
    let a = file.rsplit('/').next().unwrap_or(file);
    a.rsplit('\\').next().unwrap_or(a)
}

fn digits(s: &str, from: usize, n: usize) -> Option<u32> {
    let sub = s.get(from..from + n)?;
    if sub.bytes().all(|b| b.is_ascii_digit()) { sub.parse().ok() } else { None }
}

/// Matches `^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})` at the start of `s`.
pub fn parse_ts_prefix(s: &str) -> Option<(i32, u32, u32, u32, u32, u32)> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'_' || b[13] != b'-' || b[16] != b'-' {
        return None;
    }
    Some((
        digits(s, 0, 4)? as i32,
        digits(s, 5, 2)?,
        digits(s, 8, 2)?,
        digits(s, 11, 2)?,
        digits(s, 14, 2)?,
        digits(s, 17, 2)?,
    ))
}

fn parse_route_timestamp_ms(file: &str) -> Option<f64> {
    let (y, mo, d, h, mi, s) = parse_ts_prefix(basename(file))?;
    // JS Date normalises out-of-range fields (month 13 → next year); Tesla
    // filenames never carry those, so invalid fields simply don't parse here.
    local_ms(y, mo, d, h, mi, s)
}

fn ms_to_time_str(ms: f64) -> String {
    match Local.timestamp_millis_opt(ms as i64) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => format!("{:02}:{:02}", t.hour(), t.minute()),
        LocalResult::None => "00:00".into(),
    }
}

/// cos(lat * PI / 180) for the last latitude seen. Consecutive segments share
/// a point, so each segment's lat1 is the previous segment's lat2. Same
/// values as computing it every time; the correctly rounded cos is ~90 ns.
struct CosLat {
    lat: f64,
    cos: f64,
}

impl CosLat {
    fn new() -> Self {
        CosLat { lat: f64::NAN, cos: f64::NAN }
    }

    fn get(&mut self, lat: f64) -> f64 {
        if lat.to_bits() != self.lat.to_bits() {
            self.lat = lat;
            self.cos = crmath::cos(lat * std::f64::consts::PI / 180.0);
        }
        self.cos
    }
}

fn haversine_km(cos_lat: &mut CosLat, lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6371.0;
    let d_lat = (lat2 - lat1) * std::f64::consts::PI / 180.0;
    let d_lon = (lon2 - lon1) * std::f64::consts::PI / 180.0;
    // Same operation order as driveGrouper.js, and correctly rounded
    // sin/cos/atan2 like Electron's V8 (see crmath.rs), so distances are
    // bit-identical to the JavaScript loader instead of 1e-9 apart.
    // `x ** 2` is x*x in V8 (an exponent of 2 is exact either way).
    let s1 = crmath::sin(d_lat / 2.0);
    let s2 = crmath::sin(d_lon / 2.0);
    let a = s1 * s1
        + cos_lat.get(lat1) * cos_lat.get(lat2) * (s2 * s2);
    r * 2.0 * crmath::atan2(a.sqrt(), (1.0 - a).sqrt())
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

fn split_by_gear_state(group: Vec<Route>) -> Vec<Vec<Route>> {
    if group.is_empty() {
        return vec![];
    }
    let has_runs = group.iter().any(|r| r.gear_runs.as_ref().map_or(false, |v| !v.is_empty()));
    if !has_runs {
        return split_by_gear_state_legacy(group);
    }
    let mut result: Vec<Vec<Route>> = Vec::new();
    let mut current: Vec<Route> = Vec::new();
    for clip in &group {
        let runs = match clip.gear_runs.as_ref() {
            Some(r) if !r.is_empty() => r,
            _ => {
                current.push(clip.clone());
                continue;
            }
        };
        for (route, parked) in split_clip_at_park_gaps(clip, runs) {
            if parked {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
            } else if let Some(r) = route {
                current.push(r);
            }
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    if result.is_empty() { vec![group] } else { result }
}

fn split_by_gear_state_legacy(group: Vec<Route>) -> Vec<Vec<Route>> {
    if group.len() <= 1 {
        return vec![group];
    }
    let has_gear = group.iter().any(|r| decode_u8(&r.gear_states).map_or(false, |g| !g.is_empty()));
    if !has_gear {
        return vec![group];
    }
    let mut result = Vec::new();
    let mut current = Vec::new();
    for clip in &group {
        if clip_is_mostly_parked(clip) {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(clip.clone());
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    if result.is_empty() { vec![group] } else { result }
}

fn clip_is_mostly_parked(clip: &Route) -> bool {
    let raw_frames = clip.raw_frame_count.unwrap_or(0.0);
    let raw_park = clip.raw_park_count.unwrap_or(0.0);
    if raw_frames > 0.0 {
        return raw_park / raw_frames > 0.5;
    }
    let gs = match decode_u8(&clip.gear_states) {
        Some(g) if !g.is_empty() => g,
        _ => return false,
    };
    let park = gs.iter().filter(|&&g| g == GEAR_PARK).count();
    (park as f64) > gs.len() as f64 / 2.0
}

fn slice_opt<T: Clone>(v: &[T], start: usize, end: usize) -> Vec<T> {
    let end = end.min(v.len());
    let start = start.min(end);
    v[start..end].to_vec()
}

fn split_clip_at_park_gaps(clip: &Route, runs: &[GearRun]) -> Vec<(Option<Route>, bool)> {
    let total: f64 = runs.iter().map(|r| r.frames.unwrap_or(0.0)).sum();
    if total == 0.0 {
        return vec![(Some(clip.clone()), false)];
    }
    let spf = 60.0 / total;
    let pts: &[Pt] = clip.points.as_deref().unwrap_or(&[]);
    let n_points = pts.len() as f64;

    struct Seg {
        start: f64,
        end: f64,
        parked: bool,
    }
    let mut raw = Vec::new();
    let mut frame = 0.0;
    for run in runs {
        let gear = run.gear.unwrap_or(0.0);
        let frames = run.frames.unwrap_or(0.0);
        let duration = frames * spf;
        raw.push(Seg { start: frame, end: frame + frames, parked: gear == GEAR_PARK && duration >= PARK_GAP_SECONDS });
        frame += frames;
    }
    let mut merged: Vec<Seg> = Vec::new();
    for s in raw {
        if let Some(last) = merged.last_mut() {
            if !last.parked && !s.parked {
                last.end = s.end;
                continue;
            }
        }
        merged.push(s);
    }
    if !merged.iter().any(|s| s.parked) {
        return vec![(Some(clip.clone()), false)];
    }
    let mut out = Vec::new();
    for seg in &merged {
        if seg.parked {
            out.push((None, true));
            continue;
        }
        let start_frac = seg.start / total;
        let end_frac = seg.end / total;
        let mut start_idx = js_round(start_frac * n_points);
        let mut end_idx = js_round(end_frac * n_points);
        if start_idx >= n_points {
            start_idx = n_points - 1.0;
        }
        if end_idx > n_points {
            end_idx = n_points;
        }
        if start_idx < 0.0 {
            start_idx = 0.0;
        }
        if end_idx <= start_idx {
            continue;
        }
        let (si, ei) = (start_idx as usize, end_idx as usize);
        let mut sub = clip.clone();
        sub.points = Some(pts[si..ei].to_vec());
        if let Some(ap) = decode_u8(&clip.autopilot_states) {
            sub.autopilot_states = U8Field::Arr(slice_opt(&ap, si, ei));
        }
        if let Some(acc) = clip.accel_positions.as_ref() {
            sub.accel_positions = Some(slice_opt(acc, si, ei));
        }
        if let Some(gs) = decode_u8(&clip.gear_states) {
            sub.gear_states = U8Field::Arr(slice_opt(&gs, si, ei));
        }
        if let Some(sp) = clip.speeds.as_ref() {
            sub.speeds = Some(slice_opt(sp, si, ei));
        }
        sub.start_ms = clip.start_ms + js_round(start_frac * CLIP_DURATION_MS);
        out.push((Some(sub), false));
    }
    out
}

/// A grouped drive. `points` holds `[lat, lng, 0, speed, ap]` tuples (what
/// the Electron worker ships in its transferable Float64Array).
pub struct Drive {
    pub light: Map<String, Value>,
    pub points: Vec<[f64; 5]>,
    pub fsd_events: Vec<Value>,
}

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn build_drive(id: usize, routes: &[Route], drive_tags: &Map<String, Value>) -> Drive {
    let mut flat: Vec<[f64; 5]> = Vec::new();
    let mut fsd_km = 0.0;
    let mut total_km = 0.0;
    let mut disengagements = 0u32;
    let mut accel_push = 0u32;
    let mut events: Vec<Value> = Vec::new();
    let mut prev_engaged = false;
    let (mut prev_lat, mut prev_lng) = (f64::NAN, f64::NAN);
    let mut cos_lat = CosLat::new();
    let mut in_accel = false;
    let (mut accel_lat, mut accel_lng) = (0.0, 0.0);
    let mut pending = false;
    let mut pending_t = 0.0;
    let (mut pending_lat, mut pending_lng) = (0.0, 0.0);
    let mut engage_t = 0.0;

    for route in routes {
        let pts = match route.points.as_ref() {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        let n = pts.len();
        let ap_arr = decode_u8(&route.autopilot_states).and_then(|a| {
            let ratio = a.len() as f64 / n as f64;
            if (0.8..=1.2).contains(&ratio) { Some(a) } else { None }
        });
        let accel_arr: Option<Vec<f64>> = route.accel_positions.as_ref().and_then(|a| {
            let ratio = a.len() as f64 / n as f64;
            if (0.8..=1.2).contains(&ratio) { Some(a.iter().map(|v| v.unwrap_or(f64::NAN)).collect()) } else { None }
        });
        let gear_arr = decode_u8(&route.gear_states).and_then(|g| {
            let ratio = g.len() as f64 / n as f64;
            if (0.8..=1.2).contains(&ratio) { Some(g) } else { None }
        });
        let route_start = route.start_ms;
        for (i, p) in pts.iter().enumerate() {
            let (lat, lng) = (p.lat, p.lng);
            if !lat.is_finite() || !lng.is_finite() {
                continue;
            }
            let spd = if p.is_array {
                route.speeds.as_ref().and_then(|s| s.get(i).copied().flatten()).unwrap_or(0.0)
            } else {
                p.speed.unwrap_or(0.0)
            };
            let ap_val = match ap_arr.as_ref() {
                Some(a) if !a.is_empty() => a[i.min(a.len() - 1)],
                Some(_) => f64::NAN, // apArr[-1] → undefined
                None => 0.0,
            };
            let engaged = ap_val != 0.0 && !ap_val.is_nan();
            let point_t = route_start
                + if n > 1 { (i as f64 / (n as f64 - 1.0)) * CLIP_DURATION_MS } else { 0.0 };
            let gear = match gear_arr.as_ref() {
                Some(g) if !g.is_empty() => g[i.min(g.len() - 1)],
                Some(_) => f64::NAN,
                None => -1.0,
            };
            flat.push([lat, lng, 0.0, spd, if engaged { 1.0 } else { 0.0 }]);

            if prev_lat.is_finite() && prev_lng.is_finite() {
                let d = haversine_km(&mut cos_lat, prev_lat, prev_lng, lat, lng);
                total_km += d;
                if ap_arr.is_some() && engaged {
                    fsd_km += d;
                }
            }
            prev_lat = lat;
            prev_lng = lng;

            if pending {
                let since = point_t - pending_t;
                if gear == GEAR_PARK && since <= 2000.0 {
                    pending = false;
                } else if since > 2000.0 || engaged {
                    disengagements += 1;
                    events.push(json!({ "lat": pending_lat, "lng": pending_lng, "type": "disengagement" }));
                    pending = false;
                }
            }
            if engaged && !prev_engaged {
                engage_t = point_t;
            }
            if prev_engaged && !engaged {
                pending = true;
                pending_t = point_t;
                pending_lat = lat;
                pending_lng = lng;
                in_accel = false;
            }
            prev_engaged = engaged;

            if let Some(acc) = accel_arr.as_ref() {
                if engaged {
                    let mut pct = if acc.is_empty() { f64::NAN } else { acc[i.min(acc.len() - 1)] };
                    if pct <= 1.0 {
                        pct *= 100.0;
                    }
                    let since_engage = point_t - engage_t;
                    if !in_accel && pct > 1.0 && since_engage >= 3000.0 {
                        in_accel = true;
                        accel_lat = lat;
                        accel_lng = lng;
                    }
                    if in_accel && pct <= 0.0 {
                        accel_push += 1;
                        events.push(json!({ "lat": accel_lat, "lng": accel_lng, "type": "accel_push" }));
                        in_accel = false;
                    }
                } else {
                    in_accel = false;
                }
            }
        }
    }
    if pending {
        let last_gear = routes
            .last()
            .and_then(|r| decode_u8(&r.gear_states))
            .and_then(|g| g.last().copied())
            .unwrap_or(-1.0);
        if last_gear != GEAR_PARK {
            disengagements += 1;
            events.push(json!({ "lat": pending_lat, "lng": pending_lng, "type": "disengagement" }));
        }
    }

    let has_fsd = fsd_km > 0.0;
    let start_ms = routes[0].start_ms;
    let end_ms = routes[routes.len() - 1].start_ms + CLIP_DURATION_MS;
    let duration_ms = (end_ms - start_ms).max(0.0);
    let fsd_percent = if total_km > 0.0 { js_round((fsd_km / total_km) * 1000.0) / 10.0 } else { 0.0 };
    let fsd_engaged_ms =
        if duration_ms > 0.0 && total_km > 0.0 { js_round((fsd_km / total_km) * duration_ms) } else { 0.0 };
    let first_base = basename(routes[0].file_str()).to_string();
    let date: String = first_base.chars().take(10).collect();
    let key19: String = first_base.chars().take(19).collect();

    let tags = [id.to_string(), date.clone(), key19]
        .iter()
        .find_map(|k| drive_tags.get(k).filter(|v| js_truthy(v)).cloned())
        .unwrap_or(Value::Array(vec![]));
    let tags = if tags.is_array() { tags } else { Value::Array(vec![]) };

    let route_keys: Vec<Value> = routes
        .iter()
        .filter_map(|r| {
            let b = basename(r.file_str());
            parse_ts_prefix(b).map(|_| Value::String(b[..19].to_string()))
        })
        .collect();

    let num = |v: f64| -> Value { serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null) };
    let int = |v: f64| -> Value {
        if v.fract() == 0.0 && v.abs() < 9.0e15 { Value::from(v as i64) } else { num(v) }
    };
    let mut light = Map::new();
    light.insert("id".into(), Value::from(id as u64));
    light.insert("date".into(), Value::String(date));
    light.insert("startMs".into(), int(start_ms));
    light.insert("endMs".into(), int(end_ms));
    light.insert("startTimeDisplay".into(), Value::String(ms_to_time_str(start_ms)));
    light.insert("endTimeDisplay".into(), Value::String(ms_to_time_str(end_ms)));
    light.insert("durationMs".into(), int(duration_ms));
    light.insert("distanceKm".into(), int(total_km));
    light.insert("distanceMi".into(), int(total_km * 0.621371));
    light.insert("clipCount".into(), Value::from(routes.len() as u64));
    light.insert("pointCount".into(), Value::from(flat.len() as u64));
    light.insert("hasFsd".into(), Value::Bool(has_fsd));
    light.insert("fsdEngagedMs".into(), int(fsd_engaged_ms));
    light.insert("fsdDisengagements".into(), Value::from(disengagements));
    light.insert("fsdPercent".into(), int(fsd_percent));
    light.insert("fsdDistanceKm".into(), int(fsd_km));
    light.insert("fsdDistanceMi".into(), int(fsd_km * 0.621371));
    light.insert("accelPushCount".into(), Value::from(accel_push));
    light.insert("tags".into(), tags);
    light.insert("routeTimestampKeys".into(), Value::Array(route_keys));
    light.insert(
        "startPoint".into(),
        flat.first().map_or(Value::Null, |p| json!([int(p[0]), int(p[1])])),
    );
    light.insert(
        "endPoint".into(),
        flat.last().map_or(Value::Null, |p| json!([int(p[0]), int(p[1])])),
    );

    Drive { light, points: downsample(flat, 3000), fsd_events: events }
}

fn downsample(arr: Vec<[f64; 5]>, max: usize) -> Vec<[f64; 5]> {
    if arr.len() <= max {
        return arr;
    }
    let step = (arr.len() as f64 - 1.0) / (max as f64 - 1.0);
    (0..max).map(|i| arr[js_round(i as f64 * step) as usize]).collect()
}

pub struct Grouped {
    pub drives: Vec<Drive>,
    pub route_count: usize,
    pub routes_len: usize,
}

pub fn group_store_data(store: StoreData) -> Grouped {
    let routes_len = store.routes.len();
    if routes_len == 0 {
        return Grouped { drives: vec![], route_count: 0, routes_len };
    }
    let mut with_time: Vec<Route> = store
        .routes
        .into_iter()
        .filter_map(|mut r| {
            let t = parse_route_timestamp_ms(r.file_str())?;
            r.start_ms = t;
            Some(r)
        })
        .collect();
    with_time.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));
    let route_count = with_time.len();
    if with_time.is_empty() {
        // JS would crash on routesWithTime[0] being undefined; treat as no drives.
        return Grouped { drives: vec![], route_count: 0, routes_len };
    }

    let mut raw_groups: Vec<Vec<Route>> = Vec::new();
    let mut iter = with_time.into_iter();
    let mut current = vec![iter.next().unwrap()];
    for curr in iter {
        let prev_end = current.last().unwrap().start_ms + CLIP_DURATION_MS;
        if curr.start_ms - prev_end > DRIVE_GAP_MS {
            raw_groups.push(std::mem::take(&mut current));
        }
        current.push(curr);
    }
    raw_groups.push(current);

    let mut all = Vec::new();
    for g in raw_groups {
        all.extend(split_by_gear_state(g));
    }
    let drives = all.iter().enumerate().map(|(i, g)| build_drive(i + 1, g, &store.drive_tags)).collect();
    Grouped { drives, route_count, routes_len }
}

