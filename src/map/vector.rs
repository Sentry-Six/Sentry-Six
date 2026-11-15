//! Vector basemap for playback. Roads and land are composited separately from
//! the labels so the camera can follow the car without turning text upside down.

use super::tiles::{self, Style, Tiles};
use day_geometry::{Point, Rect, Size};
use day_piece_map::render::{self, Pass, RenderTile, Scene, TileData};
use day_piece_map::source::{self, SourceSpec, TileId};
use day_piece_map::{
    camera::{Camera, LngLat},
    mvt, style,
};
use iced::widget::canvas;
use iced::{mouse, Rectangle, Renderer, Theme};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

mod draw;

const ORIGIN: &str = "https://tiles.sentryusb.com/";
const MAIN_SOURCE: &str = "versatiles-shortbread";
const ATTRIBUTION: &str = "© OpenStreetMap contributors · © ESA WorldCover project 2021 · VersaTiles · GEBCO 2021 · OpenDEM · Mapzen Terrain Tiles, DEM Sources";
const STYLE_MAX_AGE: Duration = Duration::from_secs(86_400);
const TILE_MAX_AGE: Duration = Duration::from_secs(7 * 86_400);
const CACHE_LIMIT: usize = 72;
const REQUEST_LIMIT: usize = 64;
// Keep the cached basemap larger than the panel. Rotating it or following the
// car within this margin costs only a draw of the existing texture.
const CENTER_STEP: f64 = 64.0;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Request {
    Style(Style),
    Tile {
        theme: Style,
        url: String,
        id: TileId,
        optional: bool,
    },
}

#[derive(Clone)]
enum Asset {
    Style(Arc<style::Style>),
    Tile(Arc<TileData>),
}

enum Entry {
    Pending,
    Ready(Asset),
    Retry(Instant),
}

#[derive(Default)]
struct State {
    entries: HashMap<Request, Entry>,
    queue: VecDeque<Request>,
    recent: VecDeque<Request>,
}

struct Loader {
    state: Mutex<State>,
    work: Condvar,
}

pub struct VectorTiles {
    loader: Arc<Loader>,
    // Playback owns this canvas cache. Export continues to use its raster tiles.
    base: RefCell<Option<Basemap>>,
    enabled: bool,
}

#[derive(PartialEq)]
struct TilePlacement {
    source: String,
    id: TileId,
    rect: Rect,
    clip: Vec<Rect>,
}

#[derive(PartialEq)]
struct BaseKey {
    theme: Style,
    zoom: f64,
    center: Point,
    side: f64,
    tiles: Vec<TilePlacement>,
}

struct Basemap {
    key: BaseKey,
    image: iced::widget::image::Handle,
}

impl VectorTiles {
    pub fn new(cache: Option<PathBuf>, updates: Tiles) -> Self {
        let enabled = ["SENTRY_STUDIO_TILES", "SENTRY_STUDIO_TILES_INDEX"]
            .iter()
            .all(|variable| std::env::var_os(variable).is_none());
        let loader = Arc::new(Loader {
            state: Mutex::default(),
            work: Condvar::new(),
        });
        if enabled {
            for n in 0..4 {
                let loader = loader.clone();
                let cache = cache.clone();
                let updates = updates.clone();
                std::thread::Builder::new()
                    .name(format!("vector-tiles-{n}"))
                    .spawn(move || fetcher(&loader, cache.as_deref(), &updates))
                    .expect("start vector tile fetcher");
            }
        }
        Self {
            loader,
            base: RefCell::new(None),
            enabled,
        }
    }

    pub fn attribution(&self) -> Option<&'static str> {
        self.enabled.then_some(ATTRIBUTION)
    }

    fn asset(&self, request: Request, enqueue: bool) -> Option<Asset> {
        let mut state = self.loader.state.lock().unwrap();
        match state.entries.get(&request) {
            Some(Entry::Ready(asset)) => {
                let asset = asset.clone();
                state.recent.retain(|key| key != &request);
                state.recent.push_back(request);
                return Some(asset);
            }
            Some(Entry::Pending) => return None,
            Some(Entry::Retry(at)) if *at > Instant::now() => return None,
            _ if !enqueue => return None,
            _ => {}
        }
        state.entries.insert(request.clone(), Entry::Pending);
        // Drop the oldest queued requests if the map moves faster than downloads.
        state.queue.push_front(request);
        if state.queue.len() > REQUEST_LIMIT {
            if let Some(old) = state.queue.pop_back() {
                state.entries.remove(&old);
            }
        }
        self.loader.work.notify_one();
        None
    }

    fn scene_tiles(
        &self,
        theme: Style,
        style: &style::Style,
        camera: &Camera,
    ) -> (Vec<RenderTile>, bool) {
        let mut tiles = Vec::new();
        let mut basemap_ready = false;
        for (name, spec) in &style.sources {
            let SourceSpec::Vector {
                tiles: templates,
                minzoom,
                maxzoom,
                ..
            } = spec
            else {
                continue;
            };
            let Some(template) = templates.first().filter(|url| url.starts_with(ORIGIN)) else {
                continue;
            };
            let min = minzoom.unwrap_or(0).min(22);
            let max = maxzoom.unwrap_or(14).clamp(min, 22);
            let z = camera.tile_zoom(min, max);
            let needed = camera.covering_tiles(z);
            let tile_request = |id: TileId| Request::Tile {
                theme,
                url: template
                    .replace("{z}", &id.z.to_string())
                    .replace("{x}", &id.x.to_string())
                    .replace("{y}", &id.y.to_string()),
                id,
                optional: name != MAIN_SOURCE,
            };
            for &(id, _) in &needed {
                self.asset(tile_request(id), true);
            }
            let loaded = render::resolve(camera, name, &needed, &|id| {
                if id.z < min {
                    return None;
                }
                match self.asset(tile_request(id), false) {
                    Some(Asset::Tile(tile)) => Some(tile),
                    _ => None,
                }
            });
            if name == MAIN_SOURCE {
                let covered: usize = loaded.iter().map(|tile| tile.clip.len()).sum();
                basemap_ready = !needed.is_empty() && covered == needed.len();
            }
            tiles.extend(loaded);
        }
        (tiles, basemap_ready)
    }

    fn basemap(
        &self,
        theme: Style,
        style: &style::Style,
        camera: &Camera,
    ) -> Option<(iced::widget::image::Handle, Rectangle)> {
        let scale = camera.scale();
        let center = camera.center.to_world();
        let snap =
            |coordinate: f64| (coordinate * scale / CENTER_STEP).round() * CENTER_STEP / scale;
        let snapped = Point::new(
            snap(center.x),
            snap(center.y).clamp(0.0, day_piece_map::camera::WORLD),
        );
        let size = camera.size;
        let side = size.width.hypot(size.height).ceil() + CENTER_STEP * 2.0;
        let base_camera = Camera::new(
            LngLat::from_world(snapped),
            camera.zoom,
            Size::new(side, side),
        );
        let (tiles, _) = self.scene_tiles(theme, style, &base_camera);
        let key = BaseKey {
            theme,
            zoom: camera.zoom,
            center: snapped,
            side,
            tiles: tiles
                .iter()
                .map(|tile| TilePlacement {
                    source: tile.source.clone(),
                    id: tile.data.id,
                    rect: tile.rect,
                    clip: tile.clip.clone(),
                })
                .collect(),
        };
        let mut base = self.base.borrow_mut();
        if base.as_ref().is_none_or(|base| base.key != key) {
            let mut ops = day_pieces::Draw::new();
            render::render(&mut ops, &scene(style, &base_camera, &tiles, Pass::Base));
            let image = draw::basemap(ops.ops(), side)?;
            *base = Some(Basemap { key, image });
        }
        let center = camera.turn(camera.world_to_unturned(snapped));
        Some((
            base.as_ref()?.image.clone(),
            Rectangle {
                x: (center.x - side / 2.0) as f32,
                y: (center.y - side / 2.0) as f32,
                width: side as f32,
                height: side as f32,
            },
        ))
    }
}

fn fetcher(loader: &Loader, cache: Option<&Path>, updates: &Tiles) {
    // Style documents may only reference tiles on Sentry's map host.
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .max_redirects(0)
        .build()
        .into();
    loop {
        let request = {
            let mut state = loader.state.lock().unwrap();
            while state.queue.is_empty() {
                state = loader.work.wait(state).unwrap();
            }
            state.queue.pop_front().unwrap()
        };
        let asset = fetch(&agent, cache, &request);
        let mut state = loader.state.lock().unwrap();
        if let Some(asset) = asset {
            state.entries.insert(request.clone(), Entry::Ready(asset));
            state.recent.push_back(request);
            while state.recent.len() > CACHE_LIMIT {
                if let Some(old) = state.recent.pop_front() {
                    state.entries.remove(&old);
                }
            }
            drop(state);
            updates.notify_updated();
        } else {
            let now = Instant::now();
            state
                .entries
                .retain(|_, entry| !matches!(entry, Entry::Retry(at) if *at <= now));
            state
                .entries
                .insert(request, Entry::Retry(now + Duration::from_secs(30)));
        }
    }
}

fn fetch(agent: &ureq::Agent, cache: Option<&Path>, request: &Request) -> Option<Asset> {
    let url = match request {
        Request::Style(style) => format!("{ORIGIN}assets/styles/{}/style.json", style.key()),
        Request::Tile { url, .. } => url.clone(),
    };
    let parse = |bytes: Vec<u8>| match request {
        Request::Style(_) => style::Style::parse_str(std::str::from_utf8(&bytes).ok()?)
            .map(|style| Asset::Style(Arc::new(style)))
            .ok(),
        Request::Tile { id, .. } => mvt::decode(&source::gunzip_if_gzip(bytes).ok()?)
            .map(|tile| Asset::Tile(Arc::new(TileData::new(*id, tile))))
            .ok(),
    };
    let path = cache.map(|dir| tiles::cache_path(&dir.join("tiles"), &url));
    let cached = path.as_ref().and_then(|path| {
        let time = path.metadata().ok()?.modified().ok()?;
        let asset = parse(std::fs::read(path).ok()?)?;
        Some((asset, time))
    });
    // Vector tile URLs are unversioned. Refresh stale data when it is next
    // used and keep the previous copy available when offline.
    let max_age = match request {
        Request::Style(_) => STYLE_MAX_AGE,
        Request::Tile { .. } => TILE_MAX_AGE,
    };
    if let Some((asset, time)) = &cached {
        if time.elapsed().is_ok_and(|age| age < max_age) {
            return Some(asset.clone());
        }
    }
    match tiles::get(agent, &url) {
        Ok(bytes) => {
            let asset = parse(bytes.clone())?;
            if let Some(path) = path {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let temporary =
                    path.with_extension(format!("{:?}.tmp", std::thread::current().id()));
                if std::fs::write(&temporary, bytes)
                    .and_then(|()| std::fs::rename(&temporary, path))
                    .is_err()
                {
                    let _ = std::fs::remove_file(temporary);
                }
            }
            Some(asset)
        }
        Err(404) if matches!(request, Request::Tile { optional: true, .. }) => parse(Vec::new()),
        Err(_) => cached.map(|(asset, _)| asset),
    }
}

fn scene<'a>(
    style: &'a style::Style,
    camera: &'a Camera,
    tiles: &'a [RenderTile],
    pass: Pass,
) -> Scene<'a> {
    Scene {
        style,
        camera,
        tiles,
        sprite: None,
        measure: &render::approximate_measure,
        pass,
    }
}

/// A separate label canvas lets Iced draw rotated glyph paths above the
/// basemap image, including on its software renderer.
pub fn view<'a, M: 'a>(
    vector: &'a VectorTiles,
    raster: super::TileLayer<'a>,
    side: f32,
) -> iced::Element<'a, M> {
    let prepared = (|| {
        if !vector.enabled {
            return None;
        }
        let theme = raster.style;
        let Some(Asset::Style(style)) = vector.asset(Request::Style(theme), true) else {
            return None;
        };
        let (lat, lon) = raster.center;
        // The vector camera uses 512 px tiles, whereas playback uses 256 px
        // tiles. One zoom level keeps the route and tiles at the same scale.
        let camera = Camera::with_bearing(
            LngLat::new(lon, lat),
            f64::from(raster.zoom) - 1.0,
            -f64::from(raster.bearing),
            Size::new(side.into(), side.into()),
        );
        let (tiles, ready) = vector.scene_tiles(theme, &style, &camera);
        if !ready {
            return None;
        }
        let (image, rect) = vector.basemap(theme, &style, &camera)?;
        let image = super::rounded(image, raster.radius, camera.bearing_radians() as f32);
        Some((
            BaseLayer { image, rect },
            LabelLayer {
                style,
                camera,
                tiles,
                radius: raster.radius,
            },
        ))
    })();
    match prepared {
        Some((base, labels)) => iced::widget::stack![
            canvas::Canvas::new(base).width(side).height(side),
            canvas::Canvas::new(labels).width(side).height(side),
        ]
        .into(),
        None => canvas::Canvas::new(raster).width(side).height(side).into(),
    }
}

struct BaseLayer {
    image: canvas::Image,
    rect: Rectangle,
}

impl<M> canvas::Program<M> for BaseLayer {
    type State = ();

    fn draw(
        &self,
        _: &(),
        renderer: &Renderer,
        _: &Theme,
        bounds: Rectangle,
        _: mouse::Cursor,
    ) -> Vec<canvas::Geometry> {
        let mut frame = canvas::Frame::new(renderer, bounds.size());
        frame.draw_image(self.rect, self.image.clone());
        vec![frame.into_geometry()]
    }
}

struct LabelLayer {
    style: Arc<style::Style>,
    camera: Camera,
    tiles: Vec<RenderTile>,
    radius: f32,
}

impl<M> canvas::Program<M> for LabelLayer {
    type State = ();

    fn draw(
        &self,
        _: &(),
        renderer: &Renderer,
        _: &Theme,
        bounds: Rectangle,
        _: mouse::Cursor,
    ) -> Vec<canvas::Geometry> {
        let mut frame = canvas::Frame::new(renderer, bounds.size());
        let mut ops = day_pieces::Draw::new();
        render::render(
            &mut ops,
            &scene(&self.style, &self.camera, &self.tiles, Pass::Symbols),
        );
        draw::labels(&mut frame, ops.ops(), bounds.size(), self.radius);
        vec![frame.into_geometry()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use day_geometry::Affine;
    use day_piece_map::{Feature, GeometryType, Value};
    use day_spec::DrawOp;

    #[test]
    fn a_southbound_turn_moves_the_road_label_and_keeps_its_text_upright() {
        let style = style::Style::parse(&serde_json::json!({
            "version": 8,
            "sources": {
                (MAIN_SOURCE): {"type": "vector", "maxzoom": 0, "tiles": [format!("{ORIGIN}test/{{z}}/{{x}}/{{y}}")]}
            },
            "layers": [
                {"id": "background", "type": "background", "paint": {"background-color": "#ffffff"}},
                {
                    "id": "street-names", "type": "symbol",
                    "source": MAIN_SOURCE, "source-layer": "streets",
                    "layout": {"symbol-placement": "line", "text-field": ["get", "name"]}
                }
            ]
        }))
        .unwrap();
        let id = TileId::new(0, 0, 0);
        let data = Arc::new(TileData::new(
            id,
            mvt::Tile {
                layers: vec![mvt::Layer {
                    name: "streets".into(),
                    version: 2,
                    extent: 512,
                    features: vec![Feature {
                        id: None,
                        kind: GeometryType::LineString,
                        properties: [("name".into(), Value::String("Liberty Street".into()))]
                            .into(),
                        geometry: vec![vec![Point::new(110.0, 285.0), Point::new(402.0, 285.0)]],
                    }],
                }],
            },
        ));

        let label = |bearing| {
            let camera =
                Camera::with_bearing(LngLat::new(0.0, 0.0), 0.0, bearing, Size::new(258.0, 258.0));
            let tiles = render::resolve(&camera, MAIN_SOURCE, &[(id, 0)], &|_| Some(data.clone()));
            let mut ops = day_pieces::Draw::new();
            render::render(&mut ops, &scene(&style, &camera, &tiles, Pass::Symbols));
            let mut transform = Affine::IDENTITY;
            for op in ops.ops() {
                match op {
                    DrawOp::Concat(next) => transform = *next,
                    DrawOp::Text { text, at, .. } if text == "Liberty Street" => {
                        return (transform, transform.apply(*at))
                    }
                    _ => {}
                }
            }
            panic!("missing road label at a bearing of {bearing}");
        };
        let (north, north_pos) = label(0.0);
        let (south, south_pos) = label(180.0);
        assert!(north.a > 0.99 && south.a > 0.99);
        assert!(north_pos.y > 129.0 && south_pos.y < 129.0);
        assert!((north_pos.y + south_pos.y - 258.0).abs() < 0.001);

        // Exercise the whole canvas stack at a slanted angle. Iced represents
        // rotated text as paths, so it must be on a layer above the base image.
        let vector = VectorTiles {
            loader: Arc::new(Loader {
                state: Mutex::default(),
                work: Condvar::new(),
            }),
            base: RefCell::new(None),
            enabled: true,
        };
        let theme = Style::Light;
        {
            let mut state = vector.loader.state.lock().unwrap();
            state.entries.insert(
                Request::Style(theme),
                Entry::Ready(Asset::Style(Arc::new(style))),
            );
            state.entries.insert(
                Request::Tile {
                    theme,
                    url: format!("{ORIGIN}test/0/0/0"),
                    id,
                    optional: false,
                },
                Entry::Ready(Asset::Tile(data)),
            );
        }
        let raster_tiles = Tiles::new(None);
        let raster = super::super::TileLayer {
            tiles: &raster_tiles,
            style: theme,
            zoom: 1.0,
            center: (0.0, 0.0),
            bearing: 205.0,
            radius: 0.0,
        };
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        let image = painter.paint::<()>(
            super::view(&vector, raster, 258.0),
            iced::Size::new(258, 258),
        );
        assert!(vector.base.borrow().is_some());
        assert!(
            image
                .rgba
                .chunks_exact(4)
                .filter(|px| px[0] < 96 && px[3] > 224)
                .count()
                > 30
        );
    }
}
