//! Replay the map style's geometry to a cached bitmap and its label positions
//! to the Iced canvas. The label pass uses screen coordinates.

use day_geometry::{Affine, Color, Rect};
use day_spec::{DrawOp, FillRule, LineCap, LineJoin, Paint, PathSeg, Shape};
use iced::widget::{canvas, image, text};
use iced::{Point, Radians, Size, Vector};
use std::rc::Rc;
use tiny_skia::{Mask, Path, PathBuilder, Pixmap, Transform};

const PIXEL_RATIO: f32 = 2.0;

pub(super) fn basemap(ops: &[DrawOp], side: f64) -> Option<image::Handle> {
    let dimension = (side as f32 * PIXEL_RATIO).ceil() as u32;
    let mut pixmap = Pixmap::new(dimension, dimension)?;
    let transform = Transform::from_scale(PIXEL_RATIO, PIXEL_RATIO);
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

    let mut pixels = pixmap.take();
    for rgba in pixels.chunks_exact_mut(4) {
        if let 1..=254 = rgba[3] {
            let alpha = u16::from(rgba[3]);
            for channel in &mut rgba[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha) as u8;
            }
        }
    }
    Some(image::Handle::from_rgba(dimension, dimension, pixels))
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

pub(super) fn labels(frame: &mut canvas::Frame, ops: &[DrawOp], bounds: Size, radius: f32) {
    let mut transform = Affine::IDENTITY;
    let mut stack = Vec::new();
    for op in ops {
        match op {
            DrawOp::Save => stack.push(transform),
            DrawOp::Restore => transform = stack.pop().unwrap_or(Affine::IDENTITY),
            DrawOp::Concat(next) => transform = next.then(transform),
            DrawOp::Text {
                text,
                at,
                size,
                color,
                font,
                ..
            } => {
                let pos = transform.apply(*at);
                let (x, y) = (pos.x as f32, pos.y as f32);
                // Avoid drawing labels into the curved corners of the panel.
                let dx = (radius - x.min(bounds.width - x)).max(0.0);
                let dy = (radius - y.min(bounds.height - y)).max(0.0);
                if dx.hypot(dy) > radius {
                    continue;
                }
                frame.with_save(|frame| {
                    frame.translate(Vector::new(x, y));
                    let angle = transform.b.atan2(transform.a) as f32;
                    frame.rotate(Radians(angle));
                    let color = iced::Color::from_rgba(
                        color.r as f32,
                        color.g as f32,
                        color.b as f32,
                        color.a as f32,
                    );
                    let font = if font.weight.is_some_and(|weight| weight.css() >= 600) {
                        crate::theme::bold(crate::theme::INTER)
                    } else {
                        crate::theme::INTER
                    };
                    frame.fill_text(canvas::Text {
                        content: text.clone(),
                        position: Point::ORIGIN,
                        color,
                        size: (*size as f32).into(),
                        font,
                        shaping: text::Shaping::Advanced,
                        align_x: text::Alignment::Center,
                        align_y: iced::alignment::Vertical::Center,
                        ..canvas::Text::default()
                    });
                });
            }
            _ => {}
        }
    }
}
