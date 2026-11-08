//! The GPS map: a floating 260 px panel with the drive or
//! clip's route (green where Autopilot / FSD drove, blue otherwise), start
//! and end dots, FSD disengagement (D) and accelerator push (A) markers,
//! and the car's arrow, which the map follows. Heading-up turns the whole
//! map under the arrow (labels included);
//! north-up turns the arrow instead.
//!
//! The map itself is raster tiles (tiles.rs) in Web Mercator, drawn on an
//! iced canvas. Right-drag pans, the wheel zooms; left-drag moves the panel.

pub mod tiles;

use crate::mp4;
use crate::telemetry::SeiMetadata;
use iced::mouse;
use iced::widget::canvas::{self, Frame, Path, Stroke, Text};
use iced::{Color, Point, Radians, Rectangle, Renderer, Size, Theme, Vector};
use tiles::{Style, TileId, Tiles};

/// Logical pixels per tile at an integer zoom (512 px "@2x" images).
const TILE: f32 = 256.0;
/// Heading-up mode needs the turned map scaled by 1.42 so its corners
/// stay covered; that is this much more zoom.
const HEADING_UP_ZOOM: f32 = 0.506;
pub const MIN_ZOOM: f32 = 3.0;
pub const MAX_ZOOM: f32 = 20.0;
pub const DEFAULT_ZOOM: f32 = 16.0;

/// Route colours (SentryUSB's): FSD engaged, and manual.
const ROUTE_AUTOPILOT: Color = Color { r: 0x22 as f32 / 255.0, g: 0xc5 as f32 / 255.0, b: 0x5e as f32 / 255.0, a: 1.0 };
const ROUTE_MANUAL: Color = Color { r: 0x3b as f32 / 255.0, g: 0x82 as f32 / 255.0, b: 0xf6 as f32 / 255.0, a: 1.0 };
const RED: Color = Color { r: 0xef as f32 / 255.0, g: 0x44 as f32 / 255.0, b: 0x44 as f32 / 255.0, a: 1.0 };
const AMBER: Color = Color { r: 0xf5 as f32 / 255.0, g: 0x9e as f32 / 255.0, b: 0x0b as f32 / 255.0, a: 1.0 };

/// Web Mercator: a position in "world" units, 0..1 across and down.
pub fn world(lat: f64, lon: f64) -> (f64, f64) {
    let lat = lat.clamp(-85.051_128, 85.051_128).to_radians();
    let x = (lon + 180.0) / 360.0;
    let y = (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0;
    (x, y)
}

/// A route point: latitude, longitude, and whether Autopilot / FSD drove.
pub type RoutePoint = (f32, f32, bool);

/// The route of one clip from its telemetry: only the first bytes of each
/// frame are read (Tesla's SEI comes first), every sixth frame.
pub fn clip_route(path: &std::path::Path) -> Vec<RoutePoint> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let Ok(track) = mp4::read_video_track(&file) else { return Vec::new() };
    let mut out = Vec::new();
    let mut buf = vec![0u8; 512];
    for (i, s) in track.samples.iter().enumerate() {
        if i % 6 != 0 && i + 1 != track.samples.len() {
            continue;
        }
        let n = (s.size as usize).min(buf.len());
        if mp4::read_at(&file, &mut buf[..n], s.offset).is_err() {
            continue;
        }
        let Some(sei) = crate::telemetry::sample_telemetry(&buf[..n], track.nal_length_size as usize, track.codec) else { continue };
        if crate::sei::has_valid_gps(&sei) {
            // Any Autopilot state, TACC included, colours the route, as in
            // earlier versions' maps (the dashboard counts only 1 and 2).
            out.push((sei.latitude_deg as f32, sei.longitude_deg as f32, sei.autopilot_state != 0));
        }
    }
    out
}

/// Everything the map draws this frame.
pub struct MapView<'a, M> {
    /// Where the map is centred (the car, unless panned).
    pub center: (f64, f64),
    pub zoom: f32,
    /// Degrees the map is turned (heading-up), 0 for north-up.
    pub bearing: f32,
    /// The car: position and heading, if there is GPS now.
    pub car: Option<(f64, f64, f32)>,
    pub route: &'a [RoutePoint],
    pub events: &'a [(f32, f32, bool)],
    pub arrow: &'a iced::widget::image::Handle,
    pub on_pan: fn(f32, f32) -> M,
    pub on_zoom: fn(f32) -> M,
}

/// The map's lower layer: background and tiles, clipped to the panel's
/// rounded corners. iced draws a canvas's shapes before its images, so the
/// route and markers (MapView) are a separate canvas stacked on top.
pub struct TileLayer<'a> {
    pub tiles: &'a Tiles,
    pub style: Style,
    pub center: (f64, f64),
    /// Zoom as drawn (heading-up's extra included) and the map's turn.
    pub zoom: f32,
    pub bearing: f32,
    /// Corner radius of the panel the map fills.
    pub radius: f32,
}

/// Right-button drag in progress (last cursor position).
#[derive(Default)]
pub struct Drag(Option<Point>);

impl<M> MapView<'_, M> {
    pub fn effective_zoom(&self) -> f32 {
        if self.bearing != 0.0 {
            self.zoom + HEADING_UP_ZOOM
        } else {
            self.zoom
        }
    }
}

impl<M: Clone> canvas::Program<M> for MapView<'_, M> {
    type State = Drag;

    fn update(&self, state: &mut Drag, event: &canvas::Event, bounds: Rectangle, cursor: mouse::Cursor) -> Option<canvas::Action<M>> {
        match event {
            canvas::Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Right)) => {
                let p = cursor.position_over(bounds)?;
                state.0 = Some(p);
                Some(canvas::Action::capture())
            }
            canvas::Event::Mouse(mouse::Event::CursorMoved { position }) => {
                let last = state.0?;
                state.0 = Some(*position);
                // Screen movement into the map's (possibly turned) frame.
                let (s, c) = (-self.bearing.to_radians()).sin_cos();
                let (dx, dy) = (position.x - last.x, position.y - last.y);
                Some(canvas::Action::publish((self.on_pan)(dx * c + dy * s, -dx * s + dy * c)).and_capture())
            }
            canvas::Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Right)) => {
                state.0.take()?;
                Some(canvas::Action::capture())
            }
            canvas::Event::Mouse(mouse::Event::WheelScrolled { delta }) if cursor.is_over(bounds) => {
                let steps = match delta {
                    mouse::ScrollDelta::Lines { y, .. } => *y * 0.5,
                    mouse::ScrollDelta::Pixels { y, .. } => *y / 120.0,
                };
                Some(canvas::Action::publish((self.on_zoom)(steps)).and_capture())
            }
            _ => None,
        }
    }

    fn draw(&self, _state: &Drag, renderer: &Renderer, _theme: &Theme, bounds: Rectangle, _cursor: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let zoom = self.effective_zoom();
        let world_px = TILE as f64 * 2f64.powf(zoom as f64);
        let (cx, cy) = world(self.center.0, self.center.1);
        let to_screen = |lat: f64, lon: f64| -> Point {
            let (x, y) = world(lat, lon);
            Point::new(((x - cx) * world_px) as f32, ((y - cy) * world_px) as f32)
        };

        frame.translate(Vector::new(bounds.width / 2.0, bounds.height / 2.0));
        frame.rotate(Radians(-self.bearing.to_radians()));

        // The route, split where Autopilot starts or stops.
        if self.route.len() > 1 {
            let mut start = 0;
            while start + 1 < self.route.len() {
                let ap = self.route[start].2;
                let mut end = start + 1;
                while end + 1 < self.route.len() && self.route[end].2 == ap {
                    end += 1;
                }
                // Zoomed out, many points fall on the same pixel, and zero-length
                // pieces make the stroke fail: keep only points that move on.
                let path = Path::new(|b| {
                    let first = &self.route[start];
                    let mut last = to_screen(first.0 as f64, first.1 as f64);
                    b.move_to(last);
                    let pieces = &self.route[start + 1..=end];
                    for (k, p) in pieces.iter().enumerate() {
                        let at = to_screen(p.0 as f64, p.1 as f64);
                        if at.distance(last) >= 0.75 || k + 1 == pieces.len() && at != last {
                            b.line_to(at);
                            last = at;
                        }
                    }
                });
                frame.stroke(
                    &path,
                    Stroke::default()
                        .with_width(4.0)
                        .with_color(if ap { ROUTE_AUTOPILOT } else { ROUTE_MANUAL })
                        .with_line_cap(canvas::LineCap::Round)
                        .with_line_join(canvas::LineJoin::Round),
                );
                start = end;
            }
        }

        // FSD markers: red D for a disengagement, amber A for an accelerator push.
        for &(lat, lon, disengage) in self.events {
            let p = to_screen(lat as f64, lon as f64);
            frame.fill(&Path::circle(p, 8.0), Color::WHITE);
            frame.fill(&Path::circle(p, 6.5), if disengage { RED } else { AMBER });
            frame.with_save(|f| {
                f.translate(Vector::new(p.x, p.y));
                f.rotate(Radians(self.bearing.to_radians()));
                f.fill_text(Text {
                    content: if disengage { "D".into() } else { "A".into() },
                    position: Point::ORIGIN,
                    color: Color::WHITE,
                    size: 9.0.into(),
                    font: crate::theme::bold(crate::theme::INTER),
                    align_x: iced::widget::text::Alignment::Center,
                    align_y: iced::alignment::Vertical::Center,
                    ..Text::default()
                });
            });
        }

        // Start (green) and end (red) dots.
        if let (Some(first), Some(last)) = (self.route.first(), self.route.last()) {
            for (p, color) in [(first, ROUTE_AUTOPILOT), (last, RED)] {
                let at = to_screen(p.0 as f64, p.1 as f64);
                frame.fill(&Path::circle(at, 7.0), Color::WHITE);
                frame.fill(&Path::circle(at, 5.0), color);
            }
        }

        // The car's arrow: sized for the zoom (28-120 px), pointing
        // along the heading (straight up in heading-up mode).
        if let Some((lat, lon, heading)) = self.car {
            let at = to_screen(lat, lon);
            let size = (28.0 + (self.zoom - 8.0) * 6.5).clamp(28.0, 120.0).round();
            let rect = Rectangle::new(Point::new(at.x - size / 2.0, at.y - size / 2.0), Size::new(size, size));
            frame.draw_image(rect, canvas::Image::new(self.arrow.clone()).rotation(Radians(heading.to_radians())));
        }
        vec![frame.into_geometry()]
    }

    fn mouse_interaction(&self, state: &Drag, _bounds: Rectangle, _cursor: mouse::Cursor) -> mouse::Interaction {
        if state.0.is_some() {
            mouse::Interaction::Grabbing
        } else {
            mouse::Interaction::default()
        }
    }
}

impl<M> canvas::Program<M> for TileLayer<'_> {
    type State = ();

    fn draw(&self, _state: &(), renderer: &Renderer, _theme: &Theme, bounds: Rectangle, _cursor: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let background = match self.style {
            Style::Light => Color::from_rgb8(248, 244, 240),
            Style::Dark => Color::from_rgb8(20, 28, 33),
        };
        frame.fill(&Path::rounded_rectangle(Point::ORIGIN, bounds.size(), self.radius.into()), background);
        let zoom = self.zoom;
        let (cx, cy) = world(self.center.0, self.center.1);
        frame.translate(Vector::new(bounds.width / 2.0, bounds.height / 2.0));
        // Heading-up turns the tiles: each one is placed and turned here
        // rather than by rotating the frame, because iced scales an image's
        // corner radius by the frame's matrix (cos of the angle), which
        // squared off the map's corners whenever the car wasn't facing north.
        let turn = -self.bearing.to_radians();
        let (sin_t, cos_t) = turn.sin_cos();
        // Tiles: the integer zoom below, scaled; enough to cover the
        // panel's circumscribed circle so turning never shows a gap.
        if let Some(index) = self.tiles.index() {
            let z = (zoom.floor() as u8).min(index.max_zoom);
            let n = 1u32 << z;
            let scale = 2f32.powf(zoom - z as f32);
            let size = TILE * scale;
            let radius = (bounds.width.hypot(bounds.height) / 2.0) / size + 1.0;
            let (tx, ty) = (cx * n as f64, cy * n as f64);
            let x0 = (tx - radius as f64).floor() as i64;
            let x1 = (tx + radius as f64).ceil() as i64;
            let y0 = ((ty - radius as f64).floor() as i64).max(0);
            let y1 = ((ty + radius as f64).ceil() as i64).min(n as i64 - 1);
            // Where a tile at (zoom, x, y) of this view goes on screen.
            let place = |zt: u8, x: f64, y: f64| -> Rectangle {
                let k = 2f64.powi(zt as i32 - z as i32);
                let s = (size as f64 / k) as f32 + 0.5;
                // The tile's centre, turned about the map's centre.
                let mx = ((x / k - tx) * size as f64) as f32 + s / 2.0;
                let my = ((y / k - ty) * size as f64) as f32 + s / 2.0;
                let (rx, ry) = (mx * cos_t - my * sin_t, mx * sin_t + my * cos_t);
                Rectangle::new(Point::new(rx - s / 2.0, ry - s / 2.0), Size::new(s, s))
            };
            let mut missing = Vec::new();
            let mut ready = Vec::new();
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let wrapped = x.rem_euclid(n as i64) as u32;
                    let id = TileId { style: self.style, z, x: wrapped, y: y as u32 };
                    match self.tiles.get(id) {
                        Some(handle) => ready.push((x, y, handle)),
                        None => missing.push((x, y)),
                    }
                }
            }
            // Until a tile arrives, what is already here stands in for it: the
            // wider tile above it (zooming in), or its four closer ones (zooming
            // out). Wider ones first, so closer ones and real tiles cover them.
            let mut parents = std::collections::HashSet::new();
            for &(x, y) in &missing {
                for up in 1..=4u8 {
                    let Some(zp) = z.checked_sub(up) else { break };
                    let (px, py) = (x.div_euclid(1 << up), y.div_euclid(1 << up));
                    let wrapped = px.rem_euclid(1i64 << zp) as u32;
                    if let Some(handle) = self.tiles.peek(TileId { style: self.style, z: zp, x: wrapped, y: py as u32 }) {
                        if parents.insert((zp, px, py)) {
                            frame.draw_image(place(zp, px as f64, py as f64), rounded(handle, self.radius, turn));
                        }
                        break;
                    }
                }
            }
            for &(x, y) in &missing {
                if z >= index.max_zoom {
                    continue;
                }
                for (cx, cy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let (kx, ky) = (x * 2 + cx, y * 2 + cy);
                    let wrapped = kx.rem_euclid(1i64 << (z + 1)) as u32;
                    if let Some(handle) = self.tiles.peek(TileId { style: self.style, z: z + 1, x: wrapped, y: ky as u32 }) {
                        frame.draw_image(place(z + 1, kx as f64, ky as f64), rounded(handle, self.radius, turn));
                    }
                }
            }
            for (x, y, handle) in ready {
                // A hair of overlap hides seams between tiles.
                frame.draw_image(place(z, x as f64, y as f64), rounded(handle, self.radius, turn));
            }
        }

        vec![frame.into_geometry()]
    }
}

/// A tile clipped to the map's rounded corners (iced rounds an image to its
/// canvas's bounds).
fn rounded(handle: iced::widget::image::Handle, radius: f32, turn: f32) -> canvas::Image {
    let mut image = canvas::Image::new(handle);
    image.border_radius = radius.into();
    image.rotation = Radians(turn);
    image
}

/// The car from this frame's telemetry, when its GPS is usable.
pub fn car(sei: &SeiMetadata) -> Option<(f64, f64, f32)> {
    (crate::sei::has_valid_gps(sei) && sei.latitude_deg.abs() >= 0.001 && sei.longitude_deg.abs() >= 0.001)
        .then(|| (sei.latitude_deg, sei.longitude_deg, (((sei.heading_deg % 360.0) + 360.0) % 360.0) as f32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercator_like_osm() {
        // Greenwich on the equator is the middle of the world.
        let (x, y) = world(0.0, 0.0);
        assert!((x - 0.5).abs() < 1e-12 && (y - 0.5).abs() < 1e-12);
        // 40°N 100°W at zoom 10 is in OSM tile x 227, y 387.
        let (x, y) = world(40.0, -100.0);
        assert_eq!(((x * 1024.0) as u32, (y * 1024.0) as u32), (227, 387));
    }
}
