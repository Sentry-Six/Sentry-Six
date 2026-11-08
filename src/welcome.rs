//! The first-run privacy notice: shown until accepted, and again whenever
//! PRIVACY_VERSION goes up. It cannot be dismissed any other way, and
//! Accept unlocks after 2 s.
//!
//! What this version sends differs from earlier versions of Sentry Studio
//! (place names are on by default), so its acceptance is kept in its own
//! settings file and its summary is app.privacySummary (the title, links
//! and button keep the earlier translations).

use crate::i18n::t;
use crate::theme;
use crate::Message;
use iced::widget::{button, column, container, opaque, row, text};
use iced::{Alignment, Element, Length};

/// Bump when what the app sends changes, so everyone sees it again.
pub const PRIVACY_VERSION: u32 = 2;

/// Accept unlocks after this long.
pub const ACCEPT_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

const SHIELD_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>"#;
const DOC_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>"#;
const LOCK_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>"#;
const CHECK_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>"#;


/// `elapsed`: how long the notice has been up (the shield's pulse and the
/// button's delay).
pub fn view<'a>(elapsed: f32) -> Element<'a, Message> {
    let ready = elapsed >= ACCEPT_DELAY.as_secs_f32();
    // The shield pulses: a 5% swell every 2 s.
    let pulse = 1.0 + 0.025 * (1.0 - (elapsed * std::f32::consts::PI).cos());
    let link = |glyph: &'static str, key: &'static str, url: &'static str| {
        button(row![crate::svg_icon(glyph, 14.0, theme::ACCENT), text(t(key)).size(13).font(theme::medium(theme::INTER))].spacing(6).align_y(Alignment::Center))
            .padding([6, 12])
            .style(theme::welcome_link)
            .on_press(Message::Setting(crate::settings_view::Change::OpenLink(url)))
    };
    let body = column![
        container(crate::svg_icon(SHIELD_SVG, 48.0 * pulse, theme::ACCENT)).center_x(Length::Fill).height(54),
        text(t("welcomeScreen.privacyTitle")).size(18).font(theme::semibold(theme::INTER)).color(theme::ACCENT),
        text(t("app.privacySummary")).size(14).line_height(1.7).center().width(380),
        row![
            link(DOC_SVG, "welcomeScreen.termsLink", crate::settings_view::TERMS_URL),
            link(LOCK_SVG, "welcomeScreen.privacyLink", crate::settings_view::PRIVACY_URL),
        ]
        .spacing(20),
    ]
    .spacing(16)
    .align_x(Alignment::Center);

    let accept = button(
        row![crate::svg_icon(CHECK_SVG, 16.0, theme::BG), text(t("welcomeScreen.acceptButton")).size(15).font(theme::semibold(theme::INTER))]
            .spacing(8)
            .align_y(Alignment::Center),
    )
    .padding([12, 28])
    .width(220)
    .style(theme::primary_button)
    .on_press_maybe(ready.then_some(Message::AcceptPrivacy));
    // Until it unlocks it has no action, so it shows the disabled style
    // (theme::primary_button: half strength).

    let dialog = container(column![
        container(text(t("welcomeScreen.title")).size(20).font(theme::semibold(theme::INTER))).center_x(Length::Fill).padding([24, 22]),
        container(container(iced::widget::space().height(1)).width(Length::Fill).style(theme::welcome_line)).padding([0, 22]),
        container(body).padding([30, 24]).width(Length::Fill),
        container(accept).center_x(Length::Fill).padding([20, 24]).style(theme::modal_footer),
    ])
    .width(480)
    .clip(true)
    .style(theme::modal);

    // Nothing behind it can be clicked, and clicks outside do nothing.
    opaque(container(crate::measured(dialog)).center(Length::Fill).style(theme::backdrop))
}
