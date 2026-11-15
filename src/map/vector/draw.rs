//! Replay the map style's geometry to a cached bitmap and its label positions
//! to the Iced canvas. The label pass uses screen coordinates.

use day_geometry::{Affine, Color, Point as MapPoint, Rect};
use day_piece_map::camera::{Camera, WORLD};
use day_spec::{DrawOp, FillRule, LineCap, LineJoin, Paint, PathSeg, Shape};
use iced::advanced::graphics::text::Paragraph;
use iced::advanced::text::{Paragraph as _, Text};
use iced::widget::{canvas, image, text};
use iced::{Font, Point, Radians, Rectangle, Size, Vector};
use std::collections::HashMap;
use std::f64::consts::{FRAC_PI_2, PI};
use std::rc::Rc;
use tiny_skia::{Mask, Path, PathBuilder, Pixmap, Transform};

const PIXEL_RATIO: f64 = 2.0;
// Iced's wgpu backend uploads RGBA images of 2 MiB or more asynchronously.
// A changing basemap must be available on the first frame of each new image.
const MAX_BASEMAP_DIMENSION: u32 = 720;

pub(super) fn basemap(ops: &[DrawOp], side: f64) -> Option<image::Handle> {
    let dimension = ((side * PIXEL_RATIO).ceil() as u32).min(MAX_BASEMAP_DIMENSION);
    let mut pixmap = Pixmap::new(dimension, dimension)?;
    let scale = (f64::from(dimension) / side) as f32;
    let transform = Transform::from_scale(scale, scale);
    let mut clip: Option<Rc<Mask>> = None;
    let mut stack = Vec::new();
    let mut tile_masks = Vec::new();

    for op in ops {
        match op {
            DrawOp::Save => stack.push(clip.clone()),
            DrawOp::Restore => clip = stack.pop().flatten(),
            DrawOp::Clip(shape) => {
                // Pixmap draws are already confined to the outer viewport.
                if matches!(shape, Shape::Rect(rect) if *rect == Rect::new(0.0, 0.0, side, side)) {
                    continue;
                }
                let Some((path, rule)) = path(shape) else {
                    continue;
                };
                if let Some(mask) = &mut clip {
                    Rc::make_mut(mask).intersect_path(&path, rule, true, transform);
                } else if let Some((_, mask)) = tile_masks.iter().find(|(key, _)| *key == shape) {
                    clip = Some(Rc::clone(mask));
                } else {
                    let mut mask = Mask::new(dimension, dimension)?;
                    mask.fill_path(&path, rule, true, transform);
                    let mask = Rc::new(mask);
                    tile_masks.push((shape, mask.clone()));
                    clip = Some(mask);
                }
            }
            DrawOp::Fill(shape, Paint::Solid(color)) => {
                if let Some((path, rule)) = path(shape) {
                    pixmap.fill_path(&path, &paint(*color), rule, transform, clip.as_deref());
                }
            }
            DrawOp::Stroke(shape, Paint::Solid(color), style) => {
                if let Some((path, _)) = path(shape) {
                    let stroke = tiny_skia::Stroke {
                        width: style.width as f32,
                        miter_limit: style.miter_limit as f32,
                        line_cap: match style.cap {
                            LineCap::Butt => tiny_skia::LineCap::Butt,
                            LineCap::Round => tiny_skia::LineCap::Round,
                            LineCap::Square => tiny_skia::LineCap::Square,
                        },
                        line_join: match style.join {
                            LineJoin::Miter => tiny_skia::LineJoin::Miter,
                            LineJoin::Round => tiny_skia::LineJoin::Round,
                            LineJoin::Bevel => tiny_skia::LineJoin::Bevel,
                        },
                        dash: tiny_skia::StrokeDash::new(
                            style.dash.iter().map(|length| *length as f32).collect(),
                            style.dash_phase as f32,
                        ),
                    };
                    pixmap.stroke_path(&path, &paint(*color), &stroke, transform, clip.as_deref());
                }
            }
            _ => {}
        }
    }

    Some(rgba_handle(pixmap))
}

fn rgba_handle(pixmap: Pixmap) -> image::Handle {
    let (width, height) = (pixmap.width(), pixmap.height());
    let mut pixels = pixmap.take();
    for rgba in pixels.chunks_exact_mut(4) {
        if let 1..=254 = rgba[3] {
            let alpha = u16::from(rgba[3]);
            for channel in &mut rgba[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha) as u8;
            }
        }
    }
    image::Handle::from_rgba(width, height, pixels)
}

fn paint(color: Color) -> tiny_skia::Paint<'static> {
    let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    let mut paint = tiny_skia::Paint::default();
    paint.set_color_rgba8(
        channel(color.r),
        channel(color.g),
        channel(color.b),
        channel(color.a),
    );
    paint
}

fn path(shape: &Shape) -> Option<(Path, tiny_skia::FillRule)> {
    let mut builder = PathBuilder::new();
    let mut rule = tiny_skia::FillRule::Winding;
    match shape {
        Shape::Rect(rect) => {
            builder.push_rect(tiny_skia::Rect::from_xywh(
                rect.origin.x as f32,
                rect.origin.y as f32,
                rect.size.width as f32,
                rect.size.height as f32,
            )?);
        }
        Shape::Ellipse(rect) => {
            builder.push_oval(tiny_skia::Rect::from_xywh(
                rect.origin.x as f32,
                rect.origin.y as f32,
                rect.size.width as f32,
                rect.size.height as f32,
            )?);
        }
        Shape::Line(a, b) => {
            builder.move_to(a.x as f32, a.y as f32);
            builder.line_to(b.x as f32, b.y as f32);
        }
        Shape::Polygon(points) => {
            let (first, rest) = points.split_first()?;
            builder.move_to(first.x as f32, first.y as f32);
            for p in rest {
                builder.line_to(p.x as f32, p.y as f32);
            }
            builder.close();
        }
        Shape::Path(path) => {
            if path.rule == FillRule::EvenOdd {
                rule = tiny_skia::FillRule::EvenOdd;
            }
            for seg in &path.segs {
                match seg {
                    PathSeg::Move(p) => builder.move_to(p.x as f32, p.y as f32),
                    PathSeg::Line(p) => builder.line_to(p.x as f32, p.y as f32),
                    PathSeg::Quad(c, p) => {
                        builder.quad_to(c.x as f32, c.y as f32, p.x as f32, p.y as f32)
                    }
                    PathSeg::Cubic(a, b, p) => builder.cubic_to(
                        a.x as f32, a.y as f32, b.x as f32, b.y as f32, p.x as f32, p.y as f32,
                    ),
                    PathSeg::Close => builder.close(),
                }
            }
        }
        _ => return None,
    }
    Some((builder.finish()?, rule))
}

// A street label can turn slightly past vertical before it reverses. Once
// reversed, it has to cross the other side of that band to turn back.
const FLIP_MARGIN: f64 = 8.0 * PI / 180.0;
const LABEL_MATCH_PIXELS: f64 = 36.0;
const LABEL_HISTORY_FRAMES: u64 = 12;
const LABEL_VISIBLE_MIN: f32 = 0.7;
const MAX_LABEL_MEASUREMENTS: usize = 2048;

#[derive(Default)]
pub(super) struct LabelHistory {
    frame: u64,
    labels: Vec<LabelPlacement>,
    measurements: HashMap<(String, u32, Font), Size>,
}

struct LabelPlacement {
    name: String,
    position: MapPoint,
    angle: f64,
    frame: u64,
}

impl LabelHistory {
    fn measure(&mut self, label: &canvas::Text) -> Size {
        if self.measurements.len() >= MAX_LABEL_MEASUREMENTS {
            self.measurements.clear();
        }
        let key = (label.content.clone(), label.size.0.to_bits(), label.font);
        *self.measurements.entry(key).or_insert_with(|| {
            Paragraph::with_text(Text {
                content: label.content.as_str(),
                bounds: Size::INFINITE,
                size: label.size,
                font: label.font,
                line_height: label.line_height,
                align_x: label.align_x,
                align_y: label.align_y,
                shaping: label.shaping,
                wrapping: text::Wrapping::None,
            })
            .min_bounds()
        })
    }

    fn begin_frame(&mut self) {
        self.frame += 1;
        self.labels
            .retain(|label| self.frame - label.frame <= LABEL_HISTORY_FRAMES);
    }

    fn remember(
        &mut self,
        name: &str,
        camera: &Camera,
        position: MapPoint,
        angle: f64,
    ) -> (MapPoint, f64) {
        let maximum = LABEL_MATCH_PIXELS / camera.scale();
        let nearest = self
            .labels
            .iter_mut()
            .filter(|label| label.name == name && label.frame != self.frame)
            .filter_map(|label| {
                let delta_x =
                    (label.position.x - position.x + WORLD / 2.0).rem_euclid(WORLD) - WORLD / 2.0;
                let distance = delta_x.hypot(label.position.y - position.y);
                (distance <= maximum).then_some((distance, label))
            })
            .min_by(|(a, _), (b, _)| a.total_cmp(b));
        if let Some((_, label)) = nearest {
            let angle = stable_angle(label.angle, angle);
            // A new candidate for the same nearby label may be placed a few
            // metres down the street at a new zoom. Keep its established anchor.
            label.angle = angle;
            label.frame = self.frame;
            (label.position, angle)
        } else {
            self.labels.push(LabelPlacement {
                name: name.to_owned(),
                position,
                angle,
                frame: self.frame,
            });
            (position, angle)
        }
    }
}

fn stable_angle(previous: f64, upright: f64) -> f64 {
    if upright.abs() >= FRAC_PI_2 - FLIP_MARGIN && (upright - previous).cos() < 0.0 {
        upright - PI.copysign(upright)
    } else {
        upright
    }
}

pub(super) fn labels(
    frame: &mut canvas::Frame,
    ops: &[DrawOp],
    placement: &Camera,
    camera: &Camera,
    radius: f32,
    history: &mut LabelHistory,
) {
    history.begin_frame();
    let mut transform = Affine::IDENTITY;
    let mut stack = Vec::new();
    let panel = Rectangle::with_size(Size::new(
        camera.size.width as f32,
        camera.size.height as f32,
    ));
    let mut ops = ops.iter().peekable();
    while let Some(op) = ops.next() {
        match op {
            DrawOp::Save => stack.push(transform),
            DrawOp::Restore => transform = stack.pop().unwrap_or(Affine::IDENTITY),
            DrawOp::Concat(next) => transform = next.then(transform),
            DrawOp::Text { text, .. } => {
                let anchor = MapPoint::new(transform.tx, transform.ty);
                let original_angle = transform.b.atan2(transform.a);
                let (world, angle) = history.remember(
                    text,
                    camera,
                    placement.screen_to_world(anchor),
                    original_angle,
                );
                let screen = project_anchor(camera, world);
                let center = Point::new(screen.x as f32, screen.y as f32);
                // Consecutive text operations are one label, including its
                // wrapped lines and halo. They share a single opacity.
                let mut parts = Vec::new();
                let mut bounds: Option<Rectangle> = None;
                let direction = (angle - original_angle).cos().signum() as f32;
                let mut current = Some(op);
                while let Some(DrawOp::Text {
                    text,
                    at,
                    size,
                    color,
                    font,
                    ..
                }) = current
                {
                    let font = if font.weight.is_some_and(|weight| weight.css() >= 600) {
                        crate::theme::bold(crate::theme::INTER)
                    } else {
                        crate::theme::INTER
                    };
                    let part = canvas::Text {
                        content: text.clone(),
                        position: Point::new(at.x as f32 * direction, at.y as f32 * direction),
                        color: iced::Color::from_rgba(
                            color.r as f32,
                            color.g as f32,
                            color.b as f32,
                            color.a as f32,
                        ),
                        size: (size.min(super::MAX_LABEL_SIZE) as f32).into(),
                        font,
                        shaping: text::Shaping::Advanced,
                        align_x: text::Alignment::Center,
                        align_y: iced::alignment::Vertical::Center,
                        ..canvas::Text::default()
                    };
                    let size = history.measure(&part);
                    let rect = Rectangle::new(
                        Point::new(
                            part.position.x - size.width / 2.0,
                            part.position.y - size.height / 2.0,
                        ),
                        size,
                    );
                    bounds = Some(bounds.map_or(rect, |prior| prior.union(&rect)));
                    parts.push(part);
                    current = ops.next_if(|op| matches!(op, DrawOp::Text { .. }));
                }
                if let Some(bounds) = bounds {
                    let corners = label_corners(bounds, center, angle as f32);
                    let opacity = label_opacity(bounds.width * bounds.height, corners, panel);
                    if opacity <= 0.0 {
                        continue;
                    }
                    for part in &mut parts {
                        part.color.a *= opacity;
                    }
                    if let Some(region) = rounded_clip_region(corners, panel, radius) {
                        draw_clipped_label(
                            frame,
                            parts,
                            center,
                            angle as f32,
                            panel,
                            radius,
                            region,
                        );
                    } else {
                        frame.with_save(|frame| {
                            frame.translate(Vector::new(center.x, center.y));
                            frame.rotate(Radians(angle as f32));
                            for part in parts {
                                frame.fill_text(part);
                            }
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

fn label_corners(bounds: Rectangle, center: Point, angle: f32) -> [Point; 4] {
    let (sin, cos) = angle.sin_cos();
    [
        (bounds.x, bounds.y),
        (bounds.x + bounds.width, bounds.y),
        (bounds.x + bounds.width, bounds.y + bounds.height),
        (bounds.x, bounds.y + bounds.height),
    ]
    .map(|(x, y)| Point::new(center.x + x * cos - y * sin, center.y + x * sin + y * cos))
}

fn label_opacity(area: f32, corners: [Point; 4], panel: Rectangle) -> f32 {
    if corners.iter().all(|p| panel.contains(*p)) {
        return 1.0;
    }
    if area <= 0.0 {
        return 0.0;
    }
    // Clip the rotated label rectangle to the panel to measure its visible
    // area. A screen-aligned bounding box overstates clipping on diagonal roads.
    let mut polygon = corners.to_vec();
    for (axis, edge) in [
        (Vector::new(1.0, 0.0), panel.x),
        (Vector::new(-1.0, 0.0), -(panel.x + panel.width)),
        (Vector::new(0.0, 1.0), panel.y),
        (Vector::new(0.0, -1.0), -(panel.y + panel.height)),
    ] {
        let distance = |p: Point| axis.x * p.x + axis.y * p.y - edge;
        let Some(mut previous) = polygon.last().copied() else {
            return 0.0;
        };
        let mut clipped = Vec::new();
        for point in polygon {
            let a = distance(previous);
            let b = distance(point);
            if (a >= 0.0) != (b >= 0.0) {
                clipped.push(previous + (point - previous) * (a / (a - b)));
            }
            if b >= 0.0 {
                clipped.push(point);
            }
            previous = point;
        }
        polygon = clipped;
    }
    let visible = polygon
        .iter()
        .zip(polygon.iter().cycle().skip(1))
        .map(|(a, b)| a.x * b.y - b.x * a.y)
        .sum::<f32>()
        .abs()
        / (2.0 * area);
    let fade = ((visible - LABEL_VISIBLE_MIN) / (1.0 - LABEL_VISIBLE_MIN)).clamp(0.0, 1.0);
    fade * fade * (3.0 - 2.0 * fade)
}

fn rounded_clip_region(corners: [Point; 4], panel: Rectangle, radius: f32) -> Option<Rectangle> {
    if radius <= 0.0 {
        return None;
    }
    // Include ink overhang outside the font's measured line bounds.
    let left = corners.iter().map(|p| p.x).fold(f32::INFINITY, f32::min) - 3.0;
    let top = corners.iter().map(|p| p.y).fold(f32::INFINITY, f32::min) - 3.0;
    let right = corners
        .iter()
        .map(|p| p.x)
        .fold(f32::NEG_INFINITY, f32::max)
        + 3.0;
    let bottom = corners
        .iter()
        .map(|p| p.y)
        .fold(f32::NEG_INFINITY, f32::max)
        + 3.0;
    let region = Rectangle::new(Point::new(left, top), Size::new(right - left, bottom - top))
        .intersection(&panel)?;
    let inset = radius.min(panel.width.min(panel.height) / 2.0);
    let inside = |x: f32, y: f32| {
        let dx = (inset - x.min(panel.width - x)).max(0.0);
        let dy = (inset - y.min(panel.height - y)).max(0.0);
        dx.hypot(dy) <= inset
    };
    let right = region.x + region.width;
    let bottom = region.y + region.height;
    let crosses_corner = !inside(region.x, region.y)
        || !inside(right, region.y)
        || !inside(region.x, bottom)
        || !inside(right, bottom);
    crosses_corner.then(|| {
        Rectangle::new(
            Point::new(region.x.floor(), region.y.floor()),
            Size::new(
                right.ceil() - region.x.floor(),
                bottom.ceil() - region.y.floor(),
            ),
        )
    })
}

fn draw_clipped_label(
    frame: &mut canvas::Frame,
    parts: Vec<canvas::Text>,
    center: Point,
    angle: f32,
    panel: Rectangle,
    radius: f32,
    region: Rectangle,
) {
    // Only labels that cross a curved corner need an alpha-masked image.
    // Keep that image small enough for the same-frame GPU upload.
    let scale =
        (PIXEL_RATIO as f32).min(MAX_BASEMAP_DIMENSION as f32 / region.width.max(region.height));
    let (width, height) = (
        (region.width * scale).ceil() as u32,
        (region.height * scale).ceil() as u32,
    );
    let (Some(mut pixmap), Some(mut mask)) = (Pixmap::new(width, height), Mask::new(width, height))
    else {
        return;
    };
    let outline = canvas::Path::rounded_rectangle(Point::ORIGIN, panel.size(), radius.into());
    let Some(outline) = glyph_path(&outline) else {
        return;
    };
    let clip_transform = Transform::from_scale(scale, scale).pre_translate(-region.x, -region.y);
    mask.fill_path(&outline, tiny_skia::FillRule::Winding, true, clip_transform);

    let (sin, cos) = angle.sin_cos();
    let text_transform = Transform::from_row(
        scale * cos,
        scale * sin,
        -scale * sin,
        scale * cos,
        (center.x - region.x) * scale,
        (center.y - region.y) * scale,
    );
    for part in parts {
        part.draw_with(|glyph, color| {
            if let Some(glyph) = glyph_path(&glyph) {
                let ink = paint(Color::rgba(
                    color.r.into(),
                    color.g.into(),
                    color.b.into(),
                    color.a.into(),
                ));
                pixmap.fill_path(
                    &glyph,
                    &ink,
                    tiny_skia::FillRule::Winding,
                    text_transform,
                    Some(&mask),
                );
            }
        });
    }
    frame.draw_image(region, canvas::Image::new(rgba_handle(pixmap)));
}

fn glyph_path(path: &canvas::Path) -> Option<Path> {
    use iced::advanced::graphics::geometry::path::lyon_path::PathEvent;
    let mut builder = PathBuilder::new();
    for segment in path.raw().iter() {
        match segment {
            PathEvent::Begin { at } => builder.move_to(at.x, at.y),
            PathEvent::Line { to, .. } => builder.line_to(to.x, to.y),
            PathEvent::Quadratic { ctrl, to, .. } => builder.quad_to(ctrl.x, ctrl.y, to.x, to.y),
            PathEvent::Cubic {
                ctrl1, ctrl2, to, ..
            } => builder.cubic_to(ctrl1.x, ctrl1.y, ctrl2.x, ctrl2.y, to.x, to.y),
            PathEvent::End { close: true, .. } => builder.close(),
            PathEvent::End { close: false, .. } => {}
        }
    }
    builder.finish()
}

fn project_anchor(camera: &Camera, world: MapPoint) -> MapPoint {
    let center = camera.center.to_world();
    let dx = (world.x - center.x + WORLD / 2.0).rem_euclid(WORLD) - WORLD / 2.0;
    camera.turn(camera.world_to_unturned(MapPoint::new(center.x + dx, world.y)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearby_replacement_keeps_the_labels_geographic_anchor() {
        use day_piece_map::camera::LngLat;
        let world = MapPoint::new(256.0, 255.95);
        let size = day_geometry::Size::new(258.0, 258.0);
        let original = Camera::new(LngLat::new(0.0, 0.0), 10.0, size);
        let zoomed = Camera::with_bearing(LngLat::new(0.01, 0.01), 10.25, 35.0, size);
        let mut history = LabelHistory::default();
        history.begin_frame();
        history.remember("Main Street", &original, world, 0.0);
        history.begin_frame();
        let shifted = MapPoint::new(world.x + 0.015, world.y);
        let (retained, _) = history.remember("Main Street", &zoomed, shifted, 0.6);
        assert_eq!(retained, world);
        let actual = project_anchor(&zoomed, retained);
        let expected = zoomed.world_to_screen(world);
        assert!((actual.x - expected.x).hypot(actual.y - expected.y) < 1e-8);
    }

    fn paint_sample(x: f64, y: f64, angle: f64, radius: f32) -> Vec<u8> {
        use day_piece_map::camera::LngLat;
        use iced::widget::{container, Canvas};
        use iced::{mouse, Renderer, Theme};

        struct Sample {
            x: f64,
            y: f64,
            angle: f64,
            radius: f32,
        }
        impl canvas::Program<()> for Sample {
            type State = ();

            fn draw(
                &self,
                _: &(),
                renderer: &Renderer,
                _: &Theme,
                bounds: Rectangle,
                _: mouse::Cursor,
            ) -> Vec<canvas::Geometry> {
                let camera = Camera::new(
                    LngLat::new(0.0, 0.0),
                    3.0,
                    day_geometry::Size::new(120.0, 120.0),
                );
                let placement = Camera::new(
                    camera.center,
                    camera.zoom,
                    day_geometry::Size::new(240.0, 240.0),
                );
                let mut ops = day_pieces::Draw::new();
                ops.concat(
                    Affine::rotate(self.angle)
                        .then(Affine::translate(60.0 + self.x, 60.0 + self.y)),
                );
                ops.text(
                    "Main Street",
                    MapPoint::ZERO,
                    day_pieces::TextStyle {
                        size: 16.0,
                        color: Color::rgba(1.0, 1.0, 1.0, 1.0),
                        anchor: day_spec::TextAnchor::CENTERED,
                        ..Default::default()
                    },
                );
                let mut frame = canvas::Frame::new(renderer, bounds.size());
                labels(
                    &mut frame,
                    ops.ops(),
                    &placement,
                    &camera,
                    self.radius,
                    &mut LabelHistory::default(),
                );
                vec![frame.into_geometry()]
            }
        }

        let clipped = iced::widget::stack![
            iced::widget::Space::new().width(120).height(120),
            Canvas::new(Sample {
                x,
                y,
                angle,
                radius
            })
            .width(120)
            .height(120),
        ]
        .clip(true);
        let element = container(clipped).center(160);
        let mut painter = crate::export::overlay::Painter::new().unwrap();
        painter
            .paint::<()>(element.into(), Size::new(160, 160))
            .rgba
    }

    #[test]
    fn label_fades_at_the_panel_edge_and_hides_when_mostly_clipped() {
        let clipped = paint_sample(31.0, 60.0, 0.0, 0.0);
        let alpha = |x: usize, y: usize| clipped[(y * 160 + x) * 4 + 3];
        assert!((65..95).any(|y| (20..45).any(|x| alpha(x, y) > 30)));
        assert!((0..160).all(|y| (0..20).all(|x| alpha(x, y) == 0)));
        assert!(paint_sample(-4.0, 60.0, 0.0, 0.0)
            .chunks_exact(4)
            .all(|pixel| pixel[3] == 0));
    }

    #[test]
    fn rotated_label_is_masked_at_the_rounded_corner() {
        let radius = 26.0;
        let square = paint_sample(83.0, 109.0, 0.12, 0.0);
        let rounded = paint_sample(83.0, 109.0, 0.12, radius);
        let ink_outside_corner = |rgba: &[u8]| {
            (114usize..140).any(|y| {
                (114usize..140).any(|x| {
                    (x as f32 + 0.5 - 114.0).hypot(y as f32 + 0.5 - 114.0) > radius + 1.0
                        && rgba[(y * 160 + x) * 4 + 3] > 0
                })
            })
        };
        assert!(ink_outside_corner(&square));
        assert!(!ink_outside_corner(&rounded));
        assert!(rounded.chunks_exact(4).any(|pixel| pixel[3] > 180));
    }

    #[test]
    fn opacity_uses_the_visible_fraction_of_a_rotated_label() {
        let panel = Rectangle::with_size(Size::new(120.0, 120.0));
        let text = Rectangle::new(Point::new(-50.0, -8.0), Size::new(100.0, 16.0));
        let opacity = |y| {
            label_opacity(
                text.width * text.height,
                label_corners(text, Point::new(60.0, y), std::f32::consts::FRAC_PI_2),
                panel,
            )
        };
        assert_eq!(opacity(60.0), 1.0);
        assert_eq!(opacity(15.0), 0.0);
        assert!(opacity(30.0) > 0.0 && opacity(30.0) < opacity(40.0) && opacity(40.0) < 1.0);
    }

    #[test]
    fn basemap_fits_in_a_synchronous_gpu_upload() {
        let side = 500.0;
        let handle = basemap(
            &[DrawOp::Fill(
                Shape::Rect(Rect::new(0.0, 0.0, side, side)),
                Paint::Solid(Color::rgba(1.0, 1.0, 1.0, 1.0)),
            )],
            side,
        )
        .unwrap();
        let image::Handle::Rgba {
            width,
            height,
            pixels,
            ..
        } = handle
        else {
            panic!("expected decoded RGBA")
        };
        assert!(pixels.len() < 2 * 1024 * 1024);
        assert_eq!(pixels.len(), (width * height * 4) as usize);
        let center = ((height / 2 * width + width / 2) * 4) as usize;
        assert_eq!(&pixels[center..center + 4], &[255; 4]);
    }

    #[test]
    fn labels_flip_once_when_the_turn_clears_the_vertical_deadband() {
        let mut previous = 85.0_f64.to_radians();
        for degrees in [-89.0_f64, 88.0, -85.0, 87.0, -83.0] {
            previous = stable_angle(previous, degrees.to_radians());
            assert!(previous > 0.0);
        }
        let reversed = stable_angle(previous, -80.0_f64.to_radians());
        assert!(reversed < 0.0);
        let turning_back = stable_angle(reversed, 86.0_f64.to_radians());
        assert!(turning_back < 0.0);
        assert!(stable_angle(turning_back, 80.0_f64.to_radians()) > 0.0);
    }
}
