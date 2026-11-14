//! Where everything goes in an export: the cameras in their grid or where
//! they were moved, the overlays in their corners or where they were
//! dragged, and the frame around them. As in earlier versions' Advanced
//! Editor, the frame is the box around the cameras and the overlays:
//! cameras stacked make a tall video, a dashboard put below them makes it
//! taller. Untouched, it is the grid (and Tesla Mobile's bars), as before.
//!
//! Places are worked out on a sheet whose origin is the grid's top-left,
//! in the export's pixels. A moved piece's place is kept as shares of the
//! grid's width and height, so it stays put while the frame around it
//! changes.

use super::job::Tile;
use super::overlay::{DashStyle, Dashboard, Minimap, Timestamp, Watermark};
use super::tesla_mobile::bar_heights;
use crate::library::Camera;

/// A rectangle in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    /// The box around both.
    pub fn union(self, o: Rect) -> Rect {
        let (x, y) = (self.x.min(o.x), self.y.min(o.y));
        Rect::new(x, y, self.right().max(o.right()) - x, self.bottom().max(o.bottom()) - y)
    }

    /// A `w` x `h` piece whose top-left would be `(x, y)`, moved inside
    /// this one (as far as it fits).
    fn keep_in(&self, x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect::new(x.clamp(self.x, (self.right() - w).max(self.x)), y.clamp(self.y, (self.bottom() - h).max(self.y)), w, h)
    }
}

/// The overlays as set up (None: off).
#[derive(Debug, Default, Clone, Copy)]
pub struct Overlays<'a> {
    pub timestamp: Option<&'a Timestamp>,
    pub dashboard: Option<&'a Dashboard>,
    pub minimap: Option<&'a Minimap>,
    pub watermark: Option<&'a Watermark>,
}

/// What's in an export and where, on the sheet (see the top).
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// The grid's size: moved pieces' places are shares of it.
    pub grid: (u32, u32),
    /// Where pieces can be put: the untouched frame (the grid and Tesla
    /// Mobile's bars) widened to 16:9 around it, as earlier versions'
    /// editor canvas was.
    pub canvas: Rect,
    /// The exported frame: the box around everything, its sides even
    /// (for the encoders).
    pub frame: Rect,
    /// The cameras, in drawing order.
    pub cameras: Vec<(Camera, Rect)>,
    /// The box around the cameras: the overlays' corners are its corners.
    pub area: Rect,
    pub timestamp: Option<Rect>,
    /// The compact dashboard, or Tesla Mobile's data bar.
    pub dashboard: Option<Rect>,
    /// Tesla Mobile's date bar.
    pub date_bar: Option<Rect>,
    pub map: Option<Rect>,
    pub watermark: Option<Rect>,
}

impl Layout {
    /// `r` in the frame's pixels: (x, y, width, height).
    pub fn in_frame(&self, r: Rect) -> (f32, f32, f32, f32) {
        (r.x - self.frame.x, r.y - self.frame.y, r.w, r.h)
    }

    /// The frame's width and height.
    pub fn size(&self) -> (u32, u32) {
        (self.frame.w as u32, self.frame.h as u32)
    }

    /// What the editor shows: the canvas, and the frame where it reaches
    /// past it (Tesla Mobile's bars over cameras moved to the canvas's top).
    pub fn view(&self) -> Rect {
        self.canvas.union(self.frame)
    }

    /// A camera's place.
    pub fn camera(&self, c: Camera) -> Option<Rect> {
        self.cameras.iter().find(|(k, _)| *k == c).map(|(_, r)| *r)
    }
}

/// Where everything goes: cameras `cell` big in the grid of `tiles` (or
/// where they were moved), the overlays `o` in their corners of the
/// cameras (or where they were dragged), and the frame around it all.
pub fn layout(tiles: &[Tile], cell: (u32, u32), o: Overlays<'_>) -> Layout {
    let (cw, ch) = (cell.0 as f32, cell.1 as f32);
    let cols = tiles.iter().map(|t| t.col + 1).max().unwrap_or(1);
    let rows = tiles.iter().map(|t| t.row + 1).max().unwrap_or(1);
    let grid = (cell.0 * cols, cell.1 * rows);
    let (gw, gh) = (grid.0 as f32, grid.1 as f32);
    // Tesla Mobile's bars, as earlier versions added them to the frame: the
    // date bar on top, the data bar under or over the cameras.
    let tm = o.dashboard.filter(|d| d.style == DashStyle::TeslaMobile);
    let (date_h, data_h) = tm.map_or((0, 0), |_| bar_heights(grid.0));
    let above = tm.map_or(0, |d| date_h + if d.bar_on_top() { data_h } else { 0 }) as f32;
    let home = Rect::new(0.0, -above, gw, gh + (date_h + data_h) as f32);
    let (canvas_w, canvas_h) = (home.w.max((home.h * 16.0 / 9.0).round()), home.h.max((home.w * 9.0 / 16.0).round()));
    let canvas = Rect::new((home.x - (canvas_w - home.w) / 2.0).round(), (home.y - (canvas_h - home.h) / 2.0).round(), canvas_w, canvas_h);

    // The cameras: in their cells, or moved (their width a share of the
    // grid's, their shape the camera's), whole pixels, on the canvas.
    let cameras: Vec<(Camera, Rect)> = tiles
        .iter()
        .map(|t| {
            let Some((x, y, w)) = t.free else {
                return (t.camera, Rect::new(t.col as f32 * cw, t.row as f32 * ch, cw, ch));
            };
            let mut tw = (w * gw).round().clamp(16.0, canvas.w);
            let mut th = (tw * ch / cw).round();
            if th > canvas.h {
                th = canvas.h;
                tw = (th * cw / ch).round().min(canvas.w);
            }
            (t.camera, canvas.keep_in((x * gw).round(), (y * gh).round(), tw, th))
        })
        .collect();
    let area = cameras.iter().map(|(_, r)| *r).reduce(Rect::union).unwrap_or(Rect::new(0.0, 0.0, gw, gh));
    // An overlay `w` x `h`: in a corner of the cameras, or where it was
    // dragged (shares of the grid).
    let place = |free: Option<(f32, f32)>, corner: (f32, f32), w: u32, h: u32| {
        let (w, h) = (w as f32, h as f32);
        match free {
            Some((x, y)) => canvas.keep_in((x * gw).round(), (y * gh).round(), w, h),
            None => Rect::new(area.x + corner.0, area.y + corner.1, w, h),
        }
    };
    let (aw, ah) = (area.w as u32, area.h as u32);

    let timestamp = o.timestamp.map(|ts| {
        let size = ts.size(grid.0);
        place(ts.free, ts.corner.place(size.width, size.height, aw, ah), size.width, size.height)
    });
    let (dashboard, date_bar) = match o.dashboard {
        Some(d) if d.style == DashStyle::Compact => {
            let size = d.size(grid.0);
            (Some(place(d.free, d.place(size.width, size.height, aw, ah), size.width, size.height)), None)
        }
        Some(d) => {
            // Across the cameras (earlier versions' bars), or moved: its
            // width a share of the grid's, its height the bar's for that.
            let (date_h, data_h) = bar_heights(aw);
            let moved = |(x, y, share): (f32, f32, f32), date: bool| {
                let w = (share * gw).round().clamp(64.0, canvas.w);
                let (dh, bh) = bar_heights(w as u32);
                canvas.keep_in((x * gw).round(), (y * gh).round(), w, if date { dh } else { bh } as f32)
            };
            let data = match d.data_bar {
                Some(f) => moved(f, false),
                None if d.bar_on_top() => Rect::new(area.x, area.y - data_h as f32, area.w, data_h as f32),
                None => Rect::new(area.x, area.bottom(), area.w, data_h as f32),
            };
            let date = match d.date_bar {
                Some(f) => moved(f, true),
                None => Rect::new(area.x, area.y - (date_h + if d.bar_on_top() { data_h } else { 0 }) as f32, area.w, date_h as f32),
            };
            (Some(data), Some(date))
        }
        None => (None, None),
    };
    let map = o.minimap.map(|m| {
        let side = m.side(home.w as u32, home.h as u32);
        place(m.free, m.corner.place(side, side, aw, ah), side, side)
    });
    let watermark = o.watermark.map(|wm| {
        let (w, h) = wm.size(grid.0);
        place(wm.free, wm.corner.place(w, h, aw, ah), w, h)
    });

    // The frame: whole pixels around everything, its sides even.
    let all = [timestamp, dashboard, date_bar, map, watermark].into_iter().flatten().fold(area, Rect::union);
    let (x0, y0) = (all.x.floor(), all.y.floor());
    let even = |n: f32| {
        let n = n.max(2.0) as u32;
        (n + n % 2) as f32
    };
    let frame = Rect::new(x0, y0, even(all.right().ceil() - x0), even(all.bottom().ceil() - y0));
    Layout { grid, canvas, frame, cameras, area, timestamp, dashboard, date_bar, map, watermark }
}

/// As `layout`, the cameras made smaller when the frame is bigger than
/// `limit` on a side (an encoder's most): the cell size the export uses,
/// and the layout. None when it can't be made to fit.
pub fn fitted(tiles: &[Tile], mut cell: (u32, u32), o: Overlays<'_>, limit: u32) -> Option<((u32, u32), Layout)> {
    let mut l = layout(tiles, cell, o);
    for _ in 0..8 {
        let widest = l.frame.w.max(l.frame.h);
        if widest <= limit as f32 {
            return Some((cell, l));
        }
        // Smaller by the share it's too big (the overlays keep their
        // pixel sizes, so it may take another step); even sides.
        let k = limit as f64 / widest as f64 * 0.995;
        let shrink = |n: u32| (((n as f64 * k).floor() as u32) & !1).max(16);
        cell = (shrink(cell.0), shrink(cell.1));
        l = layout(tiles, cell, o);
    }
    (l.frame.w.max(l.frame.h) <= limit as f32).then_some((cell, l))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::job::grid;
    use crate::export::overlay::{Corner, DashSize, DashSizes};
    use crate::library::GRID;

    const CELL: (u32, u32) = (1086, 704);

    fn dash(style: DashStyle) -> Dashboard {
        Dashboard {
            style,
            corner: Corner::BottomCenter,
            share: DashSize::Medium.share(),
            metric: false,
            h24: false,
            date_format: crate::settings::DateFormat::Ymd,
            accel: crate::dashboard::AccelMode::IconBar,
            glass: 0.0,
            free: None,
            data_bar: None,
            date_bar: None,
            sizes: DashSizes::default(),
        }
    }

    fn stamp() -> Timestamp {
        Timestamp { corner: Corner::BottomCenter, date_format: crate::settings::DateFormat::Ymd, h24: false, free: None, scale: 1.0 }
    }

    /// Nothing moved: the grid, as exports have always been, whatever
    /// overlays sit in their corners.
    #[test]
    fn untouched_is_the_grid() {
        let tiles = grid(&GRID);
        let ts = stamp();
        let wm = Watermark { corner: Corner::BottomRight, free: None, share: Watermark::SHARE };
        let l = layout(&tiles, CELL, Overlays { timestamp: Some(&ts), watermark: Some(&wm), ..Default::default() });
        assert_eq!(l.frame, Rect::new(0.0, 0.0, 3258.0, 1408.0));
        assert_eq!(l.size(), (3258, 1408));
        assert_eq!(l.camera(Camera::RightRepeater), Some(Rect::new(2172.0, 704.0, 1086.0, 704.0)));
        // The time 20 px over the bottom, centred, 760 x 57 at 36 px.
        assert_eq!(l.timestamp, Some(Rect::new(1249.0, 1331.0, 760.0, 57.0)));
        // A 16:9 canvas around it, the grid in its middle.
        assert_eq!(l.canvas, Rect::new(0.0, -213.0, 3258.0, 1833.0));
        // Medium compact dashboard 40 px over the bottom, as before.
        let d = dash(DashStyle::Compact);
        let l = layout(&tiles, CELL, Overlays { dashboard: Some(&d), ..Default::default() });
        assert_eq!((l.frame, l.dashboard), (Rect::new(0.0, 0.0, 3258.0, 1408.0), Some(Rect::new(1242.5, 1278.0, 773.0, 90.0))));
    }

    /// Tesla Mobile untouched: the date bar on top and the data bar under
    /// (or over) the cameras, across them, as earlier versions padded it.
    #[test]
    fn tesla_mobile_bars_pad_the_grid() {
        let tiles = grid(&GRID);
        let mut d = dash(DashStyle::TeslaMobile);
        let l = layout(&tiles, CELL, Overlays { dashboard: Some(&d), ..Default::default() });
        assert_eq!(l.size(), (3258, 1408 + 72 + 86));
        assert_eq!(l.in_frame(l.date_bar.unwrap()), (0.0, 0.0, 3258.0, 72.0));
        assert_eq!(l.in_frame(l.dashboard.unwrap()), (0.0, 1480.0, 3258.0, 86.0));
        assert_eq!(l.in_frame(l.camera(Camera::LeftPillar).unwrap()), (0.0, 72.0, 1086.0, 704.0));
        d.corner = Corner::TopCenter;
        let l = layout(&tiles, CELL, Overlays { dashboard: Some(&d), ..Default::default() });
        assert_eq!(l.in_frame(l.dashboard.unwrap()), (0.0, 72.0, 3258.0, 86.0));
        assert_eq!(l.in_frame(l.camera(Camera::LeftPillar).unwrap()).1, 158.0);
        // The data bar moved up above the date bar, half as wide.
        d.data_bar = Some((0.0, -0.2, 0.5));
        let l = layout(&tiles, CELL, Overlays { dashboard: Some(&d), ..Default::default() });
        assert_eq!(l.dashboard.unwrap(), Rect::new(0.0, -282.0, 1629.0, 44.0));
        // The date bar still sits over the cameras (where the data bar
        // was), and the frame reaches up to the moved bar.
        assert_eq!(l.date_bar.unwrap(), Rect::new(0.0, -158.0, 3258.0, 72.0));
        assert_eq!(l.frame, Rect::new(0.0, -282.0, 3258.0, 1690.0));
    }

    /// Two cameras stacked: a tall frame, just around them.
    #[test]
    fn stacked_cameras_make_a_tall_frame() {
        let mut tiles = grid(&[Camera::Front, Camera::Back]);
        let l = layout(&tiles, CELL, Overlays::default());
        assert_eq!((l.size(), l.canvas), ((2172, 704), Rect::new(0.0, -259.0, 2172.0, 1222.0)));
        // The canvas is 16:9: at full size the back camera can't go under
        // the front one, it stops at the canvas's bottom.
        tiles[1].free = Some((0.0, 1.0, 0.5));
        assert_eq!(layout(&tiles, CELL, Overlays::default()).camera(Camera::Back), Some(Rect::new(0.0, 259.0, 1086.0, 704.0)));
        // Both made smaller (869 x 563), one over the other.
        tiles[0].free = Some((0.0, -0.25, 0.4));
        tiles[1].free = Some((0.0, 387.0 / 704.0, 0.4));
        let l = layout(&tiles, CELL, Overlays::default());
        assert_eq!(l.camera(Camera::Front), Some(Rect::new(0.0, -176.0, 869.0, 563.0)));
        assert_eq!(l.camera(Camera::Back), Some(Rect::new(0.0, 387.0, 869.0, 563.0)));
        // 869 wide made even.
        assert_eq!(l.frame, Rect::new(0.0, -176.0, 870.0, 1126.0));
        assert_eq!(l.in_frame(l.camera(Camera::Back).unwrap()), (0.0, 563.0, 869.0, 563.0));
        // Whatever the places, the sides stay even.
        tiles[1].free = Some((0.123, 0.777, 0.3333));
        let (w, h) = layout(&tiles, CELL, Overlays::default()).size();
        assert!(w % 2 == 0 && h % 2 == 0, "{w} x {h}");
    }

    /// A dashboard dragged below the cameras makes the frame taller; one
    /// left in its corner doesn't.
    #[test]
    fn a_dashboard_below_grows_the_frame() {
        let tiles = grid(&GRID);
        let mut d = dash(DashStyle::Compact);
        d.free = Some((0.3, 1.05));
        let l = layout(&tiles, CELL, Overlays { dashboard: Some(&d), ..Default::default() });
        let r = l.dashboard.unwrap();
        assert_eq!((r.x, r.y), (977.0, 1478.0));
        assert_eq!(l.frame, Rect::new(0.0, 0.0, 3258.0, 1568.0));
        // In the frame, the cameras stay at the top.
        assert_eq!(l.in_frame(l.camera(Camera::LeftPillar).unwrap()), (0.0, 0.0, 1086.0, 704.0));
        // Never past the canvas.
        d.free = Some((2.0, 5.0));
        let l = layout(&tiles, CELL, Overlays { dashboard: Some(&d), ..Default::default() });
        assert_eq!(l.dashboard.unwrap().bottom(), l.canvas.bottom());
        // The time dragged above the cameras.
        let ts = Timestamp { free: Some((0.0, -0.1)), scale: 2.0, ..stamp() };
        let l = layout(&tiles, CELL, Overlays { timestamp: Some(&ts), ..Default::default() });
        assert_eq!(l.timestamp, Some(Rect::new(0.0, -141.0, 1520.0, 115.0)));
        // 1549 high made even.
        assert_eq!(l.frame, Rect::new(0.0, -141.0, 3258.0, 1550.0));
    }

    /// Too big for the encoder: the cameras shrink until it fits.
    #[test]
    fn too_big_is_made_smaller() {
        let mut tiles = grid(&GRID);
        // Untouched and small enough: as it was.
        let (cell, l) = fitted(&tiles, CELL, Overlays::default(), 4096).unwrap();
        assert_eq!((cell, l.size()), (CELL, (3258, 1408)));
        // Max (1448 x 938 a camera) is 4344 wide: past H.264's 4096.
        let (cell, l) = fitted(&tiles, (1448, 938), Overlays::default(), 4096).unwrap();
        let (w, h) = l.size();
        assert!(w <= 4096 && w > 4000 && w % 2 == 0 && h % 2 == 0, "{cell:?}: {w} x {h}");
        // A camera moved off to the side, the frame wider than the limit.
        tiles[0].free = Some((-0.2, 0.0, 1.0 / 3.0));
        assert!(fitted(&tiles, (1448, 938), Overlays::default(), 4096).unwrap().1.frame.w <= 4096.0);
    }
}
