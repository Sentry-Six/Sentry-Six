//! The Tesla Mobile dashboard, as earlier versions exported it: the frame
//! grows a date bar on top ("Saturday, November 7, 2026   1:05:09 PM")
//! and a data bar at the bottom or top, dark grey across the whole width.
//! The data bar: brake and gear in circles at the left, steering wheel
//! and accelerator at the right, and blinkers, speed and the Autopilot
//! state in the middle, laid out exactly where Electron's put them.

use super::overlay::{DashState, Painter, Picture};
use crate::dashboard::{autopilot_words, gear_letter, icon_set, BLUE};
use iced::widget::canvas::{self, Frame, Path, Text};
use iced::{mouse, Color, Point, Radians, Rectangle, Renderer, Size, Theme};

const BAR: Color = Color { r: 0x1a as f32 / 255.0, g: 0x1a as f32 / 255.0, b: 0x1a as f32 / 255.0, a: 1.0 };
const LINE: Color = Color { r: 0x33 as f32 / 255.0, g: 0x33 as f32 / 255.0, b: 0x33 as f32 / 255.0, a: 1.0 };
const GREEN: Color = Color { r: 0x34 as f32 / 255.0, g: 0xd3 as f32 / 255.0, b: 0x99 as f32 / 255.0, a: 1.0 };

fn grey(v: u8) -> Color {
    Color::from_rgb8(v, v, v)
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

/// The date bar's drawing, at whatever size it's given.
struct Date(String);

impl<M> canvas::Program<M> for Date {
    type State = ();
    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, b: Rectangle, _: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut f = Frame::new(renderer, b.size());
        f.fill_rectangle(Point::ORIGIN, b.size(), BAR);
        f.fill_rectangle(Point::new(0.0, b.height - 1.0), Size::new(b.width, 1.0), LINE);
        f.fill_text(Text {
            content: self.0.to_string(),
            position: Point::new(b.width / 2.0, b.height / 2.0),
            color: Color::WHITE,
            size: (b.height * 0.55).into(),
            font: crate::theme::INTER,
            align_x: iced::widget::text::Alignment::Center,
            align_y: iced::alignment::Vertical::Center,
            ..Text::default()
        });
        vec![f.into_geometry()]
    }
}

/// The date bar, filling what it's given (the export, or the editor
/// while it plays).
pub fn date_bar<'a, M: 'a>(line: String) -> iced::Element<'a, M> {
    iced::widget::canvas(Date(line)).width(iced::Length::Fill).height(iced::Length::Fill).into()
}

/// The date bar.
pub fn paint_date(painter: &mut Painter, width: u32, height: u32, line: &str) -> Picture {
    let c = iced::widget::canvas(Date(line.to_string())).width(width as f32).height(height as f32);
    painter.paint::<()>(c.into(), Size::new(width, height))
}

struct DataBar {
    state: DashState,
    metric: bool,
    /// The separator on the bar's top edge (bar at the bottom) or bottom.
    line_on_top: bool,
}

impl<M> canvas::Program<M> for DataBar {
    type State = ();

    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, b: Rectangle, _: mouse::Cursor) -> Vec<canvas::Geometry> {
        let mut f = Frame::new(renderer, b.size());
        let (w, h) = (b.width, b.height);
        f.fill_rectangle(Point::ORIGIN, b.size(), BAR);
        f.fill_rectangle(Point::new(0.0, if self.line_on_top { 0.0 } else { h - 1.0 }), Size::new(w, 1.0), LINE);
        let y = h / 2.0;
        let text = |f: &mut Frame, s: String, x: f32, size: f32, color: Color, align: iced::widget::text::Alignment, bold: bool| {
            f.fill_text(Text {
                content: s,
                position: Point::new(x, y),
                color,
                size: size.into(),
                font: if bold { crate::theme::bold(crate::theme::INTER) } else { crate::theme::INTER },
                align_x: align,
                align_y: iced::alignment::Vertical::Center,
                ..Text::default()
            });
        };
        use iced::widget::text::Alignment::{Center, Left, Right};
        let Some(m) = self.state.telemetry.as_ref() else {
            text(&mut f, crate::i18n::t("app.parked").to_string(), w / 2.0, h * 0.45, Color::WHITE, Center, true);
            return vec![f.into_geometry()];
        };
        // Electron's layout.
        let r = (h * 0.38).round();
        let diam = r * 2.0;
        let gap = (r * 0.5).round();
        let edge = (w * 0.03).round();
        let brake_x = edge + r;
        let gear_x = edge + diam + gap + r;
        let accel_x = w - edge - r;
        let steer_x = w - edge - diam - gap - r;
        let spacing = w * 0.32 / 3.0;
        let cx = w / 2.0;
        let (left_x, speed_x, ap_x, right_x) = (cx - spacing * 1.5, cx - spacing * 0.5, cx + spacing * 0.5, cx + spacing * 1.5);
        let icons = icon_set();
        let ap_on = matches!(m.autopilot_state, 1 | 2);
        let circle = |f: &mut Frame, x: f32, color: Color| f.fill(&Path::circle(Point::new(x, y), r), color);
        let image = |f: &mut Frame, x: f32, size: f32, handle: &iced::widget::image::Handle, turn: f32| {
            f.draw_image(Rectangle::new(Point::new(x - size / 2.0, y - size / 2.0), Size::new(size, size)), canvas::Image::new(handle.clone()).rotation(Radians(turn.to_radians())));
        };

        // Brake: dark red when pressed.
        circle(&mut f, brake_x, if m.brake_applied { Color::from_rgb8(0x50, 0, 0) } else { grey(0x30) });
        image(&mut f, brake_x, diam * 0.6, if m.brake_applied { &icons.brake_on } else { &icons.brake_off }, 0.0);
        // Gear: blue under Autopilot.
        circle(&mut f, gear_x, if ap_on { BLUE } else { grey(0x40) });
        text(&mut f, gear_letter(m.gear_state).to_string(), gear_x, diam * 0.70, Color::WHITE, Center, true);
        // Blinkers (on for the first 400 of 700 ms).
        let blink = self.state.blink_ms < 400;
        for (on, x, handle) in [(m.blinker_on_left, left_x, &icons.blink_left), (m.blinker_on_right, right_x, &icons.blink_right)] {
            let lit = on && blink;
            let size = diam * 0.9;
            // The icons are 200 x 175: drawn in a box that shape (in a
            // square one their tips were cut off).
            let width = size * 200.0 / 175.0;
            f.draw_svg(
                Rectangle::new(Point::new(x - width / 2.0, y - size / 2.0), Size::new(width, size)),
                iced::advanced::svg::Svg::new(handle.clone()).color(if lit { GREEN } else { grey(0x40) }),
            );
        }
        // Speed and its unit.
        let mps = m.vehicle_speed_mps.abs();
        let speed = if self.metric { (mps * 3.6).round() } else { (mps * 2.236_936_292_054_402).round() };
        let unit = crate::i18n::t(if self.metric { "ui.dashboard.kmh" } else { "ui.dashboard.mph" });
        let speed_gap = diam * 0.08;
        text(&mut f, format!("{speed}"), speed_x - speed_gap, (diam * 0.95).min(h * 0.85), Color::WHITE, Right, true);
        text(&mut f, unit.to_string(), speed_x + speed_gap, (diam * 0.65).min(h * 0.85), grey(0x80), Left, false);
        // Autopilot state.
        text(&mut f, autopilot_words(m.autopilot_state).to_string(), ap_x, (diam * 0.65).min(h * 0.85), if ap_on { BLUE } else { grey(0x80) }, Center, false);
        // Steering wheel, turned.
        image(&mut f, steer_x, diam, if ap_on { &icons.wheel_on } else { &icons.wheel_off }, self.state.steering);
        // Accelerator: lighter when pressed past 5%.
        let accel = if m.accelerator_pedal_position > 1.0 { m.accelerator_pedal_position } else { m.accelerator_pedal_position * 100.0 };
        circle(&mut f, accel_x, if accel > 5.0 { grey(0x50) } else { grey(0x30) });
        image(&mut f, accel_x, diam * 0.6, if accel > 5.0 { &icons.accel_on } else { &icons.accel_off }, 0.0);
        vec![f.into_geometry()]
    }
}

/// The data bar, filling what it's given.
pub fn data_bar<'a, M: 'a>(state: DashState, metric: bool, line_on_top: bool) -> iced::Element<'a, M> {
    iced::widget::canvas(DataBar { state, metric, line_on_top }).width(iced::Length::Fill).height(iced::Length::Fill).into()
}

/// The data bar.
pub fn paint_data(painter: &mut Painter, width: u32, height: u32, state: &DashState, metric: bool, line_on_top: bool) -> Picture {
    let c = iced::widget::canvas(DataBar { state: state.clone(), metric, line_on_top }).width(width as f32).height(height as f32);
    painter.paint::<()>(c.into(), Size::new(width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bars_and_date_as_electron() {
        // A 6-camera High export (3258 wide): 72 and 86 px bars.
        assert_eq!(bar_heights(3258), (72, 86));
        let t = crate::library::parse_stamp("2026-11-07_13-05-09").unwrap();
        assert_eq!(date_line(t, false), "Saturday, November 7, 2026   1:05:09 PM");
        let mut p = Painter::new().unwrap();
        let state = DashState {
            telemetry: Some(crate::sei::SeiMetadata { gear_state: 1, vehicle_speed_mps: 26.8, autopilot_state: 1, blinker_on_left: true, brake_applied: true, ..Default::default() }),
            time: String::new(),
            steering: 15.0,
            blink_ms: 0,
        };
        let pic = paint_data(&mut p, 3258, 86, &state, false, true);
        assert_eq!((pic.width, pic.height), (3258, 86));
        // Opaque bar colour away from everything drawn on it.
        let at = |x: usize, y: usize| pic.rgba[(y * 3258 + x) * 4..(y * 3258 + x) * 4 + 4].to_vec();
        assert_eq!(at(700, 10), vec![0x1a, 0x1a, 0x1a, 255]);
        if let Some(path) = std::env::var_os("SENTRY_DUMP_OVERLAY") {
            ::image::RgbaImage::from_raw(3258, 86, pic.rgba.clone()).unwrap().save(path).unwrap();
        }
        let date = paint_date(&mut p, 3258, 72, &date_line(t, false));
        assert_eq!(date.rgba.len(), 3258 * 72 * 4);
    }
}
