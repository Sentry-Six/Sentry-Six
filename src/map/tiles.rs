//! Map tiles: pre-rendered raster tiles (512 px, "@2x") from Sentry's tile
//! server, rendered in Sentry Studio's own map styles (colorful and
//! sentry-dark).
//!
//! `https://tiles.sentryusb.com/raster/index.json` says where the tiles are
//! (a URL template per style, with a revision so new renders get new
//! URLs), how far they zoom, and the credits to show. Tiles are fetched on
//! a few background threads with the Sentry Studio User-Agent, kept in a
//! disk cache keyed by URL (so revisions never mix), and decoded into a
//! small memory cache. `wait_for_update` lets the app sleep until a tile arrives.
//!
//! For development, SENTRY_STUDIO_TILES can be a URL template
//! ("http://localhost:8000/{z}/{x}/{y}.png") used for both styles, and
//! SENTRY_STUDIO_TILES_INDEX another index.json (a local copy of the
//! renderer: its tile URLs are pointed at the same server).

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub const INDEX_URL: &str = "https://tiles.sentryusb.com/raster/index.json";
const UA: &str = crate::USER_AGENT;
const FETCHERS: usize = 4;
/// Decoded tiles kept in memory (each 512 x 512 RGBA, about 1 MB): one
/// view's ~16, plus the zoom levels either side as stand-ins.
const MEMORY_TILES: usize = 72;
/// The index is fetched again after this long, or this soon after a fetch
/// that failed (offline at launch, say).
const INDEX_MAX_AGE: Duration = Duration::from_secs(3600);
const INDEX_RETRY: Duration = Duration::from_secs(30);
/// The disk cache is kept under this size (oldest tiles go first).
const DISK_CACHE_BYTES: u64 = 500 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Style {
    Light,
    Dark,
}

impl Style {
    fn key(self) -> &'static str {
        match self {
            Style::Light => "colorful",
            Style::Dark => "sentry-dark",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileId {
    pub style: Style,
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

/// What index.json says.
#[derive(Debug, Clone)]
pub struct Index {
    templates: HashMap<Style, String>,
    pub max_zoom: u8,
    pub attribution: String,
}

impl Index {
    fn parse(v: &Value) -> Option<Self> {
        let styles = v.get("styles")?.as_object()?;
        let mut templates = HashMap::new();
        for style in [Style::Light, Style::Dark] {
            if let Some(t) = styles.get(style.key()).and_then(|s| s.get("tiles")).and_then(Value::as_str) {
                templates.insert(style, t.to_string());
            }
        }
        if templates.is_empty() {
            return None;
        }
        Some(Self {
            templates,
            max_zoom: v.get("maxzoom").and_then(Value::as_u64).unwrap_or(19).min(22) as u8,
            attribution: v.get("attribution").and_then(Value::as_str).unwrap_or("© OpenStreetMap contributors").to_string(),
        })
    }

    fn url(&self, id: TileId) -> Option<String> {
        let t = self.templates.get(&id.style).or_else(|| self.templates.values().next())?;
        Some(t.replace("{z}", &id.z.to_string()).replace("{x}", &id.x.to_string()).replace("{y}", &id.y.to_string()))
    }
}

enum Slot {
    Loading,
    Ready(iced::widget::image::Handle),
    /// Failed; tried again after this moment.
    Failed(Instant),
}

struct State {
    index: Option<Index>,
    index_tried: Option<Instant>,
    tiles: HashMap<TileId, Slot>,
    /// Least recently used first (decoded tiles only).
    order: VecDeque<TileId>,
    queue: VecDeque<TileId>,
    queued: HashSet<TileId>,
}

struct Inner {
    state: Mutex<State>,
    work: Condvar,
    updates: (Mutex<u64>, Condvar),
    cache_dir: Option<PathBuf>,
}

#[derive(Clone)]
pub struct Tiles {
    inner: Arc<Inner>,
}

impl Tiles {
    pub fn new(cache_dir: Option<PathBuf>) -> Self {
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                index: dev_index(),
                index_tried: None,
                tiles: HashMap::new(),
                order: VecDeque::new(),
                queue: VecDeque::new(),
                queued: HashSet::new(),
            }),
            work: Condvar::new(),
            updates: (Mutex::new(0), Condvar::new()),
            cache_dir,
        });
        for n in 0..FETCHERS {
            let inner = inner.clone();
            std::thread::Builder::new().name(format!("map-tiles-{n}")).spawn(move || fetcher(inner)).expect("start tile fetcher");
        }
        Self { inner }
    }

    /// The index, fetching it (in the background) if it is missing or old.
    pub fn index(&self) -> Option<Index> {
        let mut st = self.inner.state.lock().unwrap();
        let stale = st.index_tried.is_none_or(|t| t.elapsed() > INDEX_MAX_AGE);
        if stale && std::env::var_os("SENTRY_STUDIO_TILES").is_none() {
            // (SENTRY_STUDIO_TILES_INDEX is read by fetch_index.)
            st.index_tried = Some(Instant::now());
            let inner = self.inner.clone();
            std::thread::spawn(move || match fetch_index(inner.cache_dir.as_deref()) {
                Some(index) => {
                    inner.state.lock().unwrap().index = Some(index);
                    inner.work.notify_all();
                    bump(&inner);
                }
                // No index, not even a cached one: try again soon, not in an hour.
                None => inner.state.lock().unwrap().index_tried = Instant::now().checked_sub(INDEX_MAX_AGE - INDEX_RETRY),
            });
        }
        st.index.clone()
    }

    /// The tile if it is decoded, without asking for it (stand-ins).
    pub fn peek(&self, id: TileId) -> Option<iced::widget::image::Handle> {
        match self.inner.state.lock().unwrap().tiles.get(&id) {
            Some(Slot::Ready(h)) => Some(h.clone()),
            _ => None,
        }
    }

    /// The tile if it is decoded; otherwise asks for it (newest asks first).
    pub fn get(&self, id: TileId) -> Option<iced::widget::image::Handle> {
        let mut st = self.inner.state.lock().unwrap();
        match st.tiles.get(&id) {
            Some(Slot::Ready(h)) => {
                let h = h.clone();
                if let Some(i) = st.order.iter().position(|t| *t == id) {
                    st.order.remove(i);
                }
                st.order.push_back(id);
                return Some(h);
            }
            Some(Slot::Loading) => return None,
            Some(Slot::Failed(retry)) if Instant::now() < *retry => return None,
            _ => {}
        }
        if st.queued.insert(id) {
            st.queue.push_front(id);
            // Only what is on screen now matters: drop old asks.
            while st.queue.len() > 64 {
                if let Some(old) = st.queue.pop_back() {
                    st.queued.remove(&old);
                }
            }
            self.inner.work.notify_one();
        }
        None
    }

    /// Blocks until a tile (or the index) arrives after `seen`, or a while.
    pub fn wait_for_update(&self, seen: u64) -> u64 {
        let (lock, cvar) = &self.inner.updates;
        let n = lock.lock().unwrap();
        let (n, _) = cvar.wait_timeout_while(n, Duration::from_secs(30), |n| *n <= seen).unwrap();
        *n
    }
}

fn bump(inner: &Inner) {
    let (lock, cvar) = &inner.updates;
    *lock.lock().unwrap() += 1;
    cvar.notify_all();
}

/// SENTRY_STUDIO_TILES: one template for both styles (development).
fn dev_index() -> Option<Index> {
    let t = std::env::var("SENTRY_STUDIO_TILES").ok()?;
    let mut templates = HashMap::new();
    templates.insert(Style::Light, t.clone());
    templates.insert(Style::Dark, t);
    Some(Index { templates, max_zoom: 19, attribution: "development tiles".into() })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).build().into()
}

/// The body, or the HTTP status (0 when the request failed).
fn get(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, u16> {
    let mut resp = match agent.get(url).header("User-Agent", UA).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(code)) => return Err(code),
        Err(_) => return Err(0),
    };
    if !resp.status().is_success() {
        return Err(resp.status().as_u16());
    }
    resp.body_mut().with_config().limit(8 << 20).read_to_vec().map_err(|_| 0)
}

fn get_bytes(agent: &ureq::Agent, url: &str) -> Option<Vec<u8>> {
    get(agent, url).ok()
}

/// index.json from the server, or the cached copy when offline.
fn fetch_index(cache_dir: Option<&std::path::Path>) -> Option<Index> {
    if let Ok(local) = std::env::var("SENTRY_STUDIO_TILES_INDEX") {
        let bytes = get_bytes(&agent(), &local)?;
        let mut index = Index::parse(&serde_json::from_slice(&bytes).ok()?)?;
        let origin = local.split("/raster/").next().unwrap_or(&local).to_string();
        for t in index.templates.values_mut() {
            *t = t.replace("https://tiles.sentryusb.com", &origin);
        }
        return Some(index);
    }
    let cached = cache_dir.map(|d| d.join("index.json"));
    let parse = |bytes: &[u8]| serde_json::from_slice(bytes).ok().and_then(|v| Index::parse(&v));
    // The server's index, kept for offline use only once it parses.
    if let Some(bytes) = get_bytes(&agent(), INDEX_URL) {
        if let Some(index) = parse(&bytes) {
            if let Some(path) = &cached {
                let _ = std::fs::create_dir_all(path.parent().unwrap_or(path));
                let _ = std::fs::write(path, &bytes);
            }
            return Some(index);
        }
    }
    cached.and_then(|p| std::fs::read(p).ok()).and_then(|b| parse(&b))
}

/// The disk cache file for a tile URL (a hash of it, keeping revisions
/// apart). FNV-1a, which stays the same across Rust releases.
fn cache_path(dir: &std::path::Path, url: &str) -> PathBuf {
    let hash = url.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    let name = format!("{hash:016x}");
    dir.join(&name[..2]).join(name)
}

fn decode(bytes: &[u8]) -> Option<iced::widget::image::Handle> {
    let img = ::image::load_from_memory(bytes).ok()?.to_rgba8();
    Some(iced::widget::image::Handle::from_rgba(img.width(), img.height(), img.into_raw()))
}

fn fetcher(inner: Arc<Inner>) {
    let agent = agent();
    loop {
        let (id, url) = {
            let mut st = inner.state.lock().unwrap();
            loop {
                let next = if st.index.is_some() { st.queue.pop_front() } else { None };
                if let Some(id) = next {
                    st.queued.remove(&id);
                    let Some(url) = st.index.as_ref().and_then(|i| i.url(id)) else { continue };
                    st.tiles.insert(id, Slot::Loading);
                    break (id, url);
                }
                st = inner.work.wait(st).unwrap();
            }
        };
        let path = inner.cache_dir.as_deref().map(|d| cache_path(&d.join("tiles"), &url));
        let mut bytes = path.as_ref().and_then(|p| std::fs::read(p).ok());
        // A tile in use stays in the cache: pruning goes by modification time.
        if let (Some(_), Some(p)) = (&bytes, &path) {
            let _ = std::fs::File::options().write(true).open(p).and_then(|f| f.set_modified(SystemTime::now()));
        }
        // How soon to try again: soon when the server is busy (503) or
        // failed (5xx, offline), not for a while when there is no such tile.
        let mut retry = Duration::from_secs(30);
        if bytes.is_none() {
            match get(&agent, &url) {
                Ok(b) => bytes = Some(b),
                Err(404) => retry = Duration::from_secs(300),
                Err(code) if code >= 500 => retry = Duration::from_secs(3),
                Err(_) => {}
            }
            if let (Some(b), Some(p)) = (&bytes, &path) {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(p, b);
            }
        }
        let decoded = bytes.as_deref().and_then(decode);
        let mut st = inner.state.lock().unwrap();
        match decoded {
            Some(handle) => {
                st.tiles.insert(id, Slot::Ready(handle));
                st.order.push_back(id);
                while st.order.len() > MEMORY_TILES {
                    if let Some(old) = st.order.pop_front() {
                        st.tiles.remove(&old);
                    }
                }
            }
            None => {
                // Failures whose retry time has passed are forgotten, so the
                // table doesn't grow while offline.
                let now = Instant::now();
                st.tiles.retain(|_, slot| !matches!(slot, Slot::Failed(t) if *t <= now));
                st.tiles.insert(id, Slot::Failed(now + retry));
            }
        }
        drop(st);
        bump(&inner);
    }
}

/// Removes cached tiles not used for 30 days, then the oldest until the
/// cache is under DISK_CACHE_BYTES (run once at startup).
pub fn prune_disk_cache(dir: PathBuf) {
    std::thread::spawn(move || {
        let Ok(subdirs) = std::fs::read_dir(dir.join("tiles")) else { return };
        let cutoff = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        let mut kept: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        for sub in subdirs.flatten() {
            let Ok(files) = std::fs::read_dir(sub.path()) else { continue };
            for f in files.flatten() {
                let Ok(meta) = f.metadata() else { continue };
                let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                if modified < cutoff {
                    let _ = std::fs::remove_file(f.path());
                } else {
                    kept.push((modified, meta.len(), f.path()));
                }
            }
        }
        let mut total: u64 = kept.iter().map(|k| k.1).sum();
        kept.sort_by_key(|k| k.0);
        for (_, len, path) in kept {
            if total <= DISK_CACHE_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_and_urls() {
        let v = serde_json::json!({
            "tileSize": 512, "maxzoom": 19,
            "styles": {
                "colorful": { "tiles": "https://t/raster/colorful/r1/{z}/{x}/{y}@2x.webp" },
                "sentry-dark": { "tiles": "https://t/raster/sentry-dark/r1/{z}/{x}/{y}@2x.webp" }
            },
            "attribution": "© OpenStreetMap contributors"
        });
        let index = Index::parse(&v).unwrap();
        assert_eq!(index.max_zoom, 19);
        let id = TileId { style: Style::Dark, z: 14, x: 3000, y: 5000 };
        assert_eq!(index.url(id).as_deref(), Some("https://t/raster/sentry-dark/r1/14/3000/5000@2x.webp"));
        let dir = std::path::Path::new("/c");
        assert_ne!(cache_path(dir, "a"), cache_path(dir, "b"));
    }
}
