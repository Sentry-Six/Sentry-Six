//! Drive history from SentryUSB's drive-data.json, loaded and grouped by
//! `drive_data.rs`. Only what the Drives list, playback and the map need is
//! kept: up to 1,000 route points and the FSD events per drive.

use anyhow::Result;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::Path;

/// A group's drives with their two place names, once all are built.
type BuiltGroup = Vec<(DriveInfo, [String; 2])>;

#[derive(Debug, Clone, PartialEq)]
pub struct DriveInfo {
    pub id: u64,
    /// YYYY-MM-DD, local.
    pub date: String,
    /// Epoch milliseconds.
    pub start_ms: f64,
    pub end_ms: f64,
    pub duration_ms: f64,
    pub km: f64,
    pub mi: f64,
    pub has_fsd: bool,
    pub fsd_percent: f64,
    pub disengagements: u64,
    pub accel_pushes: u64,
    pub tags: Vec<String>,
    /// The one-minute clips this drive covers ("YYYY-MM-DD_HH-MM-SS").
    pub clip_keys: Vec<String>,
    pub start_point: Option<(f64, f64)>,
    pub end_point: Option<(f64, f64)>,
    /// The drive's route for the map (at most ROUTE_POINTS): latitude,
    /// longitude, and whether Autopilot / FSD was driving.
    pub route: Vec<(f32, f32, bool)>,
    /// FSD disengagements (true) and accelerator pushes (false) on the way.
    pub fsd_events: Vec<(f32, f32, bool)>,
}

/// Route points kept per drive: plenty for a 260 px map, and small enough
/// to keep for every drive (about 12 bytes each).
const ROUTE_POINTS: usize = 1000;

/// A grouped drive with its route and FSD events (`autopilot` is
/// points[4] > 0).
fn from_drive(d: &crate::drive_data::Drive) -> DriveInfo {
    let mut info = from_light(&d.light);
    let step = (d.points.len() as f64 / ROUTE_POINTS as f64).max(1.0);
    let mut k = 0.0;
    while (k as usize) < d.points.len() {
        let p = d.points[k as usize];
        info.route.push((p[0] as f32, p[1] as f32, p[4] > 0.0));
        k += step;
    }
    if let (Some(last), Some(kept)) = (d.points.last(), info.route.last()) {
        if (last[0] as f32, last[1] as f32) != (kept.0, kept.1) {
            info.route.push((last[0] as f32, last[1] as f32, last[4] > 0.0));
        }
    }
    info.fsd_events = d
        .fsd_events
        .iter()
        .filter_map(|e| {
            let lat = e.get("lat")?.as_f64()?;
            let lng = e.get("lng")?.as_f64()?;
            Some((lat as f32, lng as f32, e.get("type").and_then(Value::as_str) == Some("disengagement")))
        })
        .collect();
    info
}

fn num(m: &Map<String, Value>, k: &str) -> f64 {
    m.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn point(m: &Map<String, Value>, k: &str) -> Option<(f64, f64)> {
    let a = m.get(k)?.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

fn from_light(m: &Map<String, Value>) -> DriveInfo {
    let strings = |k: &str| -> Vec<String> {
        m.get(k)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    DriveInfo {
        id: m.get("id").and_then(Value::as_u64).unwrap_or(0),
        date: m.get("date").and_then(Value::as_str).unwrap_or("").to_string(),
        start_ms: num(m, "startMs"),
        end_ms: num(m, "endMs"),
        duration_ms: num(m, "durationMs"),
        km: num(m, "distanceKm"),
        mi: num(m, "distanceMi"),
        has_fsd: m.get("hasFsd").and_then(Value::as_bool).unwrap_or(false),
        fsd_percent: num(m, "fsdPercent"),
        disengagements: m.get("fsdDisengagements").and_then(Value::as_u64).unwrap_or(0),
        accel_pushes: m.get("accelPushCount").and_then(Value::as_u64).unwrap_or(0),
        tags: strings("tags"),
        clip_keys: strings("routeTimestampKeys"),
        start_point: point(m, "startPoint"),
        end_point: point(m, "endPoint"),
        route: Vec::new(),
        fsd_events: Vec::new(),
    }
}

/// Loads and groups drive-data.json, newest drive first.
///
/// The file (over 1 GB on a long-used SentryUSB) is read twice as a
/// stream instead of being held in memory whole:
/// 1. only the clip names, which give every route's time, so the routes
///    can be sorted and grouped into drives exactly as the whole-file
///    loader does (`group_store_data`);
/// 2. everything, building each drive as soon as its last route has been
///    read and then dropping its GPS points.
///
/// Routes are mostly stored in time order, so few drives wait in memory.
/// If the file changes between the two reads, it is loaded the old way.
pub fn load(path: &Path) -> Result<Vec<DriveInfo>> {
    let mut drives = match load_streaming(path)? {
        Some(d) => d,
        None => load_whole(path)?,
    };
    drives.sort_by(|a, b| b.start_ms.partial_cmp(&a.start_ms).unwrap_or(std::cmp::Ordering::Equal));
    release_free_memory();
    Ok(drives)
}

/// The whole-file loader: every route in memory, sorted, then grouped.
pub fn load_whole(path: &Path) -> Result<Vec<DriveInfo>> {
    let store = crate::drive_data::read_store_data(path)?;
    let grouped = crate::drive_data::group_store_data(store);
    Ok(grouped.drives.iter().map(from_drive).collect())
}

/// What the first read keeps: each route's time (None: no timestamp in its
/// name, so the loader skips it), and the drive tags.
struct Index {
    starts: Vec<Option<f64>>,
    tags: Map<String, Value>,
}

/// Reads the top-level object, handing each route (and the drive tags) to
/// the callbacks. Keys are matched as `read_store_data` matches them.
fn stream_file<R: serde::de::DeserializeOwned>(
    path: &Path,
    mut on_route: impl FnMut(R),
    mut on_tags: impl FnMut(Map<String, Value>),
) -> Result<()> {
    use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
    use std::fmt;
    use std::marker::PhantomData;

    struct Routes<'a, R, F>(&'a mut F, PhantomData<R>);
    impl<'de, R: serde::de::DeserializeOwned, F: FnMut(R)> DeserializeSeed<'de> for Routes<'_, R, F> {
        type Value = ();
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
            struct V<'a, R, F>(&'a mut F, PhantomData<R>);
            impl<'de, R: serde::de::DeserializeOwned, F: FnMut(R)> Visitor<'de> for V<'_, R, F> {
                type Value = ();
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("routes array")
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<(), A::Error> {
                    while let Some(r) = a.next_element::<R>()? {
                        (self.0)(r);
                    }
                    Ok(())
                }
            }
            d.deserialize_seq(V(self.0, PhantomData))
        }
    }

    struct Top<'a, R, F, T>(&'a mut F, &'a mut T, PhantomData<R>);
    impl<'de, R: serde::de::DeserializeOwned, F: FnMut(R), T: FnMut(Map<String, Value>)> DeserializeSeed<'de> for Top<'_, R, F, T> {
        type Value = ();
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
            struct V<'a, R, F, T>(&'a mut F, &'a mut T, PhantomData<R>);
            impl<'de, R: serde::de::DeserializeOwned, F: FnMut(R), T: FnMut(Map<String, Value>)> Visitor<'de> for V<'_, R, F, T> {
                type Value = ();
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("drive-data.json object")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<(), A::Error> {
                    while let Some(k) = a.next_key::<String>()? {
                        let lower = k.to_ascii_lowercase();
                        if lower == "routes" {
                            a.next_value_seed(Routes::<R, F>(&mut *self.0, PhantomData))?;
                        } else if lower == "drivetags" || lower == "drive_tags" {
                            if let Some(m) = a.next_value::<Option<Map<String, Value>>>()? {
                                (self.1)(m);
                            }
                        } else {
                            a.next_value::<IgnoredAny>()?;
                        }
                    }
                    Ok(())
                }
            }
            d.deserialize_map(V(self.0, self.1, PhantomData))
        }
    }

    let reader = std::io::BufReader::with_capacity(4 << 20, std::fs::File::open(path)?);
    let mut de = serde_json::Deserializer::from_reader(reader);
    Top::<R, _, _>(&mut on_route, &mut on_tags, PhantomData).deserialize(&mut de)?;
    Ok(())
}

/// A route's name only (the first read skips everything else).
#[derive(serde::Deserialize)]
struct RouteName {
    #[serde(alias = "File", default)]
    file: Option<String>,
}

fn read_index(path: &Path) -> Result<Index> {
    let mut starts = Vec::new();
    let mut tags = Map::new();
    stream_file::<RouteName>(
        path,
        |r| starts.push(crate::drive_data::parse_route_timestamp_ms(r.file.as_deref().unwrap_or(""))),
        |m| tags.extend(m),
    )?;
    Ok(Index { starts, tags })
}

/// `group_store_data`'s time groups, as route positions in the file: routes
/// with a time, stably sorted by it, split where the gap after a clip is
/// over DRIVE_GAP_MS. Each group lists its routes in sorted order.
fn time_groups(starts: &[Option<f64>]) -> Vec<Vec<usize>> {
    use crate::drive_data::{CLIP_DURATION_MS, DRIVE_GAP_MS};
    let mut order: Vec<usize> = (0..starts.len()).filter(|&i| starts[i].is_some()).collect();
    order.sort_by(|&a, &b| starts[a].partial_cmp(&starts[b]).unwrap_or(std::cmp::Ordering::Equal));
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut prev: Option<f64> = None;
    for i in order {
        let t = starts[i].unwrap_or_default();
        match prev {
            Some(p) if t - (p + CLIP_DURATION_MS) <= DRIVE_GAP_MS => groups.last_mut().unwrap().push(i),
            _ => groups.push(vec![i]),
        }
        prev = Some(t);
    }
    groups
}

pub fn load_streaming(path: &Path) -> Result<Option<Vec<DriveInfo>>> {
    use crate::drive_data::{basename, build_drive, split_by_gear_state, Route};
    use std::collections::HashMap;

    let index = read_index(path)?;
    let groups = time_groups(&index.starts);
    let mut group_of = vec![usize::MAX; index.starts.len()];
    for (g, members) in groups.iter().enumerate() {
        for &i in members {
            group_of[i] = g;
        }
    }

    // Routes of drives still missing some, by group; built drives, by group.
    let mut waiting: HashMap<usize, HashMap<usize, Route>> = HashMap::new();
    let mut built: Vec<Option<BuiltGroup>> = (0..groups.len()).map(|_| None).collect();
    let mut position = 0usize;
    let mut changed = false;
    let no_tags = Map::new();
    stream_file::<Route>(
        path,
        |mut route| {
            let i = position;
            position += 1;
            let Some(&g) = group_of.get(i) else {
                changed = true;
                return;
            };
            if g == usize::MAX || changed {
                return;
            }
            let Some(start) = crate::drive_data::parse_route_timestamp_ms(route.file.as_deref().unwrap_or("")) else {
                changed = true;
                return;
            };
            route.start_ms = start;
            let have = waiting.entry(g).or_default();
            have.insert(i, route);
            if have.len() < groups[g].len() {
                return;
            }
            // The drive's last route is in: build it as group_store_data does.
            let mut have = waiting.remove(&g).unwrap_or_default();
            let routes: Vec<Route> = groups[g].iter().filter_map(|i| have.remove(i)).collect();
            let mut drives = Vec::new();
            for piece in split_by_gear_state(routes) {
                let drive = build_drive(0, &piece, &no_tags);
                let first = basename(piece[0].file.as_deref().unwrap_or(""));
                drives.push((from_drive(&drive), [first.chars().take(10).collect(), first.chars().take(19).collect()]));
            }
            built[g] = Some(drives);
        },
        |_| {},
    )?;
    if changed || position != index.starts.len() || !waiting.is_empty() || built.iter().any(Option::is_none) {
        return Ok(None);
    }

    // Number the drives in time order and look up their tags (build_drive's
    // rule: the first truthy entry for the id, the date, or the first clip's
    // timestamp; only an array counts).
    let mut drives = Vec::new();
    for (mut info, [date, key19]) in built.into_iter().flatten().flatten() {
        let id = drives.len() as u64 + 1;
        info.id = id;
        let found = [id.to_string(), date, key19].iter().find_map(|k| index.tags.get(k).filter(|v| crate::drive_data::js_truthy(v)).cloned());
        info.tags = match found {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        drives.push(info);
    }
    Ok(Some(drives))
}

/// Hands memory freed after loading back to the system (macOS keeps freed
/// pages counted against the app until it is under pressure otherwise).
fn release_free_memory() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: a null zone means every zone; goal 0 means as much as possible.
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
}

/// The days the drive's clips fall on.
pub fn clip_days(d: &DriveInfo) -> Vec<String> {
    let mut days: Vec<String> = d.clip_keys.iter().filter_map(|k| k.get(..10).map(str::to_string)).collect();
    days.sort();
    days.dedup();
    if days.is_empty() && !d.date.is_empty() {
        days.push(d.date.clone());
    }
    days
}

pub fn key_set(d: &DriveInfo) -> HashSet<&str> {
    d.clip_keys.iter().map(String::as_str).collect()
}

// ---------------------------------------------------------------------------
// Drive card formats
// ---------------------------------------------------------------------------

/// "4:25 AM" (or "04:25" in 24-hour), local time.
pub fn clock(ms: f64, h24: bool) -> String {
    use chrono::{Local, TimeZone, Timelike};
    if ms <= 0.0 {
        return "--:--".into();
    }
    let Some(t) = Local.timestamp_millis_opt(ms as i64).single() else { return "--:--".into() };
    let (h, m) = (t.hour(), t.minute());
    if h24 {
        format!("{h:02}:{m:02}")
    } else {
        format!("{}:{m:02} {}", if h % 12 == 0 { 12 } else { h % 12 }, if h >= 12 { "PM" } else { "AM" })
    }
}

/// "17 min" or "1h 2m".
pub fn journey_duration(ms: f64) -> String {
    let total = (ms / 60000.0).floor() as i64;
    let (h, m) = (total / 60, total % 60);
    if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m} min")
    }
}

pub fn distance(d: &DriveInfo, metric: bool) -> String {
    if metric {
        format!("{:.1} km", d.km)
    } else {
        format!("{:.1} mi", d.mi)
    }
}

/// Coordinates until a place name is known ("53.5461, -113.4938").
pub fn gps_label(p: Option<(f64, f64)>) -> String {
    p.map(|(lat, lon)| format!("{lat:.4}, {lon:.4}")).unwrap_or_default()
}

/// The date header: "THU, NOV 6, 2026" (upper-cased), in the app's
/// language.
pub fn date_header(date: &str) -> String {
    let Ok(d) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else { return date.to_string() };
    use chrono::Locale;
    let (locale, pattern) = match crate::i18n::language() {
        "es" => (Locale::es_ES, "%a, %-d %b %Y"),
        "fr" => (Locale::fr_FR, "%a %-d %b %Y"),
        "de" => (Locale::de_DE, "%a, %-d. %b %Y"),
        "zh" => (Locale::zh_CN, "%Y年%-m月%-d日 %a"),
        "ja" => (Locale::ja_JP, "%Y年%-m月%-d日(%a)"),
        "ko" => (Locale::ko_KR, "%Y년 %-m월 %-d일 (%a)"),
        "pt" => (Locale::pt_BR, "%a, %-d de %b de %Y"),
        "ru" => (Locale::ru_RU, "%a, %-d %b %Y"),
        "it" => (Locale::it_IT, "%a %-d %b %Y"),
        "nl" => (Locale::nl_NL, "%a %-d %b %Y"),
        "pl" => (Locale::pl_PL, "%a, %-d %b %Y"),
        "tr" => (Locale::tr_TR, "%-d %b %Y %a"),
        _ => (Locale::en_US, "%a, %b %-d, %Y"),
    };
    d.format_localized(pattern, locale).to_string().to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_formats() {
        assert_eq!(journey_duration(17.9 * 60000.0), "17 min");
        assert_eq!(journey_duration(62.0 * 60000.0), "1h 2m");
        assert_eq!(date_header("2026-11-06"), "FRI, NOV 6, 2026");
        assert_eq!(gps_label(Some((53.54612, -113.49381))), "53.5461, -113.4938");
    }

    #[test]
    fn streaming_matches_whole_file_loader() {
        // Two drives on one day and one on another, with a route of the
        // first drive written last (out of order) and tags by date and id.
        let route = |file: &str, lat: f64| {
            serde_json::json!({ "File": file, "Points": [[lat, -113.5], [lat + 0.001, -113.5]], "Speeds": [10.0, 12.0] })
        };
        let json = serde_json::json!({
            "routes": [
                route("2026-07-08_10-00-00-front.mp4", 53.50),
                route("2026-07-08_10-02-00-front.mp4", 53.52),
                route("2026-07-08_14-00-00-front.mp4", 53.60),
                route("2026-07-09_09-00-00-front.mp4", 53.70),
                route("2026-07-08_10-01-00-front.mp4", 53.51),
                route("no-timestamp.mp4", 53.0),
            ],
            "driveTags": { "2026-07-09": ["Work"], "2": ["Errand"] },
        });
        let path = std::env::temp_dir().join(format!("drives-stream-test-{}.json", std::process::id()));
        std::fs::write(&path, json.to_string()).unwrap();
        let streamed = load_streaming(&path).unwrap().expect("streaming applies");
        let whole = load_whole(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(streamed, whole);
        assert_eq!(streamed.len(), 3);
        assert_eq!(streamed[0].clip_keys.len(), 3);
        assert_eq!(streamed[1].tags, vec!["Errand".to_string()]);
        assert_eq!(streamed[2].tags, vec!["Work".to_string()]);
    }

    #[test]
    fn clip_days_from_keys() {
        let mut d = from_light(&Map::new());
        d.clip_keys = vec!["2026-11-05_23-59-10".into(), "2026-11-06_00-00-10".into(), "2026-11-05_23-58-10".into()];
        assert_eq!(clip_days(&d), vec!["2026-11-05", "2026-11-06"]);
    }
}
