//! The blur zone editor (Privacy), as in earlier versions: the camera's
//! picture at the playhead with a purple zone over it. Drag a corner to
//! move it, drag inside to move the zone, click near an edge to add a
//! corner there, double-click a corner to remove it (three at least).

use crate::export::blur::inside;
use iced::mouse;
use iced::widget::canvas::{self, Frame, Path, Stroke};
use iced::{Color, Point, Rectangle, Renderer, Size, Theme};

const PURPLE: Color = Color { r: 147.0 / 255.0, g: 51.0 / 255.0, b: 234.0 / 255.0, a: 1.0 };
/// Pixels from a corner that grab it, and from an edge that offer a new one.
const GRAB: f32 = 8.0;
const EDGE: f32 = 20.0;

/// The camera's picture: RGBA (already mirrored if it is shown mirrored).
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub image: iced::widget::image::Handle,
    pub width: u32,
    pub height: u32,
}

/// The camera's picture now, for the editor: from the player's frame,
/// halved if large, flipped when the camera is shown mirrored.
pub fn snapshot(frame: &crate::decode::Frame, mirror: bool) -> Option<Snapshot> {
    let (w, h) = (frame.width() as usize, frame.height() as usize);
    let step = if w > 1600 { 2 } else { 1 };
    let (ow, oh) = (w / step, h / step);
    let rgba = frame.with_planes(|y, uv| {
        let mut out = vec![255u8; ow * oh * 4];
        for oy in 0..oh {
            for ox in 0..ow {
                let (x, yy) = (ox * step, oy * step);
                let l = y.data[yy * y.stride + x] as f32;
                let c = &uv.data[(yy / 2) * uv.stride + (x / 2) * 2..];
                let (cb, cr) = (c[0] as f32 - 128.0, c[1] as f32 - 128.0);
                // BT.709, limited range.
                let l = (l - 16.0) * 1.164;
                let rgb = [l + 1.793 * cr, l - 0.213 * cb - 0.533 * cr, l + 2.112 * cb];
                let dx = if mirror { ow - 1 - ox } else { ox };
                let o = (oy * ow + dx) * 4;
                for k in 0..3 {
                    out[o + k] = rgb[k].clamp(0.0, 255.0) as u8;
                }
            }
        }
        out
    })?;
    Some(Snapshot { image: iced::widget::image::Handle::from_rgba(ow as u32, oh as u32, rgba), width: ow as u32, height: oh as u32 })
}

pub struct Editor<'a, M> {
    pub snapshot: Option<&'a Snapshot>,
    /// The picture's shape when there is no snapshot.
    pub aspect: f32,
    pub points: &'a [(f32, f32)],
    pub on_change: fn(Vec<(f32, f32)>) -> M,
    /// A new zone being placed corner by corner (kept by the app, so each
    /// click is a message and is drawn at once).
    pub placing: &'a [(f32, f32)],
    pub on_place: fn(Vec<(f32, f32)>) -> M,
}

#[derive(Default)]
pub struct State {
    /// A corner being dragged, or the whole zone (last pointer position).
    corner: Option<usize>,
    zone: Option<Point>,
    /// Where a click would add a corner: after which one, and where.
    ghost: Option<(usize, Point)>,
    last_click: Option<(std::time::Instant, Point)>,
    /// A press on the picture away from the zone: where. A drag from it
    /// draws a rectangle (`dragged`); a click starts placing corners.
    drawing: Option<Point>,
    dragged: bool,
    /// The pointer, for the line to the next corner while placing.
    pointer: Option<Point>,
}

impl<M> Editor<'_, M> {
    /// Where the picture is drawn: as large as fits, centred.
    fn picture(&self, bounds: Size) -> Rectangle {
        let aspect = self.snapshot.map(|s| s.width as f32 / s.height.max(1) as f32).unwrap_or(self.aspect);
        let (w, h) = if bounds.width / bounds.height > aspect { (bounds.height * aspect, bounds.height) } else { (bounds.width, bounds.width / aspect) };
        Rectangle::new(Point::new((bounds.width - w) / 2.0, (bounds.height - h) / 2.0), Size::new(w, h))
    }

    /// The corners placed so far, on the picture.
    fn placed(&self, pic: Rectangle) -> Vec<Point> {
        self.placing.iter().map(|(x, y)| Point::new(pic.x + x * pic.width, pic.y + y * pic.height)).collect()
    }

    fn corners(&self, pic: Rectangle) -> Vec<Point> {
        self.points.iter().map(|(x, y)| Point::new(pic.x + x * pic.width, pic.y + y * pic.height)).collect()
    }

    fn to_points(pic: Rectangle, corners: &[Point]) -> Vec<(f32, f32)> {
        corners.iter().map(|p| (((p.x - pic.x) / pic.width).clamp(0.0, 1.0), ((p.y - pic.y) / pic.height).clamp(0.0, 1.0))).collect()
    }
}

/// The closest point on segment a-b to p.
fn closest(p: Point, a: Point, b: Point) -> Point {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return a;
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0);
    Point::new(a.x + t * dx, a.y + t * dy)
}

/// Whether segments p1-p2 and p3-p4 cross.
fn crosses(p1: Point, p2: Point, p3: Point, p4: Point) -> bool {
    let ccw = |a: Point, b: Point, c: Point| (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
    ccw(p1, p3, p4) != ccw(p2, p3, p4) && ccw(p1, p2, p3) != ccw(p1, p2, p4)
}

/// Whether adding `p` after corner `after` would make the zone cross itself.
fn would_cross(corners: &[Point], after: usize, p: Point) -> bool {
    let mut test = corners.to_vec();
    test.insert(after + 1, p);
    let n = test.len();
    for i in 0..n {
        for j in i + 2..n {
            if i == 0 && j == n - 1 {
                continue;
            }
            if crosses(test[i], test[(i + 1) % n], test[j], test[(j + 1) % n]) {
                return true;
            }
        }
    }
    false
}

impl<M> canvas::Program<M> for Editor<'_, M> {
    type State = State;

    fn update(&self, state: &mut State, event: &canvas::Event, bounds: Rectangle, cursor: mouse::Cursor) -> Option<canvas::Action<M>> {
        let pic = self.picture(bounds.size());
        let mut corners = self.corners(pic);
        match event {
            canvas::Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                let p = cursor.position_in(bounds)?;
                // A double-click on a corner removes it.
                let double = state.last_click.is_some_and(|(t, q)| t.elapsed().as_millis() < 400 && q.distance(p) < 6.0);
                state.last_click = Some((std::time::Instant::now(), p));
                log::info!("zone editor: press at {:.0},{:.0} (picture {:.0}x{:.0} at {:.0},{:.0}; {} corner(s) placed)", p.x, p.y, pic.width, pic.height, pic.x, pic.y, self.placing.len());
                // Placing a new zone: each click a corner; the first corner
                // again (or a double-click) finishes it.
                if !self.placing.is_empty() {
                    let mut placing = self.placed(pic);
                    let q = Point::new(p.x.clamp(pic.x, pic.x + pic.width), p.y.clamp(pic.y, pic.y + pic.height));
                    let closing = placing.len() >= 3 && (placing[0].distance(q) < GRAB + 4.0 || double);
                    if closing {
                        return Some(canvas::Action::publish((self.on_change)(Self::to_points(pic, &placing))).and_capture());
                    }
                    if double {
                        return Some(canvas::Action::capture());
                    }
                    placing.push(q);
                    return Some(canvas::Action::publish((self.on_place)(Self::to_points(pic, &placing))).and_capture());
                }
                if let Some(i) = corners.iter().position(|c| c.distance(p) < GRAB + 2.0) {
                    if double && corners.len() > 3 {
                        corners.remove(i);
                        state.corner = None;
                        return Some(canvas::Action::publish((self.on_change)(Self::to_points(pic, &corners))).and_capture());
                    }
                    state.corner = Some(i);
                    return Some(canvas::Action::capture());
                }
                if let Some((after, g)) = state.ghost {
                    if g.distance(p) < 10.0 && !would_cross(&corners, after, g) {
                        corners.insert(after + 1, g);
                        state.ghost = None;
                        return Some(canvas::Action::publish((self.on_change)(Self::to_points(pic, &corners))).and_capture());
                    }
                }
                let as_points: Vec<(f32, f32)> = corners.iter().map(|c| (c.x, c.y)).collect();
                if inside((p.x, p.y), &as_points) {
                    state.zone = Some(p);
                    return Some(canvas::Action::capture());
                }
                // Anywhere else on the picture: a drag draws a new zone
                // (a rectangle, its corners then moved as usual).
                if pic.contains(p) {
                    state.drawing = Some(p);
                    state.dragged = false;
                    return Some(canvas::Action::capture());
                }
                None
            }
            canvas::Event::Mouse(mouse::Event::CursorMoved { .. }) => {
                // Dragging carries on outside the picture, kept inside it.
                let p = cursor.position_from(bounds.position())?;
                if !self.placing.is_empty() {
                    state.pointer = Some(p);
                    return Some(canvas::Action::request_redraw());
                }
                if let Some(start) = state.drawing {
                    let q = Point::new(p.x.clamp(pic.x, pic.x + pic.width), p.y.clamp(pic.y, pic.y + pic.height));
                    // A few pixels first, so a click doesn't flatten the zone.
                    if (q.x - start.x).abs() < 6.0 || (q.y - start.y).abs() < 6.0 {
                        return Some(canvas::Action::capture());
                    }
                    state.dragged = true;
                    let (l, r) = (start.x.min(q.x), start.x.max(q.x));
                    let (t, b) = (start.y.min(q.y), start.y.max(q.y));
                    let drawn = [Point::new(l, t), Point::new(r, t), Point::new(r, b), Point::new(l, b)];
                    return Some(canvas::Action::publish((self.on_change)(Self::to_points(pic, &drawn))).and_capture());
                }
                if let Some(i) = state.corner {
                    let c = corners.get_mut(i)?;
                    *c = Point::new(p.x.clamp(pic.x, pic.x + pic.width), p.y.clamp(pic.y, pic.y + pic.height));
                    return Some(canvas::Action::publish((self.on_change)(Self::to_points(pic, &corners))).and_capture());
                }
                if let Some(last) = state.zone {
                    let (min_x, max_x) = corners.iter().fold((f32::MAX, f32::MIN), |(a, b), c| (a.min(c.x), b.max(c.x)));
                    let (min_y, max_y) = corners.iter().fold((f32::MAX, f32::MIN), |(a, b), c| (a.min(c.y), b.max(c.y)));
                    let dx = (p.x - last.x).clamp(pic.x - min_x, pic.x + pic.width - max_x);
                    let dy = (p.y - last.y).clamp(pic.y - min_y, pic.y + pic.height - max_y);
                    state.zone = Some(p);
                    for c in &mut corners {
                        c.x += dx;
                        c.y += dy;
                    }
                    return Some(canvas::Action::publish((self.on_change)(Self::to_points(pic, &corners))).and_capture());
                }
                // Near an edge, outside the zone: a corner could go here.
                let as_points: Vec<(f32, f32)> = corners.iter().map(|c| (c.x, c.y)).collect();
                let ghost = if cursor.is_over(bounds) && !inside((p.x, p.y), &as_points) {
                    (0..corners.len())
                        .map(|i| (i, closest(p, corners[i], corners[(i + 1) % corners.len()])))
                        .min_by(|a, b| a.1.distance(p).total_cmp(&b.1.distance(p)))
                        .filter(|(_, g)| g.distance(p) < EDGE)
                } else {
                    None
                };
                let changed = ghost.map(|g| g.1) != state.ghost.map(|g| g.1);
                state.ghost = ghost;
                changed.then(canvas::Action::request_redraw)
            }
            canvas::Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                // A click (no drag) on the picture: the first corner of a
                // new zone.
                if let Some(start) = state.drawing.take() {
                    if !state.dragged {
                        state.pointer = Some(start);
                        return Some(canvas::Action::publish((self.on_place)(Self::to_points(pic, &[start]))).and_capture());
                    }
                    return Some(canvas::Action::capture());
                }
                let was = state.corner.take().is_some() | state.zone.take().is_some();
                was.then(canvas::Action::capture)
            }
            // Escape drops a zone being placed (and only that).
            canvas::Event::Keyboard(iced::keyboard::Event::KeyPressed { key: iced::keyboard::Key::Named(iced::keyboard::key::Named::Escape), .. }) if !self.placing.is_empty() => {
                Some(canvas::Action::publish((self.on_place)(Vec::new())).and_capture())
            }
            _ => None,
        }
    }

    fn draw(&self, state: &State, renderer: &Renderer, _theme: &Theme, bounds: Rectangle, _cursor: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let pic = self.picture(bounds.size());
        match self.snapshot {
            Some(s) => frame.draw_image(pic, canvas::Image::new(s.image.clone())),
            None => frame.fill_rectangle(pic.position(), pic.size(), Color::from_rgb8(20, 22, 26)),
        }
        let corners = self.corners(pic);
        let placing = !self.placing.is_empty();
        if corners.len() >= 3 && !placing {
            let path = Path::new(|b| {
                b.move_to(corners[0]);
                for c in &corners[1..] {
                    b.line_to(*c);
                }
                b.close();
            });
            frame.fill(&path, Color { a: 0.4, ..PURPLE });
            frame.stroke(&path, Stroke::default().with_width(2.0).with_color(Color { a: 0.8, ..PURPLE }));
        }
        if placing {
            // The corners so far, joined, and a line on to the pointer.
            let pts = &self.placed(pic);
            let mut line = pts.clone();
            if let Some(p) = state.pointer {
                line.push(p);
            }
            if line.len() >= 2 {
                let path = Path::new(|b| {
                    b.move_to(line[0]);
                    for c in &line[1..] {
                        b.line_to(*c);
                    }
                });
                frame.stroke(&path, Stroke::default().with_width(2.0).with_color(Color { a: 0.9, ..PURPLE }));
            }
            // The first corner, ringed: clicking it again finishes.
            frame.stroke(&Path::circle(pts[0], 10.0), Stroke::default().with_width(2.0).with_color(Color::WHITE));
            for c in pts {
                frame.fill(&Path::circle(*c, 6.0), Color::WHITE);
                frame.fill(&Path::circle(*c, 4.0), PURPLE);
            }
            return vec![frame.into_geometry()];
        }
        for c in &corners {
            frame.fill(&Path::circle(*c, 6.0), Color::WHITE);
            frame.fill(&Path::circle(*c, 4.0), PURPLE);
        }
        if let Some((_, g)) = state.ghost {
            frame.fill(&Path::circle(g, 5.0), Color { a: 0.6, ..Color::WHITE });
        }
        vec![frame.into_geometry()]
    }

    fn mouse_interaction(&self, state: &State, bounds: Rectangle, cursor: mouse::Cursor) -> mouse::Interaction {
        if state.corner.is_some() || state.zone.is_some() {
            return mouse::Interaction::Grabbing;
        }
        if state.drawing.is_some() || !self.placing.is_empty() {
            return mouse::Interaction::Crosshair;
        }
        let Some(p) = cursor.position_in(bounds) else { return mouse::Interaction::default() };
        let pic = self.picture(bounds.size());
        let corners = self.corners(pic);
        if corners.iter().any(|c| c.distance(p) < GRAB + 2.0) {
            return mouse::Interaction::Grab;
        }
        if state.ghost.is_some() {
            return mouse::Interaction::Crosshair;
        }
        let as_points: Vec<(f32, f32)> = corners.iter().map(|c| (c.x, c.y)).collect();
        if inside((p.x, p.y), &as_points) {
            mouse::Interaction::Move
        } else if self.picture(bounds.size()).contains(p) {
            mouse::Interaction::Crosshair
        } else {
            mouse::Interaction::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_corners_must_not_cross_the_zone() {
        let square = [Point::new(0.0, 0.0), Point::new(10.0, 0.0), Point::new(10.0, 10.0), Point::new(0.0, 10.0)];
        // Just outside the top edge: fine.
        assert!(!would_cross(&square, 0, Point::new(5.0, -2.0)));
        // Far across, between the first two corners: the new edges cross the zone.
        assert!(would_cross(&square, 0, Point::new(5.0, 20.0)));
        assert_eq!(closest(Point::new(5.0, -3.0), square[0], square[1]), Point::new(5.0, 0.0));
    }
}
