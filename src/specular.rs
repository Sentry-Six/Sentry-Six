//! The specular rim of the card material (white at 0.22 alpha): a bright
//! 1 px line just inside the top border that follows the rounded corners
//! and fades out down the sides.
//! Drawn as the rounded border of a box 1 px inside the button, in three
//! layers clipped ever closer to the top, so it is brightest along the
//! top edge and tapers into the corner curves.

use iced::advanced::layout::{self, Layout};
use iced::advanced::renderer::{self, Quad};
use iced::advanced::widget::{Tree, Widget};
use iced::{mouse, Border, Color, Element, Length, Rectangle, Size};

pub struct Specular {
    radius: f32,
}

pub fn specular(radius: f32) -> Specular {
    Specular { radius }
}

/// (alpha, share of the corner radius it reaches down); the alphas add up
/// to 0.22 along the top.
const LAYERS: [(f32, f32); 3] = [(0.08, 0.9), (0.07, 0.55), (0.07, 0.25)];

impl<M, Theme, R: renderer::Renderer> Widget<M, Theme, R> for Specular {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn layout(&mut self, _tree: &mut Tree, _renderer: &R, limits: &layout::Limits) -> layout::Node {
        layout::atomic(limits, Length::Fill, Length::Fill)
    }

    fn draw(
        &self,
        _tree: &Tree,
        renderer: &mut R,
        _theme: &Theme,
        _style: &renderer::Style,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _viewport: &Rectangle,
    ) {
        let b = layout.bounds();
        if b.width < 4.0 || b.height < 4.0 {
            return;
        }
        let inner = Rectangle { x: b.x + 1.0, y: b.y + 1.0, width: b.width - 2.0, height: b.height - 2.0 };
        let r = (self.radius - 1.0).max(0.0);
        for (alpha, reach) in LAYERS {
            let clip = Rectangle { height: (r * reach).max(2.0), ..b };
            renderer.with_layer(clip, |renderer| {
                renderer.fill_quad(
                    Quad {
                        bounds: inner,
                        border: Border { color: Color { a: alpha, ..Color::WHITE }, width: 1.0, radius: r.into() },
                        ..Quad::default()
                    },
                    Color::TRANSPARENT,
                );
            });
        }
    }
}

impl<'a, M: 'a, Theme: 'a, R: renderer::Renderer + 'a> From<Specular> for Element<'a, M, Theme, R> {
    fn from(s: Specular) -> Self {
        Element::new(s)
    }
}
