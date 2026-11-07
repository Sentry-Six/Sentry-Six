//! Place names for drive start and end points, the way Sentry Drive does
//! them: OpenStreetMap's Nominatim reverse geocoder, at most one request
//! every 1.1 s (its usage policy), with a User-Agent naming the app, in
//! the app's language. Each spot is asked for street-level detail first; when
//! that is not a confident match, the other layer (address vs. place) is
//! compared, and the town is the last resort. Sentry Drive's rules decide
//! how trustworthy each answer is (matching.rs, js.rs, calc.rs are its code).
//! A cache file keyed to ~1 m means each spot is looked up once; Sentry
//! Drive's own cache is read to start from. On by default, like Sentry
//! Drive, with an off switch in Settings.
//!
//! Lookups run on one background thread, the drives on screen first (top
//! to bottom), then anything asked for earlier, newest first. A spot within
//! NEARBY_M of one already named takes that name without a request, since
//! most drives start and end at the same few places. `wait_for_update`
//! lets the app sleep until a new name arrives, so names appear while
//! paused too.

// calc.rs, js.rs and matching.rs are Sentry Drive's files, kept unchanged
// so fixes can be copied between the two apps. Not everything in them is
// used here.
mod calc;
#[allow(dead_code)]
mod js;
#[allow(dead_code)]
mod matching;

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const RATE: Duration = Duration::from_millis(1100);
/// How far off a drive's start/end point may be (metres), as Sentry Drive
/// assumes for drive endpoints.
const QUERY_ACCURACY_M: f64 = 35.0;
/// Spots this close (metres) share a name: GPS wanders a few metres
/// between parks in the same spot.
const NEARBY_M: f64 = 20.0;
const UA: &str = crate::USER_AGENT;

/// Cache key: coordinates to 5 decimals (~1.1 m), as earlier versions of
/// Sentry Studio keyed them.
pub fn key(lat: f64, lon: f64) -> String {
    format!("{lat:.5},{lon:.5}")
}

type Spot = (String, f64, f64);

#[derive(Default)]
struct Queue {
    /// The spots on screen, in order: looked up first.
    screen: Vec<Spot>,
    /// Spots asked for before, looked up newest first.
    later: Vec<Spot>,
    /// Spots whose lookup failed, and when they may be tried again.
    retry_after: HashMap<String, Instant>,
}

struct Inner {
    cache: Mutex<HashMap<String, Option<String>>>,
    queue: (Mutex<Queue>, Condvar),
    /// Count of answers so far, to wake the app when one arrives.
    updates: (Mutex<u64>, Condvar),
    cache_file: PathBuf,
}

#[derive(Clone)]
pub struct Geocoder {
    inner: Arc<Inner>,
}

/// Reads a cache: this app's (key -> label) or Sentry Drive's versioned
/// one ({ __v, entries: key -> { label, ... } }).
fn read_cache(path: &Path) -> HashMap<String, Option<String>> {
    let Some(v) = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return HashMap::new();
    };
    let map = match v.get("entries").and_then(Value::as_object) {
        Some(entries) => entries,
        None => match v.as_object() {
            Some(m) => m,
            None => return HashMap::new(),
        },
    };
    map.iter()
        .map(|(k, v)| {
            let label = match v {
                Value::Object(record) => record.get("label").and_then(Value::as_str).map(str::to_string),
                other => other.as_str().map(str::to_string),
            };
            (k.clone(), label)
        })
        .collect()
}

impl Geocoder {
    /// `cache_file` is the app's own cache; `seeds` are other caches to
    /// start from (Sentry Drive's), read only.
    pub fn new(cache_file: PathBuf, seeds: &[PathBuf]) -> Self {
        let mut cache = HashMap::new();
        for seed in seeds {
            cache.extend(read_cache(seed));
        }
        cache.extend(read_cache(&cache_file));
        let inner = Arc::new(Inner {
            cache: Mutex::new(cache),
            queue: (Mutex::new(Queue::default()), Condvar::new()),
            updates: (Mutex::new(0), Condvar::new()),
            cache_file,
        });
        let worker = inner.clone();
        std::thread::Builder::new()
            .name("geocode".into())
            .spawn(move || run(worker))
            .expect("start geocoder");
        Self { inner }
    }

    /// The cached answer: Some(Some(name)), Some(None) for "nothing here",
    /// or None when not looked up yet.
    pub fn cached(&self, lat: f64, lon: f64) -> Option<Option<String>> {
        self.inner.cache.lock().unwrap().get(&key(lat, lon)).cloned()
    }

    /// The spots on screen now, top to bottom (cached ones are skipped).
    /// They go before everything else; the ones that scrolled away stay
    /// queued behind them.
    pub fn show(&self, spots: &[(f64, f64)]) {
        let screen: Vec<Spot> = {
            let cache = self.inner.cache.lock().unwrap();
            spots
                .iter()
                .filter(|(lat, lon)| lat.is_finite() && lon.is_finite())
                .map(|&(lat, lon)| (key(lat, lon), lat, lon))
                .filter(|(k, _, _)| !cache.contains_key(k))
                .collect()
        };
        let (lock, cvar) = &self.inner.queue;
        let mut q = lock.lock().unwrap();
        // A spot whose lookup just failed waits its turn (see `run`).
        let now = Instant::now();
        q.retry_after.retain(|_, t| *t > now);
        let screen: Vec<Spot> = screen.into_iter().filter(|s| !q.retry_after.contains_key(&s.0)).collect();
        if q.screen.iter().map(|s| &s.0).eq(screen.iter().map(|s| &s.0)) {
            return;
        }
        let old = std::mem::take(&mut q.screen);
        let on_screen: HashSet<&String> = screen.iter().map(|s| &s.0).collect();
        let moved: Vec<Spot> = old.into_iter().filter(|s| !on_screen.contains(&s.0)).collect();
        q.later.retain(|s| !on_screen.contains(&s.0));
        q.later.extend(moved);
        q.screen = screen;
        cvar.notify_one();
    }

    /// Drops every queued lookup (Place Names was turned off).
    pub fn stop(&self) {
        let (lock, _) = &self.inner.queue;
        let mut q = lock.lock().unwrap();
        q.screen.clear();
        q.later.clear();
    }

    /// Blocks until an answer newer than `seen` arrives (or a while
    /// passes), and returns the new count.
    pub fn wait_for_update(&self, seen: u64) -> u64 {
        let (lock, cvar) = &self.inner.updates;
        let n = lock.lock().unwrap();
        let (n, _) = cvar.wait_timeout_while(n, Duration::from_secs(30), |n| *n <= seen).unwrap();
        *n
    }
}

/// A name already found within NEARBY_M of a spot.
fn nearby_name(cache: &HashMap<String, Option<String>>, lat: f64, lon: f64) -> Option<String> {
    let deg = NEARBY_M / 111_000.0 * 2.0;
    cache
        .iter()
        .filter_map(|(k, v)| {
            let name = v.as_ref()?;
            let (a, b) = k.split_once(',')?;
            let (klat, klon) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?);
            if (klat - lat).abs() > deg || (klon - lon).abs() > deg * 3.0 {
                return None;
            }
            let d = calc::geodesic_m(lat, lon, klat, klon);
            (d <= NEARBY_M).then_some((d, name))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, name)| name.clone())
}

/// The next spot to look up: on screen first, then the newest asked for.
fn next_spot(inner: &Inner) -> Spot {
    let (lock, cvar) = &inner.queue;
    let mut q = lock.lock().unwrap();
    loop {
        let spot = if q.screen.is_empty() { q.later.pop() } else { Some(q.screen.remove(0)) };
        match spot {
            Some(s) => return s,
            None => q = cvar.wait(q).unwrap(),
        }
    }
}

fn run(inner: Arc<Inner>) {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(12))).build().into();
    let mut last: Option<Instant> = None;
    // One provider request, at least RATE after the previous one, in the
    // app's language. `Err` when the provider can't be reached or turns the
    // request away (rate limits, blocks, outages), `Ok(None)` when its
    // answer is unusable.
    let mut fetch = |lat: f64, lon: f64, zoom: u8, layer: Option<&str>| -> Result<Option<Value>, ()> {
        if let Some(t) = last {
            if let Some(wait) = RATE.checked_sub(t.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        last = Some(Instant::now());
        let Some(url) = matching::build_reverse_url(matching::DEFAULT_ENDPOINT, lat, lon, zoom, layer) else { return Ok(None) };
        let req = agent
            .get(url.as_str())
            .header("User-Agent", UA)
            .header("Accept", "application/json")
            .header("Accept-Language", crate::i18n::language());
        // ureq reports 4xx/5xx statuses as errors too.
        let mut resp = req.call().map_err(|_| ())?;
        let Ok(text) = resp.body_mut().with_config().limit(2 << 20).read_to_string() else { return Ok(None) };
        Ok(serde_json::from_str::<Value>(&text).ok())
    };
    // After a failure, wait before the next request: 30 s, doubling up to
    // 30 minutes, back to none after a success.
    let mut backoff = Duration::ZERO;
    loop {
        let (k, lat, lon) = next_spot(&inner);
        let near = {
            let cache = inner.cache.lock().unwrap();
            if cache.contains_key(&k) {
                continue;
            }
            nearby_name(&cache, lat, lon)
        };
        if let Some(name) = near {
            inner.cache.lock().unwrap().insert(k, Some(name));
            let (lock, cvar) = &inner.updates;
            *lock.lock().unwrap() += 1;
            cvar.notify_all();
            continue;
        }
        let acc = QUERY_ACCURACY_M;
        // Sentry Drive's order: street level first, the other layer when
        // that is not a confident match, then the town.
        let answer: Result<Option<Option<String>>, ()> = (|| {
            let Some(street) = fetch(lat, lon, 18, Some("address,poi"))? else { return Ok(None) };
            let mut m = matching::label_match(&street, lat, lon, acc);
            if m.as_ref().map(|m| m.confidence) != Some("high") {
                let other = if matching::result_layer(&street) == "poi" { "address" } else { "poi" };
                if let Some(alt) = fetch(lat, lon, 18, Some(other))? {
                    m = matching::choose_better_match(m, matching::label_match(&alt, lat, lon, acc));
                }
            }
            if m.is_none() {
                let Some(town) = fetch(lat, lon, 10, None)? else { return Ok(None) };
                m = matching::city_match(&town, lat, lon, acc);
            }
            Ok(Some(m.map(|m| m.label)))
        })();
        let label = match answer {
            Ok(Some(label)) => {
                backoff = Duration::ZERO;
                label
            }
            // Not cached, so tried again later; the spot sits out a while
            // so the list being redrawn doesn't ask for it straight away.
            Ok(None) | Err(()) => {
                if answer.is_err() {
                    backoff = (backoff * 2).clamp(Duration::from_secs(30), Duration::from_secs(30 * 60));
                }
                let (lock, _) = &inner.queue;
                lock.lock().unwrap().retry_after.insert(k, Instant::now() + backoff.max(Duration::from_secs(60)));
                std::thread::sleep(backoff);
                continue;
            }
        };
        let snapshot = {
            let mut cache = inner.cache.lock().unwrap();
            cache.insert(k, label);
            // Only names are kept on disk: a "nothing here" is asked again
            // on a later launch, in case the map has gained a name there.
            serde_json::to_string(
                &cache.iter().filter_map(|(k, v)| Some((k.clone(), Value::String(v.clone()?)))).collect::<serde_json::Map<_, _>>(),
            )
        };
        if let Ok(text) = snapshot {
            if let Some(dir) = inner.cache_file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            // Written aside and renamed over, so a crash mid-write can't
            // leave a broken cache.
            let tmp = inner.cache_file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &inner.cache_file);
            }
        }
        let (lock, cvar) = &inner.updates;
        *lock.lock().unwrap() += 1;
        cvar.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys() {
        assert_eq!(key(40.123712345, -100.4232), "40.12371,-100.42320");
        assert_eq!(key(40.12349, -100.43883), matching::key_for(40.12349, -100.43883));
    }

    #[test]
    fn nearby_spots_share_a_name() {
        let mut cache = HashMap::new();
        cache.insert(key(40.12371, -100.42320), Some("Main Street".to_string()));
        cache.insert(key(40.12380, -100.42320), None);
        // ~11 m north: same name; ~110 m away: none.
        assert_eq!(nearby_name(&cache, 40.12381, -100.42320).as_deref(), Some("Main Street"));
        assert_eq!(nearby_name(&cache, 40.12471, -100.42320), None);
    }
}
