//! The Tesla Mobile dashboard for export and its editor preview: the frame
//! grows a date bar on top ("Saturday, November 7, 2026   1:05:09 PM")
//! and a data bar at the bottom or top.
//! In the editor each bar can be moved and resized on its own (see
//! export::layout).
//! The data bar: brake and gear in circles at the left, steering wheel
//! and accelerator at the right, and blinkers, speed and the Autopilot
//! state in the middle.

use super::overlay::{DashState, Painter, Picture};
use crate::dashboard::{autopilot_words, gear_letter};
use crate::theme::{medium, semibold, INTER};
use iced::advanced::graphics::text::Paragraph;
use iced::advanced::text::{self, Paragraph as _};
use iced::advanced::svg::Svg;
use iced::widget::canvas::{self, path::Arc, Frame, Path, Stroke, Text};
use iced::widget::{image, svg};
use iced::{mouse, Color, Font, Point, Radians, Rectangle, Renderer, Size, Theme, Vector};
use std::sync::OnceLock;

const BLUE: Color = Color::from_rgb8(0x0b, 0x65, 0xf6);
const GREEN: Color = Color::from_rgb8(62, 233, 4);
const BADGE: Color = Color::from_rgb8(0x19, 0x19, 0x19);
const BRAKE_RED: Color = Color::from_rgb8(0xf1, 0x4c, 0x3b);
const TURN_OFF: Color = Color::from_rgb8(0x4d, 0x4d, 0x4d);
const MUTED: Color = Color::from_rgb8(0x60, 0x60, 0x60);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SignalLight {
    #[default]
    Off,
    Bright,
    Dim,
}

impl SignalLight {
    fn appearance(self) -> (Color, f32) {
        match self {
            Self::Off => (TURN_OFF, 1.0),
            Self::Bright => (GREEN, 1.0),
            Self::Dim => (GREEN, 0.55),
        }
    }
}

/// The registered signal stays on in the SEI while its dashboard icon
/// flashes. The mobile export starts bright at each activation.
#[derive(Default)]
pub struct SignalFlasher {
    started_at: [Option<u128>; 2],
}

impl SignalFlasher {
    pub fn active(telemetry: Option<&crate::sei::SeiMetadata>) -> [bool; 2] {
        telemetry.map_or([false; 2], |m| [m.blinker_on_left, m.blinker_on_right])
    }

    pub fn sample(&mut self, time_ms: u128, active: [bool; 2]) -> [SignalLight; 2] {
        std::array::from_fn(|side| {
            let start = &mut self.started_at[side];
            if !active[side] {
                *start = None;
                return SignalLight::Off;
            }
            let started_at = *start.get_or_insert(time_ms);
            if (time_ms.saturating_sub(started_at) % 1000) < 500 {
                SignalLight::Bright
            } else {
                SignalLight::Dim
            }
        })
    }
}

/// Artwork from the user-supplied Tesla APK is loaded from the local test
/// bundle. Regular builds use the bundled font and silhouettes below.
struct ReferenceResources {
    brake: [image::Handle; 2],
    accelerator: [image::Handle; 2],
    wheel: image::Handle,
    arrows: [svg::Handle; 2],
}

fn reference_resources() -> Option<&'static ReferenceResources> {
    static RESOURCES: OnceLock<Option<ReferenceResources>> = OnceLock::new();
    RESOURCES.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?.parent()?.join("Resources/TeslaMobile");
        let png = |name: &str| Some(image::Handle::from_bytes(std::fs::read(dir.join(name)).ok()?));
        let svg = |name: &str| Some(svg::Handle::from_memory(std::fs::read(dir.join(name)).ok()?));
        let artwork = ReferenceResources {
            brake: [png("brake_pedal_disabled.png")?, png("brake_pedal.png")?],
            accelerator: [png("accelerator_pedal_disabled.png")?, png("accelerator_pedal.png")?],
            wheel: png("round_steering_wheel.png")?,
            arrows: [svg("turn_signal_left.svg")?, svg("turn_signal_right.svg")?],
        };
        let font = std::fs::read(dir.join("universal_sans_text_medium.ttf")).ok()?;
        iced::advanced::graphics::text::font_system().write().ok()?.load_font(font.into());
        Some(artwork)
    }).as_ref()
}

fn bar_font() -> Font {
    if reference_resources().is_some() {
        medium(Font::with_name("Universal Sans Text"))
    } else {
        medium(INTER)
    }
}

fn icon_bounds(x: f32, y: f32, size: f32) -> Rectangle {
    Rectangle::new(Point::new(x - size / 2.0, y - size / 2.0), Size::new(size, size))
}

fn text_width(content: &str, size: f32, font: Font) -> f32 {
    Paragraph::with_text(text::Text {
        content,
        bounds: Size::INFINITE,
        font,
        size: size.into(),
        line_height: text::LineHeight::default(),
        align_x: text::Alignment::Left,
        align_y: iced::alignment::Vertical::Center,
        shaping: text::Shaping::Advanced,
        wrapping: text::Wrapping::None,
    }).min_width()
}

fn even(n: f64) -> u32 {
    let r = n.round() as u32;
    r + r % 2
}

/// The two bars' heights for a frame `width` wide: date W/45, data W/38.
pub fn bar_heights(width: u32) -> (u32, u32) {
    (even(width as f64 / 45.0), even(width as f64 / 38.0))
}

/// "Saturday, November 7, 2026   1:05:09 PM" (in English, as earlier versions wrote it).
pub fn date_line(t: crate::library::LocalSecs, h24: bool) -> String {
    use chrono::Datelike;
    let days = t.div_euclid(86400);
    let date = chrono::NaiveDate::from_num_days_from_ce_opt((days + 719_163) as i32).unwrap_or_default();
    format!("{}, {} {}, {}   {}", date.format("%A"), date.format("%B"), date.day(), date.year(), crate::dashboard::time_of_day(t.rem_euclid(86400), h24))
}

/// The date bar's drawing, at whatever size it's given, its text `.1`
/// times the usual size (the Date Bar Size).
struct Date(String, f32);

impl<M> canvas::Program<M> for Date {
    type State = ();
    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, b: Rectangle, _: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut f = Frame::new(renderer, b.size());
        f.fill_rectangle(Point::ORIGIN, b.size(), Color::BLACK);
        let font = bar_font();
        let size = (b.height * 0.55 * self.1).min(b.height * 0.85);
        let width = text_width(&self.0, size, font);
        let scale = (b.width * 0.94 / width.max(1.0)).min(1.0);
        f.fill_text(Text {
            content: self.0.clone(),
            position: Point::new(b.width / 2.0, b.height / 2.0),
            color: Color::WHITE,
            size: (size * scale).into(),
            font,
            align_x: text::Alignment::Center,
            align_y: iced::alignment::Vertical::Center,
            shaping: text::Shaping::Advanced,
            ..Text::default()
        });
        vec![f.into_geometry()]
    }
}

/// The date bar, filling what it's given (the export, or the editor
/// while it plays); `size`: the Date Bar Size.
pub fn date_bar<'a, M: 'a>(line: String, size: f32) -> iced::Element<'a, M> {
    iced::widget::canvas(Date(line, size)).width(iced::Length::Fill).height(iced::Length::Fill).into()
}

/// The date bar.
pub fn paint_date(painter: &mut Painter, width: u32, height: u32, line: &str, size: f32) -> Picture {
    let c = iced::widget::canvas(Date(line.to_string(), size)).width(width as f32).height(height as f32);
    painter.paint::<()>(c.into(), Size::new(width, height))
}

struct DataBar {
    state: DashState,
    metric: bool,
    /// Label Size (the speed's unit) and Value Size (the speed, gear and
    /// Autopilot words); the circles and icons keep to the bar.
    sizes: (f32, f32),
}

impl<M> canvas::Program<M> for DataBar {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, b: Rectangle, _: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut f = Frame::new(renderer, b.size());
        let (w, h) = (b.width, b.height);
        f.fill_rectangle(Point::ORIGIN, b.size(), Color::BLACK);
        let y = h / 2.0;
        let font = bar_font();
        let emphasis = if reference_resources().is_some() { font } else { semibold(INTER) };
        let text = |f: &mut Frame, content: String, x: f32, size: f32, color: Color, font: Font, align_x| {
            f.fill_text(Text {
                content,
                position: Point::new(x, y),
                color,
                size: size.into(),
                font,
                align_x,
                align_y: iced::alignment::Vertical::Center,
                shaping: text::Shaping::Advanced,
                ..Text::default()
            });
        };
        use text::Alignment::{Center, Left};
        let Some(m) = self.state.telemetry.as_ref() else {
            return vec![f.into_geometry()];
        };

        let diameter = (h * 0.82).min(w * 0.076);
        let radius = diameter / 2.0;
        let (label, value) = self.sizes;
        let brake_x = w * 0.042;
        let gear_x = w * 0.104;
        let steer_x = w - gear_x;
        let accel_x = w - brake_x;
        let fsd = m.autopilot_state == 1;
        let steer_bg = if m.autopilot_state == 2 { BLUE } else { BADGE };
        let brake_bg = if m.brake_applied { BRAKE_RED } else { BADGE };
        for (x, color) in [(brake_x, brake_bg), (gear_x, BADGE), (steer_x, steer_bg), (accel_x, BADGE)] {
            f.fill(&Path::circle(Point::new(x, y), radius), color);
        }

        // The Android renderer reads percent. Versionless legacy samples
        // may still carry the fractional form.
        let raw_pedal = m.accelerator_pedal_position;
        let accel = if m.version == 0 && raw_pedal <= 1.0 { raw_pedal } else { raw_pedal / 100.0 };
        let accel = accel.clamp(0.0, 1.0) as f32;
        let accel_pressed = accel > 0.0;
        if accel_pressed {
            let start = (1.0 - 2.0 * accel).asin();
            let fill = Path::new(|p| {
                p.arc(Arc {
                    center: Point::new(accel_x, y),
                    radius,
                    start_angle: Radians(start),
                    end_angle: Radians(std::f32::consts::PI - start),
                });
                p.close();
            });
            f.fill(&fill, Color::from_rgba8(255, 255, 255, 0.20));
        }

        let steering = Radians((m.steering_wheel_angle as f32).to_radians());
        let artwork = reference_resources();
        if let Some(artwork) = artwork {
            f.draw_image(icon_bounds(brake_x, y, diameter * 20.0 / 24.0), canvas::Image::new(artwork.brake[usize::from(m.brake_applied)].clone()));
            f.draw_image(icon_bounds(accel_x, y, diameter * 22.0 / 24.0), canvas::Image::new(artwork.accelerator[usize::from(accel_pressed)].clone()));
            let wheel = canvas::Image::new(artwork.wheel.clone()).rotation(steering);
            f.draw_image(icon_bounds(steer_x, y, diameter * 20.0 / 24.0), wheel);
        } else {
            draw_icon(&mut f, Point::new(brake_x, y), diameter, |f| {
                f.fill(&brake_pedal(), if m.brake_applied { Color::WHITE } else { MUTED });
            });
            draw_icon(&mut f, Point::new(accel_x, y), diameter, |f| {
                f.fill(&accelerator_pedal(), if accel_pressed { Color::WHITE } else { MUTED });
            });
            draw_icon(&mut f, Point::new(steer_x, y), diameter, |f| {
                f.rotate(steering);
                f.stroke(&Path::circle(Point::ORIGIN, 32.0), Stroke::default().with_width(6.0).with_color(Color::WHITE));
                f.fill(&wheel_spokes(), Color::WHITE);
            });
        }

        let gear = gear_letter(m.gear_state);
        let gear_size = (diameter * 0.61 * value).min(diameter * 0.83);
        text(&mut f, gear.to_string(), gear_x, gear_size, if fsd { BLUE } else { Color::WHITE }, emphasis, Center);

        let (left_x, speed_x, right_x) = if fsd {
            (w * 0.307, w * 0.409, w * 0.693)
        } else {
            (w * 0.396, w * 0.5, w * 0.604)
        };
        for (i, x) in [left_x, right_x].into_iter().enumerate() {
            let (color, opacity) = self.state.mobile_signals[i].appearance();
            if let Some(artwork) = artwork {
                let arrow = Svg::new(artwork.arrows[i].clone()).color(color).opacity(opacity);
                f.draw_svg(icon_bounds(x, y, diameter * 16.0 / 24.0), arrow);
            } else {
                draw_icon(&mut f, Point::new(x, y), diameter, |f| {
                    f.scale_nonuniform(Vector::new(if i == 0 { -1.0 } else { 1.0 }, 1.0));
                    f.fill(&turn_arrow(), color.scale_alpha(opacity));
                });
            }
        }

        // The number and unit have matching typography at default size.
        // Measure both runs so they stay centered together at any setting.
        let mps = m.vehicle_speed_mps.abs();
        let speed = if self.metric { (mps * 3.6).round() } else { (mps * 2.236_936_292_054_402).round() };
        let speed = format!("{speed}");
        let unit = crate::i18n::t(if self.metric { "ui.dashboard.kmh" } else { "ui.dashboard.mph" });
        let base = diameter * 0.60;
        let speed_size = (base * value).min(h * 0.85);
        let unit_size = (base * label).min(h * 0.85);
        let number_width = text_width(&speed, speed_size, font);
        let unit_width = text_width(unit, unit_size, font);
        let gap = diameter * 0.13;
        let speed_width = number_width + gap + unit_width;
        let scale = (w * 0.135 / speed_width).min(1.0);
        let start = speed_x - speed_width * scale / 2.0;
        text(&mut f, speed, start, speed_size * scale, Color::WHITE, font, Left);
        text(&mut f, unit.to_string(), start + (number_width + gap) * scale, unit_size * scale, Color::WHITE, font, Left);

        if fsd {
            let status = autopilot_words(m.autopilot_state);
            let status = if status == "Self Driving" { "Self-Driving" } else { status };
            let status_size = (base * value).min(h * 0.85);
            let status_width = text_width(status, status_size, emphasis);
            let scale = (w * 0.156 / status_width.max(1.0)).min(1.0);
            text(&mut f, status.to_string(), w * 0.58, status_size * scale, BLUE, emphasis, Center);
        }
        vec![f.into_geometry()]
    }
}

// The silhouettes use the mobile export as a visual reference. Their
// coordinate system is centered on a 100-unit badge.
fn draw_icon(f: &mut Frame, center: Point, diameter: f32, draw: impl FnOnce(&mut Frame)) {
    f.with_save(|f| {
        f.translate(Vector::new(center.x, center.y));
        f.scale(diameter / 100.0);
        draw(f);
    });
}

fn brake_pedal() -> Path {
    Path::new(|p| {
        p.move_to(Point::new(-27.0, 2.0));
        p.quadratic_curve_to(Point::new(-28.0, -3.0), Point::new(-22.0, -4.0));
        p.line_to(Point::new(0.0, -4.0));
        p.line_to(Point::new(15.0, -24.0));
        p.quadratic_curve_to(Point::new(18.0, -28.0), Point::new(22.0, -24.0));
        p.line_to(Point::new(12.0, -3.0));
        p.quadratic_curve_to(Point::new(16.0, 0.0), Point::new(15.0, 4.0));
        p.line_to(Point::new(12.0, 24.0));
        p.quadratic_curve_to(Point::new(11.0, 28.0), Point::new(7.0, 28.0));
        p.line_to(Point::new(-20.0, 28.0));
        p.quadratic_curve_to(Point::new(-24.0, 28.0), Point::new(-25.0, 23.0));
        p.close();
    })
}

fn accelerator_pedal() -> Path {
    Path::new(|p| {
        p.move_to(Point::new(-10.0, 28.0));
        p.line_to(Point::new(-10.0, -12.0));
        p.quadratic_curve_to(Point::new(-10.0, -17.0), Point::new(-4.0, -18.0));
        p.line_to(Point::new(-2.0, -29.0));
        p.quadratic_curve_to(Point::new(0.0, -32.0), Point::new(3.0, -28.0));
        p.line_to(Point::new(5.0, -18.0));
        p.quadratic_curve_to(Point::new(10.0, -17.0), Point::new(10.0, -12.0));
        p.line_to(Point::new(10.0, 28.0));
        p.quadratic_curve_to(Point::new(10.0, 31.0), Point::new(7.0, 31.0));
        p.line_to(Point::new(-7.0, 31.0));
        p.quadratic_curve_to(Point::new(-10.0, 31.0), Point::new(-10.0, 28.0));
        p.close();
    })
}

fn wheel_spokes() -> Path {
    Path::new(|p| {
        p.move_to(Point::new(-32.0, 4.0));
        p.bezier_curve_to(Point::new(-25.0, -13.0), Point::new(25.0, -13.0), Point::new(32.0, 4.0));
        p.line_to(Point::new(30.0, 9.0));
        p.bezier_curve_to(Point::new(14.0, 1.0), Point::new(9.0, 15.0), Point::new(6.0, 32.0));
        p.line_to(Point::new(-6.0, 32.0));
        p.bezier_curve_to(Point::new(-9.0, 15.0), Point::new(-14.0, 1.0), Point::new(-30.0, 9.0));
        p.close();
    })
}

fn turn_arrow() -> Path {
    Path::new(|p| {
        p.move_to(Point::new(-30.0, -9.0));
        p.line_to(Point::new(-11.0, -9.0));
        p.line_to(Point::new(-11.0, -26.0));
        p.line_to(Point::new(31.0, 0.0));
        p.line_to(Point::new(-11.0, 26.0));
        p.line_to(Point::new(-11.0, 9.0));
        p.line_to(Point::new(-30.0, 9.0));
        p.close();
    })
}

/// The data bar, filling what it's given; `sizes`: Label Size and Value
/// Size.
pub fn data_bar<'a, M: 'a>(state: DashState, metric: bool, sizes: (f32, f32)) -> iced::Element<'a, M> {
    iced::widget::canvas(DataBar { state, metric, sizes }).width(iced::Length::Fill).height(iced::Length::Fill).into()
}

/// The data bar.
pub fn paint_data(painter: &mut Painter, width: u32, height: u32, state: &DashState, metric: bool, sizes: (f32, f32)) -> Picture {
    let c = iced::widget::canvas(DataBar { state: state.clone(), metric, sizes }).width(width as f32).height(height as f32);
    painter.paint::<()>(c.into(), Size::new(width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_driving_centers_speed_and_fills_the_accelerator_badge() {
        let mut painter = Painter::new().unwrap();
        let state = DashState {
            telemetry: Some(crate::sei::SeiMetadata {
                version: 1,
                gear_state: 1,
                vehicle_speed_mps: 3.0,
                accelerator_pedal_position: 30.0,
                steering_wheel_angle: 44.0,
                ..Default::default()
            }),
            time: String::new(),
            steering: 44.0,
            ..Default::default()
        };
        let picture = paint_data(&mut painter, 724, 42, &state, false, (1.0, 1.0));
        let image = ::image::RgbaImage::from_raw(724, 42, picture.rgba).unwrap();
        if let Some(path) = std::env::var_os("SENTRY_DUMP_MOBILE_MANUAL") {
            image.save(path).unwrap();
        }
        // Manual mode centers the white speed readout and clears the FSD label.
        assert!(image.enumerate_pixels().any(|(x, _, p)| (354..370).contains(&x) && p[0] > 180));
        assert!(image.pixels().all(|p| p[2] <= p[0].saturating_add(10)));
        // The white wheel stays in its badge while turning.
        assert!(image.enumerate_pixels().any(|(x, _, p)| (635..662).contains(&x) && p[0] > 180));
        assert!(image.enumerate_pixels().all(|(x, _, p)| !(465..480).contains(&x) || p[2] == 0));
        // Take samples to the side of the accelerator glyph, inside its badge.
        assert_eq!(image.get_pixel(701, 15)[0], 0x19);
        assert!(image.get_pixel(701, 32)[0] > 45);
    }

    #[test]
    fn signal_starts_bright_and_alternates_every_half_second() {
        use SignalLight::{Bright, Dim, Off};
        let mut flasher = SignalFlasher::default();
        let left = [true, false];
        let both = [true, true];
        let start = 8875;
        assert_eq!(flasher.sample(start, left), [Bright, Off]);
        assert_eq!(flasher.sample(start + 499, left), [Bright, Off]);
        assert_eq!(flasher.sample(start + 500, both), [Dim, Bright]);
        assert_eq!(flasher.sample(start + 999, both), [Dim, Bright]);
        assert_eq!(flasher.sample(start + 1000, [false, true]), [Off, Dim]);
        assert_eq!(flasher.sample(start + 1600, left), [Bright, Off]);
        assert_eq!(flasher.sample(start + 1700, [false; 2]), [Off, Off]);
        assert_eq!(flasher.sample(start + 1800, left), [Bright, Off]);
    }

    #[test]
    fn missing_sei_leaves_a_blank_strip_and_arrows_render_both_brightness_levels() {
        let mut painter = Painter::new().unwrap();
        let mut state = DashState::default();
        let blank = paint_data(&mut painter, 724, 42, &state, false, (1.0, 1.0));
        assert!(blank.rgba.chunks_exact(4).all(|p| p == [0, 0, 0, 255]));

        state.telemetry = Some(crate::sei::SeiMetadata {
            blinker_on_left: true,
            ..Default::default()
        });
        let mut sample = |light| {
            state.mobile_signals[0] = light;
            let picture = paint_data(&mut painter, 724, 42, &state, false, (1.0, 1.0));
            picture.rgba.chunks_exact(4).enumerate().filter(|(i, _)| (276..298).contains(&(i % 724))).map(|(_, p)| p[1]).max().unwrap()
        };
        let bright = sample(SignalLight::Bright);
        let dim = sample(SignalLight::Dim);
        assert!(bright >= 220);
        assert!((120..=135).contains(&dim), "dim arrow green channel: {dim}");
        assert!(sample(SignalLight::Off) <= 80);
    }

    #[test]
    fn bars_and_date_line() {
        // A 6-camera High export (3258 wide): 72 and 86 px bars.
        assert_eq!(bar_heights(3258), (72, 86));
        let t = crate::library::parse_stamp("2026-11-07_13-05-09").unwrap();
        assert_eq!(date_line(t, false), "Saturday, November 7, 2026   1:05:09 PM");
        let mut p = Painter::new().unwrap();
        let state = DashState {
            telemetry: Some(crate::sei::SeiMetadata { gear_state: 1, vehicle_speed_mps: 26.8, autopilot_state: 1, blinker_on_left: true, brake_applied: true, ..Default::default() }),
            time: String::new(),
            steering: 15.0,
            mobile_signals: [SignalLight::Bright, SignalLight::Off],
            ..Default::default()
        };
        let pic = paint_data(&mut p, 3258, 86, &state, false, (1.0, 1.0));
        assert_eq!((pic.width, pic.height), (3258, 86));
        // Opaque bar colour away from everything drawn on it.
        let at = |x: usize, y: usize| pic.rgba[(y * 3258 + x) * 4..(y * 3258 + x) * 4 + 4].to_vec();
        assert_eq!(at(700, 10), vec![0, 0, 0, 255]);
        if let Some(path) = std::env::var_os("SENTRY_DUMP_OVERLAY") {
            ::image::RgbaImage::from_raw(3258, 86, pic.rgba.clone()).unwrap().save(path).unwrap();
        }
        let date = paint_date(&mut p, 3258, 72, &date_line(t, false), 1.0);
        assert_eq!(date.rgba.len(), 3258 * 72 * 4);
    }
}
