//! Mouse input on a camera tile, the map panel or the floating dashboard:
//! click (focus), drag (pan when zoomed, or move the panel) and the scroll
//! wheel (zoom). The content is drawn as is.
//!
//! A press that moves less than a few pixels before release is a click; a
//! longer move is a drag and reports its movement instead. Trackpads send
//! many small pixel deltas, so those are added up into wheel steps.

use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{tree, Operation, Tree, Widget};
use iced::advanced::{mouse, overlay, renderer, Clipboard, Shell};
use iced::{Element, Event, Length, Point, Rectangle, Size, Vector};

/// Movement (logical px) before a press counts as a drag.
const DRAG_START: f32 = 4.0;
/// Trackpad scroll (logical px) per wheel step.
const PIXELS_PER_STEP: f32 = 40.0;

pub struct TileInput<'a, Message, Theme, Renderer> {
    content: Element<'a, Message, Theme, Renderer>,
    on_click: Option<Message>,
    on_drag: Option<Box<dyn Fn(f32, f32) -> Message + 'a>>,
    on_wheel: Option<Box<dyn Fn(i32) -> Message + 'a>>,
    /// Where the pointer is while dragging (window coordinates), and where
    /// it was let go: for dragging a camera onto another.
    on_drag_to: Option<Box<dyn Fn(Point) -> Message + 'a>>,
    on_drop_at: Option<Box<dyn Fn(Point) -> Message + 'a>>,
    grab: bool,
}

pub fn tile_input<'a, Message, Theme, Renderer>(
    content: impl Into<Element<'a, Message, Theme, Renderer>>,
) -> TileInput<'a, Message, Theme, Renderer> {
    TileInput { content: content.into(), on_click: None, on_drag: None, on_wheel: None, on_drag_to: None, on_drop_at: None, grab: false }
}

impl<'a, Message, Theme, Renderer> TileInput<'a, Message, Theme, Renderer> {
    pub fn on_click(mut self, m: Message) -> Self {
        self.on_click = Some(m);
        self
    }
    /// Called with the movement since the last call (logical px).
    pub fn on_drag(mut self, f: impl Fn(f32, f32) -> Message + 'a) -> Self {
        self.on_drag = Some(Box::new(f));
        self
    }
    /// Called with the wheel's steps: +1 per step scrolled up (zoom in), -1
    /// down.
    pub fn on_wheel(mut self, f: impl Fn(i32) -> Message + 'a) -> Self {
        self.on_wheel = Some(Box::new(f));
        self
    }
    pub fn on_drag_to(mut self, f: impl Fn(Point) -> Message + 'a) -> Self {
        self.on_drag_to = Some(Box::new(f));
        self
    }
    pub fn on_drop_at(mut self, f: impl Fn(Point) -> Message + 'a) -> Self {
        self.on_drop_at = Some(Box::new(f));
        self
    }
    /// Show the grab hand (the picture can be panned).
    pub fn grab(mut self, grab: bool) -> Self {
        self.grab = grab;
        self
    }
}

#[derive(Default)]
struct State {
    pressed_at: Option<Point>,
    last: Option<Point>,
    dragging: bool,
    scroll: f32,
}

impl<Message: Clone, Theme, Renderer> Widget<Message, Theme, Renderer> for TileInput<'_, Message, Theme, Renderer>
where
    Renderer: iced::advanced::Renderer,
{
    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) -> layout::Node {
        self.content.as_widget_mut().layout(&mut tree.children[0], renderer, limits)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.as_widget().draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport)
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(&self.content)]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_ref(&self.content));
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout<'_>, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.as_widget_mut().operate(&mut tree.children[0], layout, renderer, operation)
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        self.content
            .as_widget_mut()
            .update(&mut tree.children[0], event, layout, cursor, renderer, clipboard, shell, viewport);
        if shell.is_event_captured() {
            return;
        }
        let state = tree.state.downcast_mut::<State>();
        let bounds = layout.bounds();
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                if let Some(p) = cursor.position_over(bounds) {
                    state.pressed_at = Some(p);
                    state.last = Some(p);
                    state.dragging = false;
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) => {
                if let (Some(start), Some(last)) = (state.pressed_at, state.last) {
                    if !state.dragging && start.distance(*position) >= DRAG_START {
                        state.dragging = true;
                    }
                    if state.dragging {
                        if let Some(f) = &self.on_drag {
                            shell.publish(f(position.x - last.x, position.y - last.y));
                        }
                        if let Some(f) = &self.on_drag_to {
                            shell.publish(f(*position));
                        }
                        state.last = Some(*position);
                        shell.capture_event();
                    }
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) if state.pressed_at.take().is_some() => {
                if !state.dragging && cursor.is_over(bounds) {
                    if let Some(m) = self.on_click.clone() {
                        shell.publish(m);
                    }
                }
                if state.dragging {
                    if let (Some(f), Some(p)) = (&self.on_drop_at, state.last) {
                        shell.publish(f(p));
                    }
                }
                state.dragging = false;
                state.last = None;
                shell.capture_event();
            }
            Event::Mouse(mouse::Event::WheelScrolled { delta }) if cursor.is_over(bounds) => {
                let Some(f) = &self.on_wheel else { return };
                let steps = match delta {
                    // (A sideways tilt has y = 0, whose signum is 1.)
                    mouse::ScrollDelta::Lines { y, .. } if *y == 0.0 => 0,
                    mouse::ScrollDelta::Lines { y, .. } => y.signum() as i32,
                    mouse::ScrollDelta::Pixels { y, .. } => {
                        state.scroll += y;
                        let n = (state.scroll / PIXELS_PER_STEP).trunc();
                        state.scroll -= n * PIXELS_PER_STEP;
                        n as i32
                    }
                };
                if steps != 0 {
                    shell.publish(f(steps));
                }
                shell.capture_event();
            }
            _ => {}
        }
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _viewport: &Rectangle,
        _renderer: &Renderer,
    ) -> mouse::Interaction {
        let state = tree.state.downcast_ref::<State>();
        if !cursor.is_over(layout.bounds()) && !state.dragging {
            mouse::Interaction::None
        } else if self.grab && state.dragging {
            mouse::Interaction::Grabbing
        } else if self.grab {
            mouse::Interaction::Grab
        } else {
            mouse::Interaction::Idle
        }
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout<'b>,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
    ) -> Option<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content
            .as_widget_mut()
            .overlay(&mut tree.children[0], layout, renderer, viewport, translation)
    }
}

impl<'a, Message: Clone + 'a, Theme: 'a, Renderer> From<TileInput<'a, Message, Theme, Renderer>>
    for Element<'a, Message, Theme, Renderer>
where
    Renderer: iced::advanced::Renderer + 'a,
{
    fn from(w: TileInput<'a, Message, Theme, Renderer>) -> Self {
        Element::new(w)
    }
}
