//! The loading spinner: a 48 px ring, faint all round with a green
//! quarter turning once every 0.8 s.

use iced::mouse;
use iced::widget::canvas::{self, path::Arc, Frame, Path, Stroke};
use iced::{Color, Radians, Rectangle, Renderer, Theme};

pub struct Spinner {
    /// Seconds since some fixed moment (drives the turn).
    pub t: f32,
}

impl<Message> canvas::Program<Message> for Spinner {
    type State = ();

    fn draw(&self, _state: &(), renderer: &Renderer, _theme: &Theme, bounds: Rectangle, _cursor: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut frame = Frame::new(renderer, bounds.size());
        let center = frame.center();
        let radius = bounds.width.min(bounds.height) / 2.0 - 1.5;
        let ring = Path::circle(center, radius);
        frame.stroke(&ring, Stroke::default().with_width(3.0).with_color(Color { a: 0.15, ..Color::WHITE }));
        let start = (self.t / 0.8).fract() * std::f32::consts::TAU;
        let arc = Path::new(|b| {
            b.arc(Arc { center, radius, start_angle: Radians(start), end_angle: Radians(start + std::f32::consts::FRAC_PI_2) });
        });
        frame.stroke(&arc, Stroke::default().with_width(3.0).with_color(Color { a: 0.9, ..crate::theme::ACCENT }));
        vec![frame.into_geometry()]
    }
}
