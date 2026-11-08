//! The playback timeline: a thin grey rail, a white round handle and red
//! event markers.
//!
//! The handle's centre moves between `HANDLE_R` and `width - HANDLE_R`,
//! and a click or drag maps onto that same span, so the handle lands right
//! under the pointer. The pointer stays an arrow.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{tree, Tree, Widget};
use iced::advanced::{mouse, renderer, Clipboard, Shell};
use iced::{Background, Border, Color, Element, Event, Length, Rectangle, Shadow, Size, Vector};

const HANDLE_R: f32 = 7.0;
const RAIL: f32 = 6.0;
const MARKER: f32 = 10.0;
const HEIGHT: f32 = 22.0;

pub struct Timeline<'a, Message> {
    max: f64,
    value: f64,
    markers: Vec<f64>,
    /// Export start and end markers.
    range: (Option<f64>, Option<f64>),
    on_change: Box<dyn Fn(f64) -> Message + 'a>,
    on_release: Option<Message>,
}

impl<'a, Message> Timeline<'a, Message> {
    pub fn new(max: f64, value: f64, on_change: impl Fn(f64) -> Message + 'a) -> Self {
        Self { max, value, markers: Vec::new(), range: (None, None), on_change: Box::new(on_change), on_release: None }
    }

    pub fn on_release(mut self, message: Message) -> Self {
        self.on_release = Some(message);
        self
    }

    /// The export range: a green start bar, a red end bar, and a band
    /// between them when both are set.
    pub fn range(mut self, range: (Option<f64>, Option<f64>)) -> Self {
        self.range = range;
        self
    }

    /// Positions (same units as the value) of red event markers.
    pub fn markers(mut self, markers: Vec<f64>) -> Self {
        self.markers = markers;
        self
    }
}

/// Value under `x`, using the span the handle's centre moves along.
pub fn value_at(x: f32, bounds: Rectangle, max: f64) -> f64 {
    let span = (bounds.width - 2.0 * HANDLE_R).max(1.0);
    let p = ((x - bounds.x - HANDLE_R) / span).clamp(0.0, 1.0);
    p as f64 * max
}

/// The handle's (or a marker's) centre for `value`.
pub fn x_of(value: f64, bounds: Rectangle, max: f64) -> f32 {
    let p = if max > 0.0 { (value / max).clamp(0.0, 1.0) as f32 } else { 0.0 };
    bounds.x + HANDLE_R + p * (bounds.width - 2.0 * HANDLE_R).max(0.0)
}

#[derive(Default)]
struct State {
    dragging: bool,
}

impl<Message: Clone, Theme, Renderer> Widget<Message, Theme, Renderer> for Timeline<'_, Message>
where
    Renderer: iced::advanced::Renderer,
{
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fixed(HEIGHT))
    }

    fn layout(&mut self, _tree: &mut Tree, _renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        layout::atomic(limits, Length::Fill, Length::Fixed(HEIGHT))
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _renderer: &Renderer,
        _clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        let state = tree.state.downcast_mut::<State>();
        let bounds = layout.bounds();
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                if let Some(p) = cursor.position_over(bounds) {
                    state.dragging = true;
                    shell.publish((self.on_change)(value_at(p.x, bounds, self.max)));
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { .. }) if state.dragging => {
                if let Some(p) = cursor.land().position() {
                    shell.publish((self.on_change)(value_at(p.x, bounds, self.max)));
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if state.dragging => {
                state.dragging = false;
                if let Some(m) = self.on_release.clone() {
                    shell.publish(m);
                }
            }
            _ => {}
        }
    }

    fn draw(
        &self,
        _tree: &Tree,
        renderer: &mut Renderer,
        _theme: &Theme,
        _style: &renderer::Style,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _viewport: &Rectangle,
    ) {
        let b = layout.bounds();
        let mid = b.y + b.height / 2.0;
        let quad = |bounds: Rectangle, border: Border, shadow: Shadow| renderer::Quad { bounds, border, shadow, snap: false };

        // Rail (grey, fully rounded).
        renderer.fill_quad(
            quad(
                Rectangle { x: b.x, y: mid - RAIL / 2.0, width: b.width, height: RAIL },
                Border { radius: (RAIL / 2.0).into(), ..Default::default() },
                Shadow::default(),
            ),
            Background::Color(Color { a: 0.16, ..Color::WHITE }),
        );

        // Event markers.
        for &m in &self.markers {
            let cx = x_of(m, b, self.max);
            renderer.fill_quad(
                quad(
                    Rectangle { x: cx - MARKER / 2.0, y: mid - MARKER / 2.0, width: MARKER, height: MARKER },
                    Border { color: Color { a: 0.35, ..Color::WHITE }, width: 1.0, radius: (MARKER / 2.0).into() },
                    Shadow { color: Color::from_rgba(1.0, 0.0, 0.0, 0.35), offset: Vector::ZERO, blur_radius: 10.0 },
                ),
                Background::Color(Color::from_rgba(1.0, 0.0, 0.0, 0.9)),
            );
        }

        // Export range, as earlier versions drew it: a green band between
        // a green start bar and a red end bar (4 x 22 px, glowing).
        let (start, end) = self.range;
        if let (Some(a), Some(z)) = (start, end) {
            let (x0, x1) = (x_of(a.min(z), b, self.max), x_of(a.max(z), b, self.max));
            renderer.fill_quad(
                quad(Rectangle { x: x0, y: mid - 5.0, width: (x1 - x0).max(0.0), height: 10.0 }, Border { radius: 5.0.into(), ..Default::default() }, Shadow::default()),
                Background::Color(Color::from_rgba(0.36, 0.89, 0.51, 0.3)),
            );
        }
        for (m, color) in [(start, Color::from_rgb8(0x34, 0xd3, 0x99)), (end, Color::from_rgb8(0xf8, 0x71, 0x71))] {
            let Some(m) = m else { continue };
            let cx = x_of(m, b, self.max);
            renderer.fill_quad(
                quad(
                    Rectangle { x: cx - 2.0, y: mid - 11.0, width: 4.0, height: 22.0 },
                    Border { radius: 2.0.into(), ..Default::default() },
                    Shadow { color: Color { a: 0.5, ..color }, offset: Vector::ZERO, blur_radius: 8.0 },
                ),
                Background::Color(color),
            );
        }

        // Handle (white, 14 px, with a soft shadow 2 px below).
        let cx = x_of(self.value, b, self.max);
        renderer.fill_quad(
            quad(
                Rectangle { x: cx - HANDLE_R, y: mid - HANDLE_R, width: HANDLE_R * 2.0, height: HANDLE_R * 2.0 },
                Border { radius: HANDLE_R.into(), ..Default::default() },
                Shadow { color: Color::from_rgba(0.0, 0.0, 0.0, 0.3), offset: Vector::new(0.0, 2.0), blur_radius: 6.0 },
            ),
            Background::Color(Color::WHITE),
        );
    }

    fn mouse_interaction(
        &self,
        _tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _viewport: &Rectangle,
        _renderer: &Renderer,
    ) -> mouse::Interaction {
        if cursor.is_over(layout.bounds()) {
            mouse::Interaction::Idle
        } else {
            mouse::Interaction::None
        }
    }
}

impl<'a, Message: Clone + 'a, Theme: 'a, Renderer> From<Timeline<'a, Message>> for Element<'a, Message, Theme, Renderer>
where
    Renderer: iced::advanced::Renderer + 'a,
{
    fn from(t: Timeline<'a, Message>) -> Self {
        Element::new(t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_lands_under_the_handle() {
        let b = Rectangle { x: 100.0, y: 0.0, width: 614.0, height: HEIGHT };
        for x in [107.0f32, 200.0, 407.0, 600.0, 707.0] {
            let v = value_at(x, b, 3600.0);
            assert!((x_of(v, b, 3600.0) - x).abs() < 0.01, "click at {x} drew the handle at {}", x_of(v, b, 3600.0));
        }
        // Past either end clamps.
        assert_eq!(value_at(0.0, b, 60.0), 0.0);
        assert_eq!(value_at(10_000.0, b, 60.0), 60.0);
    }
}
