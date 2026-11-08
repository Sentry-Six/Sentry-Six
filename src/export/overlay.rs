//! Overlays for exports (timestamp, dashboard, map): the app's own widgets
//! drawn offscreen by iced's software renderer into an RGBA picture, which
//! the compositor lays over the cameras. Drawn only when what they show
//! changes.

use iced::advanced::renderer::Headless;
use iced::{Color, Element, Font, Pixels, Size, Theme};

/// Draws widgets into pictures.
pub struct Painter {
    renderer: iced::Renderer,
}

/// A drawn overlay: premultiplied RGBA, `width` x `height`.
#[derive(Debug, Clone)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Painter {
    pub fn new() -> Option<Self> {
        // The app's fonts (the window loads them too; a command-line export
        // has no window).
        static FONTS: std::sync::Once = std::sync::Once::new();
        FONTS.call_once(|| {
            if let Ok(mut fonts) = iced::advanced::graphics::text::font_system().write() {
                for bytes in crate::theme::FONT_FILES {
                    fonts.load_font(std::borrow::Cow::Borrowed(bytes));
                }
            }
        });
        let renderer = iced::futures::executor::block_on(<iced::Renderer as Headless>::new(Font::with_name("Inter"), Pixels(14.0), Some("tiny-skia")))?;
        Some(Painter { renderer })
    }

    /// Draws `element` at `size` (pixels) on a transparent background.
    pub fn paint<M>(&mut self, element: Element<'_, M>, size: Size<u32>) -> Picture {
        self.paint_scaled(element, size, 1.0)
    }

    /// Draws `element` laid out at `size / scale` and magnified by `scale`
    /// (so a widget designed at one size fills a bigger picture sharply).
    /// Only magnifies: below 1, iced's software renderer clips the picture
    /// short, so smaller scales draw at 1.
    pub fn paint_scaled<M>(&mut self, element: Element<'_, M>, size: Size<u32>, scale: f32) -> Picture {
        let scale = scale.max(1.0);
        let bounds = Size::new(size.width as f32 / scale, size.height as f32 / scale);
        let mut ui = iced_runtime::UserInterface::build(element, bounds, iced_runtime::user_interface::Cache::default(), &mut self.renderer);
        let theme = Theme::Dark;
        ui.draw(&mut self.renderer, &theme, &iced::advanced::renderer::Style { text_color: Color::WHITE }, iced::mouse::Cursor::Unavailable);
        let rgba = self.renderer.screenshot(size, scale, Color::TRANSPARENT);
        Picture { width: size.width, height: size.height, rgba }
    }
}

#[cfg(test)]
impl Painter {
    /// Lays `element` out at `size` and feeds it `events` (with the
    /// pointer where the last mouse move put it), returning the messages
    /// it published: for testing what a view does with clicks and drags.
    pub fn interact<M>(&mut self, element: Element<'_, M>, size: Size<f32>, events: &[iced::Event]) -> Vec<M> {
        let mut ui = iced_runtime::UserInterface::build(element, size, iced_runtime::user_interface::Cache::default(), &mut self.renderer);
        let mut messages = Vec::new();
        let mut cursor = iced::mouse::Cursor::Unavailable;
        let mut clipboard = iced::advanced::clipboard::Null;
        for event in events {
            if let iced::Event::Mouse(iced::mouse::Event::CursorMoved { position }) = event {
                cursor = iced::mouse::Cursor::Available(*position);
            }
            let _ = ui.update(std::slice::from_ref(event), cursor, &mut self.renderer, &mut clipboard, &mut messages);
        }
        messages
    }

    /// As the app runs a view: built, given one event, its messages handed
    /// to `update`, then built again from `view` (keeping widget state in
    /// the cache), for each event.
    pub fn run<S, M>(&mut self, state: &mut S, view: impl Fn(&S) -> Element<'_, M>, update: impl Fn(&mut S, M), size: Size<f32>, events: &[iced::Event]) -> usize {
        let mut cache = iced_runtime::user_interface::Cache::default();
        let mut cursor = iced::mouse::Cursor::Unavailable;
        let mut clipboard = iced::advanced::clipboard::Null;
        let mut count = 0;
        for event in events {
            if let iced::Event::Mouse(iced::mouse::Event::CursorMoved { position }) = event {
                cursor = iced::mouse::Cursor::Available(*position);
            }
            let mut messages = Vec::new();
            {
                let mut ui = iced_runtime::UserInterface::build(view(state), size, cache, &mut self.renderer);
                let _ = ui.update(std::slice::from_ref(event), cursor, &mut self.renderer, &mut clipboard, &mut messages);
                cache = ui.into_cache();
            }
            count += messages.len();
            for m in messages {
                update(state, m);
            }
        }
        count
    }
}

/// Cuts a picture's corners round (`radius` pixels), smoothly; its
/// colours are premultiplied, so all four channels fade.
pub fn round_corners(picture: &mut Picture, radius: f32) {
    let (w, h) = (picture.width as usize, picture.height as usize);
    let r = radius.min(w as f32 / 2.0).min(h as f32 / 2.0);
    if r <= 0.0 {
        return;
    }
    let reach = r.ceil() as usize + 1;
    for y in (0..reach.min(h)).chain(h.saturating_sub(reach).max(reach)..h) {
        for x in (0..reach.min(w)).chain(w.saturating_sub(reach).max(reach)..w) {
            // Distance outside the rounded rectangle, at the pixel's centre.
            let qx = (x as f32 + 0.5 - w as f32 / 2.0).abs() - (w as f32 / 2.0 - r);
            let qy = (y as f32 + 0.5 - h as f32 / 2.0).abs() - (h as f32 / 2.0 - r);
            if qx <= 0.0 || qy <= 0.0 {
                continue;
            }
            let d = (qx * qx + qy * qy).sqrt() - r;
            let cover = (0.5 - d).clamp(0.0, 1.0);
            if cover < 1.0 {
                let i = (y * w + x) * 4;
                for c in &mut picture.rgba[i..i + 4] {
                    *c = (*c as f32 * cover).round() as u8;
                }
            }
        }
    }
}

/// Where an overlay sits: Electron's six places, 20 px from the edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    BottomCenter,
    BottomLeft,
    BottomRight,
    TopCenter,
    TopLeft,
    TopRight,
}

impl Corner {
    pub const ALL: [Corner; 6] = [Corner::BottomCenter, Corner::BottomLeft, Corner::BottomRight, Corner::TopCenter, Corner::TopLeft, Corner::TopRight];
    const PAD: f32 = 20.0;

    pub fn label_key(self) -> &'static str {
        match self {
            Corner::BottomCenter => "ui.export.bottomCenter",
            Corner::BottomLeft => "ui.export.bottomLeft",
            Corner::BottomRight => "ui.export.bottomRight",
            Corner::TopCenter => "ui.export.topCenter",
            Corner::TopLeft => "ui.export.topLeft",
            Corner::TopRight => "ui.export.topRight",
        }
    }

    fn horizontal(self) -> iced::alignment::Horizontal {
        use iced::alignment::Horizontal::*;
        match self {
            Corner::BottomLeft | Corner::TopLeft => Left,
            Corner::BottomRight | Corner::TopRight => Right,
            _ => Center,
        }
    }

    /// Top-left of a `w` x `h` picture in a `frame_w` x `frame_h` frame.
    pub fn place(self, w: u32, h: u32, frame_w: u32, frame_h: u32) -> (f32, f32) {
        use iced::alignment::Horizontal::*;
        let (w, h, fw, fh) = (w as f32, h as f32, frame_w as f32, frame_h as f32);
        let x = match self.horizontal() {
            Left => Self::PAD,
            Right => fw - w - Self::PAD,
            Center => (fw - w) / 2.0,
        };
        let y = match self {
            Corner::TopCenter | Corner::TopLeft | Corner::TopRight => Self::PAD,
            _ => fh - h - Self::PAD,
        };
        (x.max(0.0), y.max(0.0))
    }
}

/// The burned-in recording time, as Electron's: 36 px white type on a
/// 40% black box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamp {
    pub corner: Corner,
    pub date_format: crate::settings::DateFormat,
    pub h24: bool,
}

impl Timestamp {
    pub const SIZE: f32 = 36.0;

    /// "2026-11-07 01:05:09 PM" (the date in the chosen order).
    pub fn text(&self, t: crate::library::LocalSecs) -> String {
        let s = crate::library::format_local(t);
        let date = self.date_format.show(&s[..10]);
        let (h, rest) = (s[11..13].parse::<u32>().unwrap_or(0), &s[13..19]);
        if self.h24 {
            format!("{date} {h:02}{rest}")
        } else {
            format!("{date} {:02}{rest} {}", if h % 12 == 0 { 12 } else { h % 12 }, if h >= 12 { "PM" } else { "AM" })
        }
    }

    /// The picture's size: wide enough for the text in any of the formats.
    pub fn size(&self, frame_w: u32) -> Size<u32> {
        Size::new(760.min(frame_w.saturating_sub(2 * Corner::PAD as u32)).max(1), (Self::SIZE * 1.6) as u32)
    }

    pub fn paint(&self, painter: &mut Painter, t: crate::library::LocalSecs, frame_w: u32) -> Picture {
        use iced::widget::{container, text};
        let size = self.size(frame_w);
        let label = container(text(self.text(t)).size(Self::SIZE).font(crate::theme::INTER).color(Color::WHITE))
            .padding(5)
            .style(|_| container::Style { background: Some(Color::from_rgba(0.0, 0.0, 0.0, 0.4).into()), ..Default::default() });
        let element = container(label).width(iced::Length::Fill).height(iced::Length::Fill).align_x(self.corner.horizontal()).center_y(iced::Length::Fill);
        painter.paint::<()>(element.into(), size)
    }
}

/// The dashboard's width as a share of 1920 px (Electron's Size).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashSize {
    Small,
    Medium,
    Large,
    XLarge,
}

impl DashSize {
    pub const ALL: [DashSize; 4] = [DashSize::Small, DashSize::Medium, DashSize::Large, DashSize::XLarge];

    pub fn share(self) -> f64 {
        match self {
            DashSize::Small => 0.25,
            DashSize::Medium => 0.35,
            DashSize::Large => 0.45,
            DashSize::XLarge => 0.55,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            DashSize::Small => "small",
            DashSize::Medium => "medium",
            DashSize::Large => "large",
            DashSize::XLarge => "xlarge",
        }
    }

    pub fn from_key(k: &str) -> Option<Self> {
        DashSize::ALL.into_iter().find(|s| s.key() == k)
    }

    pub fn label_key(self) -> &'static str {
        match self {
            DashSize::Small => "ui.export.sizeSmall",
            DashSize::Medium => "ui.export.sizeMedium",
            DashSize::Large => "ui.export.sizeLarge",
            DashSize::XLarge => "ui.export.sizeXLarge",
        }
    }
}

impl Corner {
    pub fn key(self) -> &'static str {
        match self {
            Corner::BottomCenter => "bottom-center",
            Corner::BottomLeft => "bottom-left",
            Corner::BottomRight => "bottom-right",
            Corner::TopCenter => "top-center",
            Corner::TopLeft => "top-left",
            Corner::TopRight => "top-right",
        }
    }

    pub fn from_key(k: &str) -> Option<Self> {
        Corner::ALL.into_iter().find(|c| c.key() == k)
    }
}

/// The burned-in dashboard: playback's compact dashboard, sized and placed
/// as Electron placed it (40 px from the edges). With `glass`, it's
/// playback's frosted glass (the video under it blurred and saturated,
/// the same tint and edge); without, Electron's dark export bar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dashboard {
    pub style: DashStyle,
    /// Tesla Mobile: a top corner puts the data bar on top.
    pub corner: Corner,
    pub size: DashSize,
    pub metric: bool,
    pub h24: bool,
    pub accel: crate::dashboard::AccelMode,
    /// Playback's glass blur in its pixels (the Glass Blur setting); 0 for
    /// Electron's dark bar.
    pub glass: f32,
    /// Dragged somewhere of its own: its top-left corner as a share of the
    /// frame's width and height, instead of `corner`.
    pub free: Option<(f32, f32)>,
}

/// An overlay dragged to `free` (shares of the frame), kept inside it.
pub fn free_place(free: (f32, f32), w: u32, h: u32, frame_w: u32, frame_h: u32) -> (f32, f32) {
    let x = (free.0 * frame_w as f32).clamp(0.0, frame_w.saturating_sub(w) as f32);
    let y = (free.1 * frame_h as f32).clamp(0.0, frame_h.saturating_sub(h) as f32);
    (x.round(), y.round())
}

/// The dashboard's look (Electron's Style).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashStyle {
    /// Playback's compact dashboard on a dark bar.
    Compact,
    /// Full-width bars added above and below the cameras.
    TeslaMobile,
}

impl DashStyle {
    pub const ALL: [DashStyle; 2] = [DashStyle::Compact, DashStyle::TeslaMobile];

    pub fn key(self) -> &'static str {
        match self {
            DashStyle::Compact => "compact",
            DashStyle::TeslaMobile => "tesla-mobile",
        }
    }

    pub fn from_key(k: &str) -> Option<Self> {
        DashStyle::ALL.into_iter().find(|s| s.key() == k)
    }

    pub fn label_key(self) -> &'static str {
        match self {
            DashStyle::Compact => "ui.export.compact",
            DashStyle::TeslaMobile => "ui.export.teslaMobile",
        }
    }
}

impl Dashboard {
    /// Tesla Mobile's data bar is on top.
    pub fn bar_on_top(&self) -> bool {
        matches!(self.corner, Corner::TopCenter | Corner::TopLeft | Corner::TopRight)
    }
}

/// What the dashboard shows in one frame.
#[derive(Debug, Clone, Default)]
pub struct DashState {
    pub telemetry: Option<crate::sei::SeiMetadata>,
    pub time: String,
    pub steering: f32,
    pub blink_ms: u128,
}

impl DashState {
    /// What can be seen change (Electron's state signature): the
    /// dashboard is drawn again only when this does.
    pub fn signature(&self, metric: bool) -> String {
        match &self.telemetry {
            None => format!("parked {}", self.time),
            Some(m) => {
                let speed = if metric { m.vehicle_speed_mps.abs() * 3.6 } else { m.vehicle_speed_mps.abs() * 2.236_936 }.round();
                let accel = if m.accelerator_pedal_position > 1.0 { m.accelerator_pedal_position } else { m.accelerator_pedal_position * 100.0 };
                let blink = self.blink_ms < 400;
                format!(
                    "{speed} {} {} {} {} {} {} {} {}",
                    m.gear_state,
                    m.blinker_on_left && blink,
                    m.blinker_on_right && blink,
                    m.autopilot_state,
                    m.brake_applied,
                    (accel / 5.0).round(),
                    self.steering.round(),
                    self.time
                )
            }
        }
    }
}

impl Dashboard {
    /// The layout the compact dashboard is designed at (its playback size).
    const DESIGN_WIDTH: f32 = 650.0;
    /// theme::dashboard_glass's corner radius.
    const GLASS_RADIUS: f32 = 24.0;
    const MARGIN: f32 = 40.0;

    /// Electron's size: 1920 x share x 1.15 wide (at most the frame less
    /// 80 px), 8.57 times as wide as high.
    pub fn size(&self, frame_w: u32) -> Size<u32> {
        let w = ((1920.0 * self.size.share() * 1.15).round() as u32).min(frame_w.saturating_sub(80)).max(80);
        Size::new(w, ((w as f64 / 8.57).round() as u32).max(20))
    }

    pub fn place(&self, w: u32, h: u32, frame_w: u32, frame_h: u32) -> (f32, f32) {
        if let Some(free) = self.free {
            return free_place(free, w, h, frame_w, frame_h);
        }
        let (x, y) = self.corner.place(w, h, frame_w, frame_h);
        // 40 px from the edges instead of the timestamp's 20.
        let dx = match self.corner.horizontal() {
            iced::alignment::Horizontal::Left => Self::MARGIN - 20.0,
            iced::alignment::Horizontal::Right => 20.0 - Self::MARGIN,
            _ => 0.0,
        };
        let dy = match self.corner {
            Corner::TopCenter | Corner::TopLeft | Corner::TopRight => Self::MARGIN - 20.0,
            _ => 20.0 - Self::MARGIN,
        };
        ((x + dx).max(0.0), (y + dy).max(0.0))
    }

    pub fn paint(&self, painter: &mut Painter, state: &DashState, frame_w: u32) -> Picture {
        use iced::widget::container;
        let size = self.size(frame_w);
        // Magnified from the design size; a smaller one shrinks inside
        // instead, as on a small playback tile.
        let ratio = size.width as f32 / Self::DESIGN_WIDTH;
        let (scale, inner) = if ratio >= 1.0 { (ratio, 1.0) } else { (1.0, ratio) };
        let height = size.height as f32 / scale;
        let dash = crate::dashboard::compact::<()>(crate::dashboard::Dash {
            telemetry: state.telemetry.as_ref(),
            time: state.time.clone(),
            metric: self.metric,
            playing: true,
            blink_ms: state.blink_ms,
            // The compact dashboard's own scale (1.0 at 650 px wide).
            scale: inner,
            accel: self.accel,
            steering: state.steering,
        });
        let glass = self.glass > 0.0;
        let bar = container(dash).width(iced::Length::Fill).height(iced::Length::Fill).padding([0.0, 6.0]).style(move |theme| {
            if glass {
                // Playback's glass, without its drop shadow (it would be
                // cut off at the picture's edge).
                container::Style { shadow: iced::Shadow::default(), ..crate::theme::dashboard_glass(theme) }
            } else {
                container::Style {
                    background: Some(Color::from_rgba8(0x28, 0x28, 0x30, 0.75).into()),
                    border: iced::Border { color: Color::from_rgb8(0x40, 0x40, 0x40), width: 1.0, radius: (height * 0.35).into() },
                    ..Default::default()
                }
            }
        });
        painter.paint_scaled::<()>(bar.into(), size, scale)
    }

    /// The glass under the dashboard, in the frame's pixels: its rounded
    /// rectangle (x, y, width, height, corner radius) and blur deviation.
    /// None without glass or for Tesla Mobile's bars.
    pub fn frost(&self, frame_w: u32, frame_h: u32) -> Option<([f32; 5], f32)> {
        if self.glass <= 0.0 || self.style != DashStyle::Compact {
            return None;
        }
        let size = self.size(frame_w);
        let (x, y) = self.place(size.width, size.height, frame_w, frame_h);
        // The design is magnified to this size (or shrinks inside it).
        let scale = (size.width as f32 / Self::DESIGN_WIDTH).max(1.0);
        let radius = (Self::GLASS_RADIUS * scale).min(size.height as f32 / 2.0);
        Some(([x, y, size.width as f32, size.height as f32, radius], self.glass * size.width as f32 / Self::DESIGN_WIDTH))
    }
}

/// The map tiles for a minimap (the app's tile cache, shared).
#[derive(Clone)]
pub struct MapTiles(pub crate::map::tiles::Tiles);

impl std::fmt::Debug for MapTiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MapTiles")
    }
}

/// The GPS minimap, as Electron's "Static Map": the range's route on the
/// map, fitted with 15% to spare, and the car's arrow moving along it.
/// Square, a share of the frame's shorter side, in a corner 20 px in.
#[derive(Debug, Clone)]
pub struct Minimap {
    pub corner: Corner,
    pub size: DashSize,
    pub dark: bool,
    pub tiles: MapTiles,
    /// Electron's "Live Map": the map follows the car, as the playback
    /// map does, instead of showing the whole route.
    pub live: bool,
    /// Dragged somewhere of its own (see Dashboard::free).
    pub free: Option<(f32, f32)>,
}

/// Where a minimap's map is: its centre (world units) and zoom.
#[derive(Debug, Clone, Copy)]
pub struct MapFit {
    pub center: (f64, f64),
    pub zoom: f32,
    pub side: u32,
}

impl MapFit {
    /// A position on the map, in the minimap's pixels.
    pub fn pixel_of(&self, lat: f64, lon: f64) -> (f32, f32) {
        let (x, y) = crate::map::world(lat, lon);
        let world_px = 256.0 * 2f64.powf(self.zoom as f64);
        let half = self.side as f64 / 2.0;
        ((half + (x - self.center.0) * world_px) as f32, (half + (y - self.center.1) * world_px) as f32)
    }

    fn center_lat_lon(&self) -> (f64, f64) {
        let lon = self.center.0 * 360.0 - 180.0;
        let lat = (std::f64::consts::PI * (1.0 - 2.0 * self.center.1)).sinh().atan().to_degrees();
        (lat, lon)
    }
}

impl Minimap {
    /// Where the map goes in a frame (its side from `side`).
    pub fn place(&self, side: u32, frame_w: u32, frame_h: u32) -> (f32, f32) {
        match self.free {
            Some(free) => free_place(free, side, side, frame_w, frame_h),
            None => self.corner.place(side, side, frame_w, frame_h),
        }
    }

    /// The square's side: the share of the shorter side, even.
    pub fn side(&self, frame_w: u32, frame_h: u32) -> u32 {
        ((self.size.share() * frame_w.min(frame_h) as f64) as u32 & !1).max(64)
    }

    fn style(&self) -> crate::map::tiles::Style {
        if self.dark {
            crate::map::tiles::Style::Dark
        } else {
            crate::map::tiles::Style::Light
        }
    }

    /// The route's box with 15% to spare, as large as fits.
    pub fn fit(&self, route: &[crate::map::RoutePoint], side: u32) -> Option<MapFit> {
        let pts: Vec<(f64, f64)> = route.iter().map(|p| crate::map::world(p.0 as f64, p.1 as f64)).collect();
        let (x0, x1) = pts.iter().fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
        let (y0, y1) = pts.iter().fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p.1), b.max(p.1)));
        if pts.is_empty() {
            return None;
        }
        let span = (x1 - x0).max(y1 - y0).max(1e-9) * 1.15;
        let zoom = ((side as f64 / (256.0 * span)).log2() as f32).clamp(crate::map::MIN_ZOOM, 17.0);
        Some(MapFit { center: ((x0 + x1) / 2.0, (y0 + y1) / 2.0), zoom, side })
    }

    /// The live map following the car: playback's 260 px map at zoom 16,
    /// magnified to `side` (or zoomed out a little when smaller).
    pub fn follow(&self, lat: f64, lon: f64, side: u32) -> (MapFit, f32) {
        let center = crate::map::world(lat, lon);
        if side >= 260 {
            (MapFit { center, zoom: crate::map::DEFAULT_ZOOM, side: 260 }, side as f32 / 260.0)
        } else {
            (MapFit { center, zoom: crate::map::DEFAULT_ZOOM + (side as f32 / 260.0).log2(), side }, 1.0)
        }
    }

    /// Whether every tile the map needs is here (asking for those that
    /// aren't); None until the tile index has arrived.
    pub fn tiles_ready(&self, fit: &MapFit) -> Option<bool> {
        let tiles = &self.tiles.0;
        tiles.index().map(|index| {
                let z = (fit.zoom.floor() as u8).min(index.max_zoom);
                let n = 1i64 << z;
                let tile_px = 256.0 * 2f64.powf((fit.zoom - z as f32) as f64);
                let radius = fit.side as f64 / 2.0 / tile_px + 1.0;
                let (tx, ty) = (fit.center.0 * n as f64, fit.center.1 * n as f64);
                let mut all = true;
                for y in ((ty - radius).floor() as i64).max(0)..=((ty + radius).ceil() as i64).min(n - 1) {
                    for x in (tx - radius).floor() as i64..=(tx + radius).ceil() as i64 {
                        let id = crate::map::tiles::TileId { style: self.style(), z, x: x.rem_euclid(n) as u32, y: y as u32 };
                        all &= tiles.get(id).is_some();
                    }
                }
                all
            })
    }

    /// Asks for the tiles the map needs and waits for them (at most
    /// `wait`); missing ones are left out.
    pub fn fetch_tiles(&self, fit: &MapFit, wait: std::time::Duration) {
        let deadline = std::time::Instant::now() + wait;
        loop {
            let ready = self.tiles_ready(fit);
            if ready == Some(true) || std::time::Instant::now() >= deadline {
                if ready != Some(true) {
                    log::warn!("export: some map tiles didn't arrive in time; the minimap shows what there is");
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    /// The map with the route and its start and end dots (no arrow).
    pub fn paint_map(&self, painter: &mut Painter, route: &[crate::map::RoutePoint], fit: &MapFit) -> Picture {
        self.paint_map_with(painter, route, fit, None, fit.side)
    }

    /// The map laid out at `fit.side` with the car's arrow on it (if
    /// given), drawn `pixels` wide.
    pub fn paint_map_with(&self, painter: &mut Painter, route: &[crate::map::RoutePoint], fit: &MapFit, car: Option<(f64, f64, f32)>, pixels: u32) -> Picture {
        use iced::widget::{canvas, container, stack, text};
        static ARROW: std::sync::OnceLock<iced::widget::image::Handle> = std::sync::OnceLock::new();
        let arrow = ARROW.get_or_init(|| iced::widget::image::Handle::from_bytes(include_bytes!("../../assets/dashboard/arrow.png").as_slice())).clone();
        let side = fit.side as f32;
        let center = fit.center_lat_lon();
        // Playback's rounded corners (24 px on its 260 px map). The software
        // renderer can't clip tiles to them, so the corners are cut from
        // the finished picture (below); the tiles are drawn square.
        let radius = 0.0;
        let corner = side * 24.0 / 260.0;
        let tiles = crate::map::TileLayer { tiles: &self.tiles.0, style: self.style(), center, zoom: fit.zoom, bearing: 0.0, radius };
        let view = crate::map::MapView::<()> { center, zoom: fit.zoom, bearing: 0.0, car, route, events: &[], arrow: &arrow, on_pan: |_, _| (), on_zoom: |_| () };
        let mut layers = stack![canvas(tiles).width(side).height(side), canvas(view).width(side).height(side)];
        let attribution = self.tiles.0.index().map(|i| i.attribution).unwrap_or_default();
        if !attribution.is_empty() {
            let size = if pixels > fit.side { 8.0 } else { (side / 44.0).clamp(7.0, 12.0) };
            layers = layers.push(
                container(
                    container(text(attribution).size(size).color(Color { a: 0.75, ..Color::WHITE }))
                        .padding([1, 4])
                        .style(|_| container::Style { background: Some(Color::from_rgba(0.0, 0.0, 0.0, 0.45).into()), border: iced::Border { radius: 4.0.into(), ..Default::default() }, ..Default::default() }),
                )
                .width(iced::Length::Fill)
                .height(iced::Length::Fill)
                .padding([4.0, 6.0])
                .align_x(iced::alignment::Horizontal::Center)
                .align_y(iced::alignment::Vertical::Bottom),
            );
        }
        let framed = container(layers).style(move |_| container::Style {
            border: iced::Border { color: Color::from_rgba(1.0, 1.0, 1.0, 0.25), width: 1.0, radius: corner.into() },
            ..Default::default()
        });
        let mut picture = painter.paint_scaled::<()>(framed.into(), Size::new(pixels, pixels), pixels as f32 / fit.side as f32);
        round_corners(&mut picture, corner * pixels as f32 / side);
        picture
    }

    /// The arrow's size: playback's (28-120 px by zoom on its 260 px map;
    /// the picture has room around the arrow), scaled to this map.
    pub fn arrow_side(&self, fit: &MapFit) -> u32 {
        let playback = (28.0 + (fit.zoom - 8.0) * 6.5).clamp(28.0, 120.0);
        ((playback * fit.side as f32 / 260.0).round() as u32).max(16)
    }

    /// The car's arrow turned to `heading` degrees.
    pub fn paint_arrow(&self, painter: &mut Painter, heading: f32, size: u32) -> Picture {
        static ARROW: std::sync::OnceLock<iced::widget::image::Handle> = std::sync::OnceLock::new();
        let handle = ARROW.get_or_init(|| iced::widget::image::Handle::from_bytes(include_bytes!("../../assets/dashboard/arrow.png").as_slice())).clone();
        let img = iced::widget::image(handle).width(size as f32).height(size as f32).rotation(iced::Radians(heading.to_radians()));
        painter.paint::<()>(img.into(), Size::new(size, size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::widget::{container, text};

    #[test]
    fn paints_widgets_offscreen() {
        let mut p = Painter::new().expect("software renderer");
        let red = container(text("12:34:56").size(30).color(Color::from_rgb(1.0, 0.0, 0.0)))
            .padding(4)
            .style(|_| container::Style { background: Some(Color::from_rgba(0.0, 0.0, 1.0, 0.5).into()), ..Default::default() });
        let pic = p.paint::<()>(red.into(), Size::new(200, 50));
        assert_eq!(pic.rgba.len(), 200 * 50 * 4);
        // A pixel in the box but off the text: half-transparent blue.
        let px = |x: usize, y: usize| &pic.rgba[(y * 200 + x) * 4..(y * 200 + x) * 4 + 4];
        println!("box corner {:?}, outside {:?}", px(1, 1), px(199, 49));
        // Somewhere in the glyphs there is red.
        let reddest = (0..200 * 50).map(|i| (pic.rgba[i * 4] as i32 - pic.rgba[i * 4 + 2] as i32, i)).max().unwrap();
        println!("reddest pixel {:?}", &pic.rgba[reddest.1 * 4..reddest.1 * 4 + 4]);
    }

    #[test]
    fn scaled_paint_fills_the_picture() {
        let mut p = Painter::new().unwrap();
        for scale in [0.5f32, 0.86, 1.0, 1.19, 2.0] {
            let fill = container(text("")).width(iced::Length::Fill).height(iced::Length::Fill).style(|_| container::Style { background: Some(Color::WHITE.into()), ..Default::default() });
            let pic = p.paint_scaled::<()>(fill.into(), Size::new(200, 100), scale);
            let a = |x: usize, y: usize| pic.rgba[(y * 200 + x) * 4 + 3];
            assert_eq!((a(190, 95), a(100, 50), a(40, 20)), (255, 255, 255), "scale {scale}");
        }
    }

    #[test]
    fn timestamps_read_as_electrons() {
        use crate::settings::DateFormat;
        let t = crate::library::parse_stamp("2026-11-07_13-05-09").unwrap();
        let ts = |date_format, h24| Timestamp { corner: Corner::BottomCenter, date_format, h24 }.text(t);
        assert_eq!(ts(DateFormat::Ymd, false), "2026-11-07 01:05:09 PM");
        assert_eq!(ts(DateFormat::Mdy, true), "11/07/2026 13:05:09");
        assert_eq!(ts(DateFormat::Dmy, false), "07/11/2026 01:05:09 PM");
        assert_eq!(Corner::BottomRight.place(100, 50, 1000, 500), (880.0, 430.0));
        assert_eq!(Corner::TopCenter.place(100, 50, 1000, 500), (450.0, 20.0));
    }

    #[test]
    fn dashboards_size_and_draw() {
        let d = Dashboard { style: DashStyle::Compact, corner: Corner::BottomCenter, size: DashSize::Medium, metric: false, h24: false, accel: crate::dashboard::AccelMode::IconBar, glass: 0.0, free: None };
        // Electron's sizes: Medium 773 x 90 on a wide frame; never wider
        // than the frame less 80 px.
        assert_eq!(d.size(3258), Size::new(773, 90));
        assert_eq!(d.size(600).width, 520);
        assert_eq!(d.place(773, 90, 3258, 1408), (1242.5, 1278.0));
        let mut p = Painter::new().unwrap();
        let state = DashState {
            telemetry: Some(crate::sei::SeiMetadata { gear_state: 1, vehicle_speed_mps: 26.8, autopilot_state: 2, ..Default::default() }),
            time: "1:05:09 PM".into(),
            steering: 10.0,
            blink_ms: 0,
        };
        let started = std::time::Instant::now();
        let width: u32 = std::env::var("SENTRY_DUMP_WIDTH").ok().and_then(|v| v.parse().ok()).unwrap_or(3258);
        let pic = d.paint(&mut p, &state, width);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        if width == 3258 {
            assert_eq!((pic.width, pic.height), (773, 90));
            // The bar is mostly opaque in the middle.
            let mid = &pic.rgba[(45 * 773 + 30) * 4..(45 * 773 + 30) * 4 + 4];
            assert!(mid[3] > 150, "{mid:?}");
        }
        let again = std::time::Instant::now();
        for _ in 0..10 {
            d.paint(&mut p, &state, 3258);
        }
        println!("dashboard: first {ms:.1} ms, then {:.2} ms each", again.elapsed().as_secs_f64() * 100.0);
        if let Some(path) = std::env::var_os("SENTRY_DUMP_OVERLAY") {
            // Over grey, to see it as it would sit on video.
            let mut img = ::image::RgbaImage::from_pixel(pic.width, pic.height, ::image::Rgba([120, 120, 120, 255]));
            for (px, s) in img.pixels_mut().zip(pic.rgba.chunks(4)) {
                for c in 0..3 {
                    px.0[c] = (s[c] as u32 + px.0[c] as u32 * (255 - s[3] as u32) / 255).min(255) as u8;
                }
            }
            img.save(path).unwrap();
        }
    }
}
