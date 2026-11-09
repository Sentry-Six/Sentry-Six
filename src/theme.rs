//! The app's look: the dark glass theme with the green accent, Inter /
//! JetBrains Mono / Material Symbols, and the styles of its panels, clip
//! cards, badges, camera tiles and control bar.

use iced::border::Radius;
use iced::font::Weight;
use iced::widget::{button, container, pick_list, slider, text};
use iced::{Background, Border, Color, Font, Shadow, Theme, Vector};

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a: 1.0 }
}
const fn rgba(r: u8, g: u8, b: u8, a: f32) -> Color {
    Color { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a }
}
const fn white(a: f32) -> Color {
    Color { r: 1.0, g: 1.0, b: 1.0, a }
}
const fn black(a: f32) -> Color {
    Color { r: 0.0, g: 0.0, b: 0.0, a }
}

// The page colour, the text greys and the accent (oklch(0.82 0.18 150)
// and friends).
pub const BG: Color = rgb(0x07, 0x09, 0x0c);
pub const TEXT: Color = rgb(0xe6, 0xe9, 0xef);
pub const TEXT_SECONDARY: Color = rgb(0xb8, 0xbf, 0xcf);
pub const TEXT_MUTED: Color = rgb(0x8a, 0x93, 0xa3);
pub const TEXT_FAINT: Color = rgb(0x7a, 0x82, 0x94);
pub const ACCENT: Color = rgb(0x5c, 0xe4, 0x83);
pub const ACCENT_HOVER: Color = rgb(0x7e, 0xf1, 0x9b);
pub const SUCCESS: Color = rgb(0x34, 0xd3, 0x99);
pub const ERROR: Color = rgb(0xf8, 0x71, 0x71);
pub const WARNING: Color = rgb(0xfb, 0xbf, 0x24);

pub const INTER: Font = Font::with_name("Inter");
pub const MONO: Font = Font::with_name("JetBrains Mono");
pub const ICONS: Font = Font::with_name("Material Symbols Outlined");

pub fn medium(f: Font) -> Font {
    Font { weight: Weight::Medium, ..f }
}
pub fn semibold(f: Font) -> Font {
    Font { weight: Weight::Semibold, ..f }
}
pub fn bold(f: Font) -> Font {
    Font { weight: Weight::Bold, ..f }
}

/// Fixed-weight files: iced picks weights by file, so each weight the app
/// uses is its own file (see assets/fonts/README.md).
pub const FONT_FILES: [&[u8]; 6] = [
    include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Inter-Bold.ttf"),
    include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf"),
    include_bytes!("../assets/fonts/MaterialSymbolsOutlined-Regular.ttf"),
];

pub fn theme() -> Theme {
    Theme::custom(
        "Sentry Studio",
        iced::theme::Palette { background: BG, text: TEXT, primary: ACCENT, success: SUCCESS, warning: WARNING, danger: ERROR },
    )
}

/// Material Symbols codepoints for the icons used so far.
pub mod icon {
    pub const PLAY: char = '\u{e037}';
    pub const PAUSE: char = '\u{e034}';
    pub const SKIP_BACK: char = '\u{e045}';
    pub const SKIP_FORWARD: char = '\u{e044}';
    pub const FOLDER_OPEN: char = '\u{e2c8}';
    pub const VIDEOCAM: char = '\u{e04b}';
    pub const CHEVRON_LEFT: char = '\u{e5cb}';
    pub const EXPAND_MORE: char = '\u{e5cf}';
    pub const STRAIGHTEN: char = '\u{e41c}';
    pub const SCHEDULE: char = '\u{e8b5}';
    pub const AUTO_AWESOME: char = '\u{e65f}';
    pub const BOLT: char = '\u{ea0b}';
    pub const WARNING: char = '\u{e002}';
    pub const SETTINGS: char = '\u{e8b8}';
    pub const DELETE: char = '\u{e872}';
    pub const ERROR: char = '\u{e000}';
    pub const FOLDER: char = '\u{e2c7}';
}

/// The chips on a drive card, and their tones.
#[derive(Debug, Clone, Copy)]
pub enum ChipTone {
    Plain,
    Green,
    Accent,
    Slate,
}

pub fn chip(tone: ChipTone) -> impl Fn(&Theme) -> container::Style {
    move |_| {
        let (bg, fg, border) = match tone {
            ChipTone::Plain => (white(0.05), TEXT_SECONDARY, white(0.08)),
            ChipTone::Green => (rgba(16, 185, 129, 0.15), SUCCESS, rgba(16, 185, 129, 0.22)),
            ChipTone::Accent => (Color { a: 0.15, ..ACCENT }, ACCENT, Color { a: 0.22, ..ACCENT }),
            ChipTone::Slate => (white(0.05), TEXT_MUTED, white(0.10)),
        };
        container::Style {
            background: Some(bg.into()),
            border: Border { color: border, width: 1.0, radius: 999.0.into() },
            text_color: Some(fg),
            ..Default::default()
        }
    }
}

/// A tag on a drive card (violet).
pub fn tag_pill(_: &Theme) -> container::Style {
    container::Style {
        background: Some(rgba(196, 181, 253, 0.15).into()),
        border: Border { radius: 999.0.into(), ..Default::default() },
        text_color: Some(rgb(0xc4, 0xb5, 0xfd)),
        ..Default::default()
    }
}

/// The start of a drive's journey line: a hollow ring.
pub fn pin_origin(_: &Theme) -> container::Style {
    container::Style { border: Border { color: white(0.3), width: 2.0, radius: 4.0.into() }, ..Default::default() }
}

/// The end of a drive's journey line: the accent dot with a soft ring.
pub fn pin_dest(_: &Theme) -> container::Style {
    container::Style {
        background: Some(ACCENT.into()),
        border: Border { color: Color { a: 0.3, ..ACCENT }, width: 0.0, radius: 4.0.into() },
        shadow: Shadow { color: Color { a: 0.3, ..ACCENT }, offset: Vector::ZERO, blur_radius: 4.0 },
        ..Default::default()
    }
}


/// The count next to "Drives" on the tab: green on the active tab.
pub fn tab_count(active: bool) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(if active { Color { a: 0.18, ..ACCENT } } else { white(0.08) }.into()),
        border: Border { radius: 999.0.into(), ..Default::default() },
        text_color: Some(if active { ACCENT_HOVER } else { TEXT_MUTED }),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Settings window and dialogs
// ---------------------------------------------------------------------------

/// The dimmed page behind a dialog.
pub fn backdrop(_: &Theme) -> container::Style {
    // A light dim, so the dialog's glass reads like the side panel.
    container::Style { background: Some(black(0.35).into()), ..Default::default() }
}

/// An event's preview picture beside its card: a faint edge and a soft
/// shadow, 6 px corners.
pub fn event_preview(_: &Theme) -> container::Style {
    container::Style {
        border: Border { color: white(0.08), width: 1.0, radius: 6.0.into() },
        shadow: Shadow { color: black(0.5), offset: Vector::new(0.0, 4.0), blur_radius: 20.0 },
        ..Default::default()
    }
}

/// The support chat panel: glass (the video
/// under it is frosted, see video::Glass) with a faint accent border.
pub fn chat_panel(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Gradient(
            iced::gradient::Linear::new(iced::Degrees(165.0)).add_stop(0.0, rgba(16, 20, 27, 0.88)).add_stop(1.0, rgba(7, 9, 12, 0.92)).into(),
        )),
        border: Border { color: Color { a: 0.15, ..ACCENT }, width: 1.0, radius: 16.0.into() },
        shadow: Shadow { color: black(0.5), offset: Vector::new(0.0, 10.0), blur_radius: 40.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// Dialogs on a solid surface (the Dialog Style setting) instead of
/// frosted glass.
static SOLID_DIALOGS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_solid_dialogs(solid: bool) {
    SOLID_DIALOGS.store(solid, std::sync::atomic::Ordering::Relaxed);
}

/// A dialog is opening over another (an update prompt over Settings):
/// what's under it is the other dialog's text, which can't be frosted, so
/// it's solid (`modal_top`).
static STACKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_stacked(stacked: bool) {
    STACKED.store(stacked, std::sync::atomic::Ordering::Relaxed);
}

/// A dialog that can open over another: solid when it does.
pub fn modal_top(theme: &Theme) -> container::Style {
    if STACKED.load(std::sync::atomic::Ordering::Relaxed) {
        modal_solid(theme)
    } else {
        modal(theme)
    }
}

/// The solid dialog surface (graphite).
fn modal_solid(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Gradient(iced::gradient::Linear::new(iced::Degrees(180.0)).add_stop(0.0, rgba(36, 39, 45, 1.0)).add_stop(1.0, rgba(26, 28, 33, 1.0)).into())),
        border: Border { color: white(0.10), width: 1.0, radius: 24.0.into() },
        shadow: Shadow { color: black(0.5), offset: Vector::new(0.0, 32.0), blur_radius: 100.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// A dialog: frosted glass (the video under it blurred, see video::Glass),
/// or with the Dialog Style setting, a solid graphite surface; 24 px
/// corners, deep shadow.
pub fn modal(_: &Theme) -> container::Style {
    if SOLID_DIALOGS.load(std::sync::atomic::Ordering::Relaxed) {
        return modal_solid(&Theme::Dark);
    }
    container::Style {
        background: Some(Background::Gradient(iced::gradient::Linear::new(iced::Degrees(180.0)).add_stop(0.0, rgba(70, 78, 92, 0.42)).add_stop(1.0, rgba(30, 34, 42, 0.50)).into())),
        border: Border { color: white(0.22), width: 1.0, radius: 24.0.into() },
        shadow: Shadow { color: black(0.5), offset: Vector::new(0.0, 32.0), blur_radius: 100.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The export editor, which fills the window: the glass, but dense
/// enough that the video under it is only a hint of colour.
pub fn modal_editor(_: &Theme) -> container::Style {
    if SOLID_DIALOGS.load(std::sync::atomic::Ordering::Relaxed) {
        return modal_solid(&Theme::Dark);
    }
    container::Style {
        background: Some(Background::Gradient(iced::gradient::Linear::new(iced::Degrees(180.0)).add_stop(0.0, rgba(30, 34, 41, 0.86)).add_stop(1.0, rgba(18, 20, 25, 0.92)).into())),
        border: Border { color: white(0.16), width: 1.0, radius: 24.0.into() },
        shadow: Shadow { color: black(0.5), offset: Vector::new(0.0, 32.0), blur_radius: 100.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The Settings sidebar (its right border is a separate hairline).
pub fn modal_nav(_: &Theme) -> container::Style {
    container::Style { background: Some(rgba(7, 9, 12, 0.5).into()), ..Default::default() }
}

/// A dialog's header band. Its top corners follow the dialog's
/// (iced clips children to a plain rectangle, not the rounded border).
pub fn modal_header(_: &Theme) -> container::Style {
    container::Style {
        background: Some(rgba(7, 9, 12, 0.5).into()),
        border: Border { radius: Radius { top_left: 23.0, top_right: 23.0, bottom_right: 0.0, bottom_left: 0.0 }, ..Default::default() },
        ..Default::default()
    }
}

/// The line under the Settings header: transparent, accent at 30%, the
/// lighter accent at 70%, transparent; at half opacity.
pub fn accent_line(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Gradient(
            iced::gradient::Linear::new(iced::Degrees(90.0))
                .add_stop(0.0, Color { a: 0.0, ..ACCENT })
                .add_stop(0.3, Color { a: 0.5, ..ACCENT })
                .add_stop(0.7, Color { a: 0.5, ..ACCENT_HOVER })
                .add_stop(1.0, Color { a: 0.0, ..ACCENT_HOVER })
                .into(),
        )),
        ..Default::default()
    }
}

/// The Settings footer: a faint dark gradient.
pub fn modal_footer(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Gradient(
            iced::gradient::Linear::new(iced::Degrees(180.0)).add_stop(0.0, black(0.1)).add_stop(1.0, black(0.2)).into(),
        )),
        border: Border { radius: Radius { top_left: 0.0, top_right: 0.0, bottom_right: 23.0, bottom_left: 23.0 }, ..Default::default() },
        ..Default::default()
    }
}

/// A dialog's close button: a small rounded square; green on hover in
/// Settings.
pub fn modal_close(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some((if hovered { Color { a: 0.15, ..ACCENT } } else { white(0.06) }).into()),
        text_color: if hovered { ACCENT } else { TEXT_SECONDARY },
        border: Border { radius: 8.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A primary button: solid accent with dark text.
pub fn primary_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    // Disabled: half strength.
    let fade = |c: Color| if status == button::Status::Disabled { Color { a: 0.5, ..c } } else { c };
    button::Style {
        background: Some(fade(if hovered { ACCENT_HOVER } else { ACCENT }).into()),
        text_color: fade(BG),
        border: Border { radius: 8.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A Settings sidebar item (and the subtab buttons): accent tint when active
/// or matching a search, a light wash on hover.
pub fn settings_nav(active: bool, highlight: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let (bg, fg) = if active {
            (Color { a: 0.10, ..ACCENT }, ACCENT)
        } else if highlight {
            (Color { a: 0.08, ..ACCENT }, ACCENT)
        } else if hovered {
            (white(0.07), TEXT)
        } else {
            (Color::TRANSPARENT, TEXT_SECONDARY)
        };
        button::Style {
            background: Some(bg.into()),
            text_color: fg,
            border: Border { radius: 8.0.into(), ..Default::default() },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

/// The bar holding the Playback & Overlays subtabs.
pub fn subtab_bar(_: &Theme) -> container::Style {
    container::Style {
        background: Some(rgba(7, 9, 12, 0.5).into()),
        border: Border { color: white(0.06), width: 1.0, radius: 10.0.into() },
        ..Default::default()
    }
}

/// The search box at the top of the Settings sidebar.
pub fn settings_search(_: &Theme, status: iced::widget::text_input::Status) -> iced::widget::text_input::Style {
    let focused = matches!(status, iced::widget::text_input::Status::Focused { .. });
    iced::widget::text_input::Style {
        background: (if focused { white(0.07) } else { white(0.04) }).into(),
        border: Border { color: if focused { Color { a: 0.4, ..ACCENT } } else { white(0.10) }, width: 1.0, radius: 8.0.into() },
        icon: TEXT_MUTED,
        placeholder: TEXT_FAINT,
        value: TEXT,
        selection: Color { a: 0.35, ..ACCENT },
    }
}

/// A small secondary button: a faint fill and border.
pub fn secondary_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some((if hovered { white(0.07) } else { white(0.04) }).into()),
        text_color: TEXT,
        border: Border { color: white(0.10), width: 1.0, radius: 8.0.into() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A read-only path field in Settings.
pub fn path_field(_: &Theme) -> container::Style {
    container::Style {
        background: Some(rgba(7, 9, 12, 0.55).into()),
        border: Border { color: white(0.10), width: 1.0, radius: 8.0.into() },
        ..Default::default()
    }
}

/// A shortcut's key field; amber while waiting for a key.
pub fn keybind_field(recording: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let (bg, border) = if recording {
            (Color { a: 0.15, ..WARNING }, Color { a: 0.7, ..WARNING })
        } else if hovered {
            (Color { a: 0.10, ..ACCENT }, ACCENT)
        } else {
            (rgba(7, 9, 12, 0.55), white(0.10))
        };
        button::Style {
            background: Some(bg.into()),
            text_color: TEXT,
            border: Border { color: border, width: 1.0, radius: 4.0.into() },
            shadow: Shadow::default(),
            snap: true,
        }
    }
}

/// The ✕ that clears a shortcut: red on hover.
pub fn keybind_clear(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some((if hovered { Color { a: 0.3, ..ERROR } } else { white(0.06) }).into()),
        text_color: if hovered { TEXT } else { TEXT_FAINT },
        border: Border { radius: 4.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A text link (Learn More, Privacy Policy).
pub fn link_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: None,
        text_color: if hovered { ACCENT_HOVER } else { TEXT_SECONDARY },
        border: Border::default(),
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A status badge in the security table: green when on, grey when off.
pub fn status_badge(on: bool) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some((if on { Color { a: 0.15, ..SUCCESS } } else { white(0.06) }).into()),
        text_color: Some(if on { SUCCESS } else { TEXT_MUTED }),
        border: Border { radius: 4.0.into(), ..Default::default() },
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Toasts, overlays, delete dialogs, event camera glow
// ---------------------------------------------------------------------------

/// A toast: dark glass card, 14 px corners, soft shadow.
pub fn toast(_: &Theme) -> container::Style {
    container::Style {
        background: Some(rgba(11, 14, 19, 0.92).into()),
        border: Border { color: white(0.10), width: 1.0, radius: 14.0.into() },
        shadow: Shadow { color: black(0.30), offset: Vector::new(0.0, 10.0), blur_radius: 30.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The dot at the start of a toast.
pub fn toast_dot(_: &Theme) -> container::Style {
    container::Style { background: Some(white(0.35).into()), border: Border { radius: 999.0.into(), ..Default::default() }, ..Default::default() }
}

/// A dark veil over the window: under the folder prompt and a dragged
/// folder (0.55), and while scanning (0.85).
pub fn overlay(alpha: f32) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style { background: Some(black(alpha).into()), text_color: Some(TEXT_MUTED), ..Default::default() }
}

/// A folder dragged over the window: the drop target.
pub fn drop_target(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color { a: 0.12, ..ACCENT }.into()),
        border: Border { color: ACCENT, width: 2.0, radius: 16.0.into() },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The delete button on a clip card: red, shown on hover.
pub fn clip_delete(_: &Theme, status: button::Status) -> button::Style {
    let a = match status {
        button::Status::Pressed => 0.5,
        button::Status::Hovered => 0.3,
        _ => 0.15,
    };
    button::Style {
        background: Some(Color { a, ..ERROR }.into()),
        text_color: ERROR,
        border: Border { radius: 6.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A danger button (Delete): red tint and border, stronger on hover.
pub fn danger_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some(Color { a: if hovered { 0.22 } else { 0.10 }, ..ERROR }.into()),
        text_color: rgb(0xfc, 0xa5, 0xa5),
        border: Border { color: Color { a: if hovered { 0.4 } else { 0.25 }, ..ERROR }, width: 1.0, radius: 8.0.into() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The folder path in the delete dialog, and the code box inside it.
pub fn path_box(_: &Theme) -> container::Style {
    container::Style { background: Some(black(0.3).into()), border: Border { radius: 8.0.into(), ..Default::default() }, ..Default::default() }
}

pub fn path_code(_: &Theme) -> container::Style {
    container::Style { background: Some(black(0.2).into()), border: Border { radius: 4.0.into(), ..Default::default() }, ..Default::default() }
}

/// The pulsing glow on an event's camera: `pulse` runs 0 -> 1 -> 0 each
/// second. The 4 px border, brightening at the peak.
pub fn glow_border(color: Color, bright: Color, pulse: f32) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        border: Border { color: mix(Color { a: 0.9, ..color }, bright, pulse), width: 4.0, radius: 12.0.into() },
        ..Default::default()
    }
}

/// The tile under a glowing camera: the outer glow.
pub fn tile_glow(color: Color, pulse: f32) -> impl Fn(&Theme) -> container::Style {
    move |t| container::Style {
        shadow: Shadow { color: Color { a: 0.6 + 0.3 * pulse, ..color }, offset: Vector::ZERO, blur_radius: 22.0 + 18.0 * pulse },
        ..tile(t)
    }
}

fn mix(a: Color, b: Color, t: f32) -> Color {
    Color { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t }
}

/// The handle of the full dashboard's details drawer.
pub fn details_toggle(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: hovered.then(|| white(0.05).into()),
        text_color: rgb(0x66, 0x66, 0x66),
        border: Border::default(),
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The map's re-centre and orientation buttons.
pub fn map_button(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some((if hovered { rgba(22, 27, 36, 0.95) } else { rgba(11, 14, 19, 0.85) }).into()),
        text_color: if hovered { TEXT } else { TEXT_SECONDARY },
        border: Border { color: if hovered { TEXT_FAINT } else { white(0.15) }, width: 1.0, radius: 8.0.into() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The hint shown over the map.
pub fn map_hint(_: &Theme) -> container::Style {
    container::Style {
        background: Some(black(0.6).into()),
        border: Border { radius: 4.0.into(), ..Default::default() },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The map's attribution, on a small dark backing of its own.
pub fn map_credit(_: &Theme) -> container::Style {
    container::Style { background: Some(black(0.45).into()), border: Border { radius: 6.0.into(), ..Default::default() }, ..Default::default() }
}

/// The Terms / Privacy links on the first-run notice.
pub fn welcome_link(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some(Color { a: if hovered { 0.25 } else { 0.15 }, ..ACCENT }.into()),
        text_color: ACCENT,
        border: Border { radius: 8.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The line under the first-run notice's title: accent fading out at both
/// ends.
pub fn welcome_line(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Gradient(
            iced::gradient::Linear::new(iced::Degrees(90.0))
                .add_stop(0.0, Color { a: 0.0, ..ACCENT })
                .add_stop(0.5, Color { a: 0.5, ..ACCENT })
                .add_stop(1.0, Color { a: 0.0, ..ACCENT })
                .into(),
        )),
        ..Default::default()
    }
}

/// Dividers inside the Settings window.
pub fn subtle_line(_: &Theme) -> container::Style {
    container::Style { background: Some(white(0.06).into()), ..Default::default() }
}

/// A toggle switch: grey track and knob when off; green with a glowing
/// knob when on.
pub fn toggle(_: &Theme, status: iced::widget::toggler::Status) -> iced::widget::toggler::Style {
    use iced::widget::toggler::{Status, Style};
    // Disabled (while an export runs) keeps its colours, so a switch
    // that's on still reads as on.
    let on = matches!(status, Status::Active { is_toggled: true } | Status::Hovered { is_toggled: true } | Status::Disabled { is_toggled: true });
    Style {
        background: (if on { Color { a: 0.35, ..ACCENT } } else { white(0.10) }).into(),
        background_border_width: 0.0,
        background_border_color: Color::TRANSPARENT,
        foreground: (if on { ACCENT } else { white(0.30) }).into(),
        foreground_border_width: 0.0,
        foreground_border_color: Color::TRANSPARENT,
        text_color: None,
        border_radius: None,
        padding_ratio: 0.12,
    }
}

/// A select in Settings (opens the OS menu).
pub fn settings_select(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some((if hovered { white(0.07) } else { rgba(7, 9, 12, 0.55) }).into()),
        text_color: TEXT,
        border: Border { color: white(0.16), width: 1.0, radius: 6.0.into() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A Settings select as a dropdown (Windows, Linux): as settings_select.
pub fn settings_pick(_: &Theme, status: pick_list::Status) -> pick_list::Style {
    let hovered = matches!(status, pick_list::Status::Hovered | pick_list::Status::Opened { .. });
    pick_list::Style {
        text_color: TEXT,
        placeholder_color: TEXT_MUTED,
        handle_color: TEXT,
        background: (if hovered { white(0.07) } else { rgba(7, 9, 12, 0.55) }).into(),
        border: Border { color: white(0.16), width: 1.0, radius: 6.0.into() },
    }
}

/// A slider with a green thumb (the glass blur setting).
pub fn settings_slider(_: &Theme, _status: slider::Status) -> slider::Style {
    slider::Style {
        rail: slider::Rail {
            backgrounds: (white(0.15).into(), white(0.15).into()),
            width: 4.0,
            border: Border { radius: 2.0.into(), ..Default::default() },
        },
        handle: slider::Handle {
            shape: slider::HandleShape::Circle { radius: 7.0 },
            background: ACCENT.into(),
            border_width: 0.0,
            border_color: Color::TRANSPARENT,
        },
    }
}

/// The TAG filter box on the Drives tab.
pub fn filter_input(_: &Theme, status: iced::widget::text_input::Status) -> iced::widget::text_input::Style {
    let focused = matches!(status, iced::widget::text_input::Status::Focused { .. });
    iced::widget::text_input::Style {
        background: rgba(7, 9, 12, 0.55).into(),
        border: Border { color: if focused { Color { a: 0.55, ..ACCENT } } else { white(0.12) }, width: 1.0, radius: 8.0.into() },
        icon: TEXT_MUTED,
        placeholder: TEXT_FAINT,
        value: TEXT,
        selection: Color { a: 0.35, ..ACCENT },
    }
}

/// The band behind a date in the drive list.
pub fn date_band(_: &Theme) -> container::Style {
    container::Style {
        background: Some(rgba(11, 14, 19, 0.72).into()),
        border: Border { radius: 8.0.into(), ..Default::default() },
        ..Default::default()
    }
}

/// Thin scrollbars: no rail, a faint pill that brightens on hover.
pub fn thin_scroll(_: &Theme, status: iced::widget::scrollable::Status) -> iced::widget::scrollable::Style {
    use iced::widget::scrollable::{AutoScroll, Rail, Scroller, Status, Style};
    let hot = matches!(status, Status::Hovered { is_vertical_scrollbar_hovered: true, .. } | Status::Dragged { is_vertical_scrollbar_dragged: true, .. });
    let rail = Rail {
        background: None,
        border: Border::default(),
        scroller: Scroller {
            background: (if hot { white(0.20) } else { white(0.10) }).into(),
            border: Border { radius: 3.0.into(), ..Default::default() },
        },
    };
    Style {
        container: container::Style::default(),
        vertical_rail: rail,
        horizontal_rail: rail,
        gap: None,
        auto_scroll: AutoScroll {
            background: black(0.6).into(),
            border: Border { radius: 999.0.into(), ..Default::default() },
            shadow: Shadow::default(),
            icon: TEXT,
        },
    }
}

/// The ⌄ chevron on selects, instead of iced's ▼.
pub fn chevron_handle(size: f32) -> pick_list::Handle<Font> {
    pick_list::Handle::Static(pick_list::Icon {
        font: ICONS,
        code_point: icon::EXPAND_MORE,
        size: Some(size.into()),
        line_height: text::LineHeight::Relative(1.0),
        shaping: text::Shaping::Basic,
    })
}

pub fn icon<'a>(c: char, size: f32) -> iced::widget::Text<'a> {
    text(c.to_string()).font(ICONS).size(size).line_height(1.0)
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/// The window behind everything (the page colour with the accent glow at
/// the top).
pub fn app_background(_: &Theme) -> container::Style {
    let glow = iced::gradient::Linear::new(iced::Radians(std::f32::consts::PI))
        .add_stop(0.0, rgba(0x0b, 0x14, 0x10, 1.0))
        .add_stop(0.25, BG)
        .add_stop(1.0, BG);
    container::Style {
        background: Some(Background::Gradient(glow.into())),
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The clip browser: dark glass, 24 px corners.
pub fn panel(_: &Theme) -> container::Style {
    container::Style {
        // 0.85 over the frosted video (the blur is drawn by the video
        // shader, see video.rs).
        background: Some(rgba(7, 9, 12, 0.85).into()),
        border: Border { color: white(0.10), width: 1.0, radius: 24.0.into() },
        shadow: Shadow { color: black(0.45), offset: Vector::new(0.0, 12.0), blur_radius: 34.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The panel with other corners (the collapsed panel uses 12 px).
pub fn panel_radius(radius: f32) -> impl Fn(&Theme) -> container::Style {
    move |t| container::Style { border: Border { radius: radius.into(), ..panel(t).border }, ..panel(t) }
}

/// The chevron in the collapsed panel: no box, a faint fill on hover.
pub fn collapsed_button(_: &Theme, status: button::Status) -> button::Style {
    button::Style {
        background: matches!(status, button::Status::Hovered | button::Status::Pressed).then(|| white(0.08).into()),
        text_color: TEXT,
        border: Border { radius: 12.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The date pill when it opens the OS menu.
pub fn day_pill(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: Some((if hovered { rgba(12, 16, 28, 0.95) } else { rgba(5, 8, 18, 0.9) }).into()),
        text_color: TEXT,
        border: Border { color: white(0.18), width: 1.0, radius: 999.0.into() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The clip browser's header.
pub fn panel_header(_: &Theme) -> container::Style {
    container::Style {
        background: Some(white(0.04).into()),
        border: Border {
            radius: Radius { top_left: 24.0, top_right: 24.0, bottom_left: 0.0, bottom_right: 0.0 },
            ..Default::default()
        },
        ..Default::default()
    }
}

/// The bar holding the Clips / Drives tabs.
pub fn tab_bar(_: &Theme) -> container::Style {
    container::Style {
        background: Some(black(0.25).into()),
        border: Border { color: white(0.06), width: 1.0, radius: 12.0.into() },
        ..Default::default()
    }
}

/// A badge on a clip card: recent, Sentry, Saved or the event reason.
pub fn badge(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Color { a: 0.25, ..color }.into()),
        border: Border { radius: 999.0.into(), ..Default::default() },
        text_color: Some(color),
        ..Default::default()
    }
}

/// A camera tile.
pub fn tile(_: &Theme) -> container::Style {
    container::Style {
        background: Some(black(0.65).into()),
        border: Border { color: white(0.06), width: 1.0, radius: 12.0.into() },
        ..Default::default()
    }
}

/// The camera tile being dragged: opacity 0.4 (a veil of the page colour)
/// and a 3 px accent outline at 0.6.
pub fn drag_source(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color { a: 0.6, ..BG }.into()),
        border: Border { color: Color { a: 0.6, ..ACCENT }, width: 3.0, radius: 12.0.into() },
        ..Default::default()
    }
}

/// The camera tile a drag is over: a 3 px accent outline and a faint green
/// glow.
pub fn drag_target(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color { a: 0.10, ..ACCENT }.into()),
        border: Border { color: ACCENT, width: 3.0, radius: 12.0.into() },
        ..Default::default()
    }
}

/// The label that follows a dragged camera: accent at 0.9, 4 px corners.
pub fn drag_indicator(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color { a: 0.9, ..ACCENT }.into()),
        border: Border { radius: 4.0.into(), ..Default::default() },
        ..Default::default()
    }
}

/// The full dashboard (floating, top right) and the map panel: the panel
/// gradient over the frosted video, the glass border and specular top
/// edge, 24 px corners.
pub fn dashboard_glass(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Gradient(
            iced::gradient::Linear::new(iced::Degrees(150.0))
                .add_stop(0.0, white(0.05))
                .add_stop(0.55, white(0.02))
                .add_stop(1.0, white(0.03))
                .into(),
        )),
        border: Border { color: white(0.08), width: 1.0, radius: 24.0.into() },
        shadow: Shadow { color: black(0.4), offset: Vector::new(0.0, 12.0), blur_radius: 34.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The zoom badge: "2.0x" in the bottom-right of a zoomed camera.
pub fn zoom_badge(_: &Theme) -> container::Style {
    container::Style {
        background: Some(black(0.7).into()),
        border: Border { color: white(0.2), width: 1.0, radius: 8.0.into() },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The camera name on a tile.
pub fn tile_label(_: &Theme) -> container::Style {
    container::Style {
        background: Some(black(0.4).into()),
        border: Border { color: white(0.10), width: 1.0, radius: 999.0.into() },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The control bar along the bottom, full width.
pub fn control_bar(_: &Theme) -> container::Style {
    // The panel gradient over the page background.
    let fill = iced::gradient::Linear::new(iced::Degrees(150.0))
        .add_stop(0.0, rgb(0x14, 0x16, 0x19))
        .add_stop(0.55, rgb(0x0c, 0x0e, 0x11))
        .add_stop(1.0, rgb(0x0e, 0x10, 0x13));
    container::Style {
        background: Some(Background::Gradient(fill.into())),
        shadow: Shadow { color: black(0.30), offset: Vector::new(0.0, -4.0), blur_radius: 20.0 },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

/// The 1 px line along the top of the control bar.
pub fn hairline(_: &Theme) -> container::Style {
    container::Style { background: Some(white(0.10).into()), ..Default::default() }
}

/// The control bar's own top highlight: a faint 1 px white line along its
/// top.
pub fn inset_highlight(_: &Theme) -> container::Style {
    container::Style { background: Some(white(0.06).into()), ..Default::default() }
}

/// The clip browser's logo: the camera icon in a tinted square.
pub fn logo(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color { a: 0.18, ..ACCENT }.into()),
        border: Border { radius: 10.0.into(), ..Default::default() },
        text_color: Some(ACCENT),
        ..Default::default()
    }
}

/// The time display and the recording-time pill.
pub fn time_pill(_: &Theme) -> container::Style {
    container::Style {
        background: Some(black(0.4).into()),
        border: Border { radius: 8.0.into(), ..Default::default() },
        text_color: Some(TEXT),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Liquid glass (the card material, from Sentry Drive)
// ---------------------------------------------------------------------------

/// The card fill: a 150° white gradient, 7.5% → 3% → 5%.
fn glass_fill(strong: bool) -> Background {
    let (a, b, c) = if strong { (0.13, 0.05, 0.085) } else { (0.075, 0.03, 0.05) };
    Background::Gradient(
        iced::gradient::Linear::new(iced::Degrees(150.0))
            .add_stop(0.0, white(a))
            .add_stop(0.55, white(b))
            .add_stop(1.0, white(c))
            .into(),
    )
}

/// The same gradient tinted with the accent, for the selected card.
fn accent_fill() -> Background {
    Background::Gradient(
        iced::gradient::Linear::new(iced::Degrees(150.0))
            .add_stop(0.0, Color { a: 0.18, ..ACCENT })
            .add_stop(0.6, Color { a: 0.06, ..ACCENT })
            .add_stop(1.0, Color { a: 0.10, ..ACCENT })
            .into(),
    )
}

/// A glass button: the control bar's buttons.
pub fn glass_button(radius: f32) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let (fill, border) = match status {
            button::Status::Hovered | button::Status::Pressed => (glass_fill(true), white(0.18)),
            button::Status::Disabled => (Background::Color(white(0.025)), white(0.06)),
            button::Status::Active => (glass_fill(false), white(0.12)),
        };
        button::Style {
            background: Some(fill),
            text_color: if matches!(status, button::Status::Disabled) { white(0.25) } else { TEXT },
            border: Border { color: border, width: 1.0, radius: radius.into() },
            shadow: Shadow { color: black(0.35), offset: Vector::new(0.0, 4.0), blur_radius: 12.0 },
            snap: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/// A card in the clip list.
pub fn clip_card(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        let (bg, border) = if selected {
            (accent_fill(), Color { a: 0.55, ..ACCENT })
        } else if hovered {
            (glass_fill(true), Color { a: 0.45, ..ACCENT_HOVER })
        } else {
            (glass_fill(false), white(0.12))
        };
        button::Style {
            background: Some(bg),
            text_color: TEXT,
            border: Border { color: border, width: 1.0, radius: 18.0.into() },
            shadow: Shadow { color: black(0.45), offset: Vector::new(0.0, 12.0), blur_radius: 34.0 },
            snap: true,
        }
    }
}

/// An icon button: an icon on a transparent background.
pub fn icon_button(_: &Theme, status: button::Status) -> button::Style {
    let bg = match status {
        button::Status::Hovered => Some(white(0.07).into()),
        button::Status::Pressed => Some(white(0.12).into()),
        _ => None,
    };
    button::Style {
        background: bg,
        text_color: if matches!(status, button::Status::Disabled) { TEXT_FAINT } else { TEXT },
        border: Border { radius: 10.0.into(), ..Default::default() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// The "Choose Folder" button in an empty clip list.
pub fn accent_button(_: &Theme, status: button::Status) -> button::Style {
    let bg = match status {
        button::Status::Hovered | button::Status::Pressed => Color { a: 0.28, ..ACCENT },
        _ => Color { a: 0.18, ..ACCENT },
    };
    button::Style {
        background: Some(bg.into()),
        text_color: ACCENT_HOVER,
        border: Border { color: Color { a: 0.35, ..ACCENT }, width: 1.0, radius: 12.0.into() },
        shadow: Shadow::default(),
        snap: true,
    }
}

/// A Clips / Drives tab; the active one is lifted and green.
pub fn tab(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered);
        button::Style {
            background: if active { Some(white(0.14).into()) } else if hovered { Some(white(0.06).into()) } else { None },
            text_color: if active { ACCENT_HOVER } else { TEXT_FAINT },
            border: Border { radius: 9.0.into(), ..Default::default() },
            shadow: if active {
                Shadow { color: black(0.25), offset: Vector::new(0.0, 2.0), blur_radius: 10.0 }
            } else {
                Shadow::default()
            },
            snap: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// The playback speed select.
pub fn select(_: &Theme, status: pick_list::Status) -> pick_list::Style {
    let hovered = matches!(status, pick_list::Status::Hovered | pick_list::Status::Opened { .. });
    pick_list::Style {
        text_color: TEXT,
        placeholder_color: TEXT_MUTED,
        handle_color: TEXT_MUTED,
        background: glass_fill(hovered),
        border: Border { color: if hovered { white(0.18) } else { white(0.12) }, width: 1.0, radius: 10.0.into() },
    }
}

/// The day filter's date pill.
pub fn day_select(_: &Theme, status: pick_list::Status) -> pick_list::Style {
    let hovered = matches!(status, pick_list::Status::Hovered | pick_list::Status::Opened { .. });
    pick_list::Style {
        text_color: TEXT,
        placeholder_color: TEXT_MUTED,
        handle_color: TEXT_MUTED,
        background: (if hovered { rgba(12, 16, 28, 0.95) } else { rgba(5, 8, 18, 0.9) }).into(),
        border: Border { color: white(0.18), width: 1.0, radius: 999.0.into() },
    }
}

/// A hover label on a control, as earlier versions' title text: small text
/// on a dark rounded box, after a short pause.
pub fn tip<'a, M: 'a>(content: impl Into<iced::Element<'a, M>>, label: impl Into<String>, position: iced::widget::tooltip::Position) -> iced::Element<'a, M> {
    iced::widget::tooltip(content, text(label.into()).size(11).color(TEXT), position)
        .gap(6)
        .padding(6)
        .delay(std::time::Duration::from_millis(500))
        .snap_within_viewport(true)
        .style(tooltip)
        .into()
}

/// The box behind a hover label.
pub fn tooltip(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color::from_rgba8(20, 22, 28, 0.95).into()),
        border: Border { color: white(0.1), width: 1.0, radius: 6.0.into() },
        shadow: Shadow { color: black(0.4), offset: Vector::new(0.0, 2.0), blur_radius: 8.0 },
        ..Default::default()
    }
}
