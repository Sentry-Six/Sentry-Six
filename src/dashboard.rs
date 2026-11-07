//! The compact dashboard on the front camera: brake, gear, blinkers, speed,
//! Autopilot state with the recording time, steering wheel, accelerator.
//! While there is no telemetry (parked), it shows PARKED and the time.
//!
//! The PNG icons are grey at 50% when off, a red brake and a fill rising in
//! the accelerator. iced has no image filters, so each look is made once,
//! the first time the dashboard is drawn, by recolouring the pixels.

use crate::telemetry::SeiMetadata;
use crate::theme;
use iced::widget::{button, canvas, column, container, image, row, svg, text, Space};
use iced::{Alignment, Color, Element, Length, Point, Radians, Rectangle, Renderer, Theme};
use std::sync::OnceLock;

/// The dashboard's blue accent.
pub const BLUE: Color = Color { r: 0.0, g: 72.0 / 255.0, b: 1.0, a: 1.0 };
const GREEN: Color = Color { r: 0x34 as f32 / 255.0, g: 0xd3 as f32 / 255.0, b: 0x99 as f32 / 255.0, a: 1.0 };
const BRAKE_RED: Color = Color { r: 235.0 / 255.0, g: 25.0 / 255.0, b: 25.0 / 255.0, a: 1.0 };
const ICON_PX: u32 = 64;
/// Accelerator fill levels (0%, 5%, ... 100%).
const FILL_STEPS: usize = 20;

/// The accelerator pedal's colour when pressed: white (85%) in the compact
/// dashboard, blue in the full one.
const PEDAL_BLUE: Color = Color { r: 40.0 / 255.0, g: 130.0 / 255.0, b: 1.0, a: 1.0 };
const PEDAL_WHITE: Color = Color { r: 0.85, g: 0.85, b: 0.85, a: 1.0 };

/// The Accelerator Display setting (`accelPedMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccelMode {
    /// The pedal lights up when pressed.
    Solid,
    /// The pedal fills from the bottom with the pedal position.
    IconBar,
    /// A lit pedal and a thin bar beside it.
    SideBar,
}

impl AccelMode {
    pub const ALL: [AccelMode; 3] = [AccelMode::Solid, AccelMode::IconBar, AccelMode::SideBar];

    pub fn key(self) -> &'static str {
        match self {
            AccelMode::Solid => "solid",
            AccelMode::IconBar => "iconbar",
            AccelMode::SideBar => "sidebar",
        }
    }

    pub fn from_key(k: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.key() == k)
    }

    pub fn label(self) -> &'static str {
        crate::i18n::t(match self {
            AccelMode::Solid => "ui.settings.solidColor",
            AccelMode::IconBar => "ui.settings.iconBar",
            AccelMode::SideBar => "ui.settings.sideBar",
        })
    }
}

/// The pedal drawn in one colour: all of it (lit) and filled to each level.
struct Pedal {
    on: image::Handle,
    fill: Vec<image::Handle>,
}

struct Icons {
    brake_off: image::Handle,
    brake_on: image::Handle,
    wheel_off: image::Handle,
    wheel_on: image::Handle,
    accel_off: image::Handle,
    white: Pedal,
    blue: Pedal,
    blink_left: svg::Handle,
    blink_right: svg::Handle,
}

fn decode(png: &[u8]) -> ::image::RgbaImage {
    let img = ::image::load_from_memory_with_format(png, ::image::ImageFormat::Png).expect("bundled icon").to_rgba8();
    ::image::imageops::resize(&img, ICON_PX, ICON_PX, ::image::imageops::FilterType::CatmullRom)
}

fn handle(img: &::image::RgbaImage) -> image::Handle {
    image::Handle::from_rgba(img.width(), img.height(), img.as_raw().clone())
}

/// An icon that is off: fully grey, at 60% brightness and 50% opacity.
fn dimmed(img: &::image::RgbaImage) -> ::image::RgbaImage {
    let mut out = img.clone();
    for p in out.pixels_mut() {
        let l = 0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32;
        let g = (l * 0.6).round() as u8;
        *p = ::image::Rgba([g, g, g, p[3] / 2]);
    }
    out
}

/// The silhouette in one colour, keeping its alpha.
fn tinted(img: &::image::RgbaImage, c: Color) -> ::image::RgbaImage {
    let mut out = img.clone();
    let [r, g, b, _] = c.into_rgba8();
    for p in out.pixels_mut() {
        *p = ::image::Rgba([r, g, b, p[3]]);
    }
    out
}

fn icons() -> &'static Icons {
    static ICONS: OnceLock<Icons> = OnceLock::new();
    ICONS.get_or_init(|| {
        let brake = decode(include_bytes!("../assets/dashboard/pedal_brake.png"));
        let wheel = decode(include_bytes!("../assets/dashboard/autosteer-icon.png"));
        let accel = decode(include_bytes!("../assets/dashboard/pedal_acc.png"));
        let accel_off = dimmed(&accel);
        // The lit pedal revealed from the bottom over the dimmed one.
        let pedal = |color: Color| {
            let lit = tinted(&accel, color);
            let fill = (0..=FILL_STEPS)
                .map(|step| {
                    let visible_from = ICON_PX - (ICON_PX as usize * step / FILL_STEPS) as u32;
                    let mut img = accel_off.clone();
                    for y in visible_from..ICON_PX {
                        for x in 0..ICON_PX {
                            let f = lit.get_pixel(x, y);
                            if f[3] > 0 {
                                img.put_pixel(x, y, *f);
                            }
                        }
                    }
                    handle(&img)
                })
                .collect();
            Pedal { on: handle(&lit), fill }
        };
        let white = pedal(PEDAL_WHITE);
        let blue = pedal(PEDAL_BLUE);
        Icons {
            brake_off: handle(&dimmed(&brake)),
            brake_on: handle(&tinted(&brake, BRAKE_RED)),
            wheel_off: handle(&dimmed(&wheel)),
            wheel_on: handle(&wheel),
            accel_off: handle(&accel_off),
            white,
            blue,
            blink_left: svg::Handle::from_memory(include_bytes!("../assets/dashboard/blinker_left.svg").as_slice()),
            blink_right: svg::Handle::from_memory(include_bytes!("../assets/dashboard/blinker_right.svg").as_slice()),
        }
    })
}

/// What the dashboard shows for this frame.
pub struct Dash<'a> {
    pub telemetry: Option<&'a SeiMetadata>,
    /// Recording time ("4:25:43 AM").
    pub time: String,
    pub metric: bool,
    pub playing: bool,
    /// Milliseconds into the 700 ms blinker cycle.
    pub blink_ms: u128,
    /// 1.0 for a ~650 px wide tile; smaller tiles shrink everything.
    pub scale: f32,
    pub accel: AccelMode,
    /// The steering wheel's angle, eased towards the telemetry's.
    pub steering: f32,
}

fn gear_label(g: i32) -> &'static str {
    match g {
        0 => crate::i18n::t("app.gearPark"),
        1 => crate::i18n::t("app.gearDrive"),
        2 => crate::i18n::t("app.gearReverse"),
        3 => crate::i18n::t("app.gearNeutral"),
        _ => "--",
    }
}

fn autopilot_label(a: i32) -> &'static str {
    match a {
        1 => crate::i18n::t("ui.dashboard.selfDriving"),
        2 => crate::i18n::t("ui.dashboard.autosteer"),
        3 => crate::i18n::t("ui.dashboard.tacc"),
        _ => crate::i18n::t("ui.dashboard.manual"),
    }
}

/// 12-hour (default) or 24-hour time of day.
pub fn time_of_day(secs_of_day: i64, h24: bool) -> String {
    let t = secs_of_day.rem_euclid(86400);
    let (h, m, s) = (t / 3600, t / 60 % 60, t % 60);
    if h24 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{}:{m:02}:{s:02} {}", if h % 12 == 0 { 12 } else { h % 12 }, if h >= 12 { "PM" } else { "AM" })
    }
}

pub fn compact<'a, M: 'a>(d: Dash<'_>) -> Element<'a, M> {
    let icons = icons();
    let sc = d.scale;
    let icon_px = 28.0 * sc;
    let gap = || Space::new().width(Length::Fill);

    let Some(sei) = d.telemetry else {
        // Parked: gauges hidden, PARKED next to the time.
        return row![
            gap(),
            text(crate::i18n::t("app.parked")).size(20.0 * sc).font(theme::bold(theme::INTER)).color(Color::WHITE),
            text(d.time).size(15.0 * sc).font(theme::medium(theme::INTER)).color(theme::TEXT_SECONDARY),
            gap(),
        ]
        .spacing(16.0 * sc)
        .align_y(Alignment::Center)
        .height(Length::Fill)
        .into();
    };

    let autopilot_on = matches!(sei.autopilot_state, 1 | 2);
    let mps = sei.vehicle_speed_mps.abs();
    let speed = if d.metric { (mps * 3.6).round() } else { (mps * 2.236_936_292_054_402).round() };
    let accel_pct = accel_percent(sei);

    // Blinkers flash 0.7 s (on for the first 57%), steady while paused.
    let blink_on = !d.playing || d.blink_ms < 400;
    // iced tints SVGs with the colour's RGB only, so transparency goes
    // through the widget's opacity.
    let blinker = |handle: &svg::Handle, on: bool| {
        let (color, opacity): (Color, f32) = if on { (GREEN, if blink_on { 1.0 } else { 0.15 }) } else { (Color::WHITE, 0.15) };
        svg(handle.clone())
            .width(icon_px)
            .height(icon_px)
            .opacity(opacity)
            .style(move |_, _| svg::Style { color: Some(color) })
    };

    let gear = text(gear_label(sei.gear_state))
        .size(22.0 * sc)
        .font(theme::semibold(theme::INTER))
        .color(if autopilot_on { BLUE } else { Color::WHITE })
        .center();
    let speed_box = column![
        text(format!("{speed}")).size(21.0 * sc).font(theme::bold(theme::INTER)).color(Color::WHITE),
        text(crate::i18n::t(if d.metric { "ui.dashboard.kmh" } else { "ui.dashboard.mph" })).size(11.0 * sc).font(theme::medium(theme::INTER)).color(theme::TEXT_MUTED),
    ]
    .align_x(Alignment::Center)
    .spacing(2.0 * sc)
    .width(65.0 * sc);
    let autopilot_box = column![
        text(autopilot_label(sei.autopilot_state)).size(20.0 * sc).color(if autopilot_on { BLUE } else { theme::TEXT_MUTED }),
        text(d.time).size(12.0 * sc).font(theme::medium(theme::INTER)).color(theme::TEXT_SECONDARY),
    ]
    .align_x(Alignment::Center)
    .spacing(2.0 * sc);
    let wheel_img = image(if autopilot_on { icons.wheel_on.clone() } else { icons.wheel_off.clone() })
        .width(icon_px)
        .height(icon_px)
        .rotation(Radians(d.steering.to_radians()));
    // Under Autopilot the wheel glows blue (a 10 px glow, no offset).
    let wheel = container(wheel_img).style(move |_| {
        if autopilot_on {
            container::Style {
                shadow: iced::Shadow { color: Color { a: 0.5, ..BLUE }, offset: iced::Vector::ZERO, blur_radius: 10.0 * sc },
                border: iced::Border { radius: (icon_px / 2.0).into(), ..Default::default() },
                ..Default::default()
            }
        } else {
            container::Style::default()
        }
    });
    let brake = image(if sei.brake_applied { icons.brake_on.clone() } else { icons.brake_off.clone() }).width(icon_px).height(icon_px);
    let accel = accel_view(d.accel, accel_pct, &icons.white, icon_px);

    row![
        gap(),
        brake,
        gap(),
        gear,
        gap(),
        blinker(&icons.blink_left, sei.blinker_on_left),
        gap(),
        speed_box,
        gap(),
        autopilot_box,
        gap(),
        blinker(&icons.blink_right, sei.blinker_on_right),
        gap(),
        wheel,
        gap(),
        accel,
        gap(),
    ]
    .align_y(Alignment::Center)
    .height(Length::Fill)
    .into()
}

/// Pedal position in percent (the value may be 0-1 or 0-100).
fn accel_percent(sei: &SeiMetadata) -> f64 {
    let raw = sei.accelerator_pedal_position;
    if raw > 1.0 { raw.min(100.0) } else { (raw * 100.0).min(100.0) }
}

/// The accelerator in the chosen style; "pressed" is over 5%.
fn accel_view<'a, M: 'a>(mode: AccelMode, pct: f64, pedal: &Pedal, size: f32) -> Element<'a, M> {
    let icons = icons();
    let pressed = pct > 5.0;
    let lit = || image(if pressed { pedal.on.clone() } else { icons.accel_off.clone() }).width(size).height(size);
    match mode {
        AccelMode::Solid => lit().into(),
        AccelMode::IconBar => {
            let step = ((pct / 100.0) * FILL_STEPS as f64).round().clamp(0.0, FILL_STEPS as f64) as usize;
            image(if step == 0 { icons.accel_off.clone() } else { pedal.fill[step].clone() }).width(size).height(size).into()
        }
        AccelMode::SideBar => {
            // The bar beside the pedal: 3 px, light grey, rising.
            let h = size * (pct as f32 / 100.0);
            let bar = column![
                Space::new().height(Length::Fill),
                container(Space::new()).width(3).height(h).style(|_| container::Style {
                    background: Some(iced::Background::Gradient(
                        iced::gradient::Linear::new(iced::Degrees(0.0))
                            .add_stop(0.0, Color::from_rgba8(200, 200, 200, 1.0))
                            .add_stop(1.0, Color::from_rgba8(200, 200, 200, 0.8))
                            .into(),
                    )),
                    border: iced::Border { radius: 2.0.into(), ..Default::default() },
                    ..Default::default()
                }),
            ]
            .width(3)
            .height(size);
            row![lit(), bar].spacing(2).align_y(Alignment::Center).into()
        }
    }
}

/// The G-force meter's dot position on its 60-unit face for an
/// acceleration (25 units per G, clamped at 2 G, up is forwards).
pub fn gforce_point(sei: &SeiMetadata) -> (f32, f32) {
    let gx = (sei.linear_acceleration_mps2_x / 9.81).clamp(-2.0, 2.0) as f32;
    let gy = (sei.linear_acceleration_mps2_y / 9.81).clamp(-2.0, 2.0) as f32;
    (30.0 + gx * 25.0, 30.0 - gy * 25.0)
}

/// The G-force meter: rings, crosshairs, a three-dot trail and the dot,
/// coloured by what the car is doing.
struct GForceMeter {
    /// Newest first; the first is where the dot is.
    trail: Vec<(f32, f32)>,
    color: Color,
    /// 0.8-1 opacity, pulsing once a second.
    pulse: f32,
}

fn green_dot() -> Color {
    Color::from_rgb8(0x5e, 0xe9, 0xa0)
}

impl<M> canvas::Program<M> for GForceMeter {
    type State = ();
    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, bounds: Rectangle, _: iced::mouse::Cursor) -> Vec<canvas::Geometry> {
        use canvas::{Path, Stroke};
        let mut frame = canvas::Frame::new(renderer, bounds.size());
        let k = bounds.width / 60.0;
        let p = |x: f32, y: f32| Point::new(x * k, y * k);
        let white = |a: f32| Color { a, ..Color::WHITE };
        frame.fill(&Path::circle(p(30.0, 30.0), 28.0 * k), Color::from_rgba(0.0, 0.0, 0.0, 0.3));
        frame.stroke(&Path::circle(p(30.0, 30.0), 28.0 * k), Stroke::default().with_width(1.0).with_color(white(0.1)));
        for r in [18.0, 9.0] {
            frame.stroke(&Path::circle(p(30.0, 30.0), r * k), Stroke::default().with_width(1.0).with_color(white(0.06)));
        }
        frame.stroke(&Path::line(p(30.0, 2.0), p(30.0, 58.0)), Stroke::default().with_width(1.0).with_color(white(0.08)));
        frame.stroke(&Path::line(p(2.0, 30.0), p(58.0, 30.0)), Stroke::default().with_width(1.0).with_color(white(0.08)));
        let green = green_dot();
        for (i, (r, a)) in [(2.5, 0.4), (2.0, 0.2), (1.5, 0.1)].into_iter().enumerate() {
            let (x, y) = self.trail.get(i).copied().unwrap_or((30.0, 30.0));
            frame.fill(&Path::circle(p(x, y), r * k), Color { a, ..green });
        }
        let (x, y) = self.trail.first().copied().unwrap_or((30.0, 30.0));
        frame.fill(&Path::circle(p(x, y), 4.0 * k), Color { a: self.pulse, ..self.color });
        // A small "G" in the bottom-right corner.
        frame.fill_text(canvas::Text {
            content: "G".into(),
            position: Point::new(bounds.width - 2.0, bounds.height - 2.0),
            color: theme::TEXT_FAINT,
            size: 7.0.into(),
            font: theme::bold(theme::INTER),
            align_x: iced::widget::text::Alignment::Right,
            align_y: iced::alignment::Vertical::Bottom,
            ..canvas::Text::default()
        });
        vec![frame.into_geometry()]
    }
}

/// The heading compass: ring, N/E/S/W, ticks, and a red-and-white needle
/// turned to the heading.
struct Compass {
    heading: f32,
}

impl<M> canvas::Program<M> for Compass {
    type State = ();
    fn draw(&self, _: &(), renderer: &Renderer, _: &Theme, bounds: Rectangle, _: iced::mouse::Cursor) -> Vec<canvas::Geometry> {
        use canvas::{Path, Stroke, Text};
        let mut frame = canvas::Frame::new(renderer, bounds.size());
        let k = bounds.width / 60.0;
        let p = |x: f32, y: f32| Point::new(x * k, y * k);
        let white = |a: f32| Color { a, ..Color::WHITE };
        frame.fill(&Path::circle(p(30.0, 30.0), 28.0 * k), Color::from_rgba(0.0, 0.0, 0.0, 0.3));
        frame.stroke(&Path::circle(p(30.0, 30.0), 28.0 * k), Stroke::default().with_width(1.0).with_color(white(0.1)));
        for (label, x, y, size, alpha, bold) in [("N", 30.0, 10.0, 8.0, 0.6, true), ("S", 30.0, 56.0, 7.0, 0.3, false), ("W", 7.0, 33.0, 7.0, 0.3, false), ("E", 53.0, 33.0, 7.0, 0.3, false)] {
            // SVG text sits on its baseline; canvas text is placed by its middle.
            frame.fill_text(Text {
                content: label.into(),
                position: p(x, y - size * 0.35),
                color: white(alpha),
                size: (size * k).into(),
                font: if bold { theme::bold(theme::INTER) } else { theme::INTER },
                align_x: iced::widget::text::Alignment::Center,
                align_y: iced::alignment::Vertical::Center,
                ..Text::default()
            });
        }
        for (a, b) in [((30.0, 12.0), (30.0, 16.0)), ((30.0, 44.0), (30.0, 48.0)), ((12.0, 30.0), (16.0, 30.0)), ((44.0, 30.0), (48.0, 30.0))] {
            frame.stroke(&Path::line(p(a.0, a.1), p(b.0, b.1)), Stroke::default().with_width(1.0).with_color(white(0.15)));
        }
        frame.translate(iced::Vector::new(30.0 * k, 30.0 * k));
        frame.rotate(self.heading.to_radians());
        let q = |x: f32, y: f32| Point::new((x - 30.0) * k, (y - 30.0) * k);
        let poly = |pts: [(f32, f32); 4]| {
            Path::new(|b| {
                b.move_to(q(pts[0].0, pts[0].1));
                for &(x, y) in &pts[1..] {
                    b.line_to(q(x, y));
                }
                b.close();
            })
        };
        frame.fill(&poly([(30.0, 14.0), (26.0, 30.0), (30.0, 28.0), (34.0, 30.0)]), Color::from_rgb8(0xe7, 0x4c, 0x3c));
        frame.fill(&poly([(30.0, 46.0), (26.0, 30.0), (30.0, 32.0), (34.0, 30.0)]), white(0.4));
        frame.fill(&Path::circle(q(30.0, 30.0), 3.0 * k), Color::from_rgb8(0x22, 0x22, 0x22));
        frame.stroke(&Path::circle(q(30.0, 30.0), 3.0 * k), Stroke::default().with_width(1.0).with_color(white(0.2)));
        vec![frame.into_geometry()]
    }
}

const CHEVRON_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>"#;

/// What only the full dashboard shows.
pub struct Full<'a, M> {
    /// The G-force meter's last positions, newest first.
    pub trail: &'a [(f32, f32)],
    /// Seconds since start (the dot's pulse).
    pub t: f32,
    pub details_open: bool,
    pub on_toggle_details: M,
}

fn gforce_value_color(g: f64) -> Color {
    if g.abs() > 0.8 {
        theme::ERROR
    } else if g > 0.2 {
        theme::SUCCESS
    } else if g < -0.2 {
        theme::WARNING
    } else {
        Color::from_rgb8(0x66, 0x66, 0x66)
    }
}

/// The full dashboard: the steering wheel, gear, blinkers, speed, Autopilot
/// with brake and accelerator, the recording time, the G-force meter and
/// compass, and a details drawer (latitude, longitude, heading, frame
/// number).
pub fn full<'a, M: Clone + 'a>(d: Dash<'_>, f: Full<'_, M>) -> Element<'a, M> {
    let icons = icons();
    let grey = |v: u8| Color::from_rgb8(v, v, v);
    let time = text(d.time.clone()).size(14).font(theme::medium(theme::INTER)).color(theme::TEXT_SECONDARY);
    // The drawer's chevron, turned over while the drawer is open.
    let chevron = svg(svg::Handle::from_memory(CHEVRON_SVG.as_bytes()))
        .width(16)
        .height(16)
        .rotation(Radians(if f.details_open { std::f32::consts::PI } else { 0.0 }))
        .style(move |_, _| svg::Style { color: Some(grey(0x66)) });
    let toggle = button(container(chevron).center_x(Length::Fill))
    .width(Length::Fill)
    .height(20)
    .padding(0)
    .style(theme::details_toggle)
    .on_press(f.on_toggle_details.clone());
    let hairline = || container(Space::new()).width(Length::Fill).height(1).style(|_| container::Style {
        background: Some(Color { a: 0.1, ..Color::WHITE }.into()),
        ..Default::default()
    });

    let Some(sei) = d.telemetry else {
        // Parked: gauges hidden, PARKED with the time.
        let mut body = column![
            row![
                Space::new().width(Length::Fill),
                text(crate::i18n::t("app.parked")).size(20).font(theme::bold(theme::INTER)).color(Color::WHITE),
                time,
                Space::new().width(Length::Fill),
            ]
            .spacing(16)
            .align_y(Alignment::Center)
            .height(Length::Fill),
            hairline(),
            toggle,
        ];
        if f.details_open {
            body = body.push(Space::new().height(60));
        }
        return body.into();
    };

    let autopilot_on = matches!(sei.autopilot_state, 1 | 2);
    let mps = sei.vehicle_speed_mps.abs();
    let speed = if d.metric { (mps * 3.6).round() } else { (mps * 2.236_936_292_054_402).round() };
    let blink_on = !d.playing || d.blink_ms < 400;
    let blinker = |handle: &svg::Handle, on: bool| {
        let (color, opacity): (Color, f32) = if on { (GREEN, if blink_on { 1.0 } else { 0.15 }) } else { (Color::WHITE, 0.15) };
        svg(handle.clone()).width(28).height(28).opacity(opacity).style(move |_, _| svg::Style { color: Some(color) })
    };

    // Left: the Autosteer wheel, turned with the steering, glowing blue
    // under Autopilot.
    let wheel_img = image(if autopilot_on { icons.wheel_on.clone() } else { icons.wheel_off.clone() })
        .width(60)
        .height(60)
        .rotation(Radians(d.steering.to_radians()));
    let wheel = container(container(wheel_img).style(move |_| {
        if autopilot_on {
            container::Style {
                shadow: iced::Shadow { color: Color { a: 0.5, ..BLUE }, offset: iced::Vector::ZERO, blur_radius: 20.0 },
                border: iced::Border { radius: 30.0.into(), ..Default::default() },
                ..Default::default()
            }
        } else {
            container::Style::default()
        }
    }))
    .center_x(120)
    .center_y(Length::Fill);

    // Centre: blinker, gear / speed / unit / Autopilot line, blinker.
    let gear = text(gear_label(sei.gear_state)).size(14).font(theme::semibold(theme::INTER)).color(if autopilot_on { BLUE } else { Color::WHITE });
    let brake = image(if sei.brake_applied { icons.brake_on.clone() } else { icons.brake_off.clone() }).width(18).height(18);
    let ap_line = row![
        brake,
        text(autopilot_label(sei.autopilot_state)).size(14).font(theme::medium(theme::INTER)).color(if autopilot_on { BLUE } else { theme::TEXT_MUTED }),
        accel_view(d.accel, accel_percent(sei), &icons.blue, 18.0),
    ]
    .spacing(6)
    .align_y(Alignment::Center);
    let speed_box = column![
        gear,
        text(format!("{speed}")).size(36).color(Color::WHITE),
        text(crate::i18n::t(if d.metric { "ui.dashboard.kmh" } else { "ui.dashboard.mph" }))
            .size(11)
            .font(theme::semibold(theme::INTER))
            .color(theme::TEXT_MUTED),
        ap_line,
    ]
    .spacing(2)
    .align_x(Alignment::Center);
    let centre = row![blinker(&icons.blink_left, sei.blinker_on_left), speed_box, blinker(&icons.blink_right, sei.blinker_on_right)]
        .spacing(16)
        .align_y(Alignment::Center);

    let top = row![wheel, container(centre).center_x(Length::Fill), container(time).center_x(110)].align_y(Alignment::Center).height(108);

    // Instruments: G-force with its two values, then the compass.
    let gx = sei.linear_acceleration_mps2_x / 9.81;
    let gy = sei.linear_acceleration_mps2_y / 9.81;
    let dot = if gy < -0.3 {
        theme::ERROR
    } else if gy > 0.3 {
        theme::SUCCESS
    } else if gx.abs() > 0.5 {
        theme::WARNING
    } else {
        green_dot()
    };
    let pulse = 0.9 - 0.1 * (f.t * std::f32::consts::TAU).cos();
    let gvalue = |g: f64| text(format!("{}{:.1}", if g >= 0.0 { "+" } else { "" }, g)).size(11).font(theme::semibold(theme::MONO)).color(gforce_value_color(g));
    let heading = ((sei.heading_deg % 360.0) + 360.0) % 360.0;
    let cardinal = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][((heading / 45.0).round() as usize) % 8];
    let instruments = row![
        canvas(GForceMeter { trail: f.trail.to_vec(), color: dot, pulse }).width(50).height(50),
        column![gvalue(gx), gvalue(gy)].spacing(2),
        Space::new().width(12),
        canvas(Compass { heading: heading as f32 }).width(45).height(45),
        text(format!("{}° {cardinal}", heading.round())).size(11).font(theme::semibold(theme::MONO)).color(grey(0x88)),
    ]
    .spacing(6)
    .align_y(Alignment::Center);

    let mut body = column![
        top,
        hairline(),
        container(instruments).center_x(Length::Fill).center_y(Length::Fill),
        hairline(),
        toggle,
    ];
    if f.details_open {
        let item = |label: &'static str, value: String| {
            column![
                text(label).size(8).color(grey(0x66)),
                text(value).size(10).font(theme::semibold(theme::MONO)).color(theme::ACCENT),
            ]
            .align_x(Alignment::Center)
            .width(Length::Fill)
        };
        body = body.push(
            column![
                row![
                    item(crate::i18n::t("app.lat"), format!("{:.6}", sei.latitude_deg)),
                    item(crate::i18n::t("app.lon"), format!("{:.6}", sei.longitude_deg)),
                    item(crate::i18n::t("app.head"), format!("{:.1}°", sei.heading_deg)),
                ]
                .padding([6, 10]),
                row![
                    text(crate::i18n::t("app.seq")).size(8).color(grey(0x66)),
                    text(format!("{}", sei.frame_seq_no)).size(8).font(theme::MONO).color(grey(0x88)),
                ]
                .spacing(6),
            ]
            .align_x(Alignment::Center)
            .height(60),
        );
    }
    body.into()
}

/// The full dashboard's size: 480 x 200, 260 with the details open.
pub fn full_size(details_open: bool) -> iced::Size {
    iced::Size::new(480.0, if details_open { 260.0 } else { 200.0 })
}

/// The compact dashboard's size when it floats.
pub const COMPACT_FLOATING: iced::Size = iced::Size::new(480.0, 56.0);

/// The pill around it (the panel gradient over the frosted video, glass
/// border, 24 px corners).
pub fn frame<'a, M: 'a>(content: Element<'a, M>) -> container::Container<'a, M> {
    container(content).padding([0, 6]).style(theme::dashboard_glass)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_times() {
        assert_eq!(time_of_day(4 * 3600 + 25 * 60 + 43, false), "4:25:43 AM");
        assert_eq!(time_of_day(0, false), "12:00:00 AM");
        assert_eq!(time_of_day(13 * 3600 + 5, false), "1:00:05 PM");
        assert_eq!(time_of_day(13 * 3600 + 5, true), "13:00:05");
    }

    #[test]
    fn icons_build() {
        let i = icons();
        assert_eq!(i.white.fill.len(), FILL_STEPS + 1);
        assert_eq!(i.blue.fill.len(), FILL_STEPS + 1);
    }

    #[test]
    fn gforce_points() {
        let sei = SeiMetadata { linear_acceleration_mps2_x: 9.81, linear_acceleration_mps2_y: -9.81 * 3.0, ..Default::default() };
        // 1 G right: 25 units right; 3 G of braking clamps at 2 G, downwards.
        assert_eq!(gforce_point(&sei), (55.0, 80.0));
        assert_eq!(AccelMode::from_key("sidebar"), Some(AccelMode::SideBar));
    }
}
