//! The update dialog (a new version, its download and install, or a version
//! the server says must be replaced by hand), the question asked before
//! switching to pre-release updates, and the changelog.

use crate::i18n::{t, tf};
use crate::theme;
use crate::update::{How, Note, Offer};
use crate::Message;
use iced::widget::{button, column, container, mouse_area, opaque, row, scrollable, space, text, Column};
use iced::{Alignment, Background, Border, Color, Element, Length};

const DOWNLOAD_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>"#;
const DOC_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>"#;
const ARROW_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>"#;

/// Where an update stands.
#[derive(Debug, Clone)]
pub enum Dialog {
    Offer(Offer),
    Downloading(Offer),
    Installing(Offer),
    Failed(Offer, String),
    /// The server's killswitch: this version must be replaced by hand.
    Critical { version: String, message: String, url: String },
}

impl Dialog {
    /// Downloading or installing: it can't be closed.
    pub fn busy(&self) -> bool {
        matches!(self, Dialog::Downloading(_) | Dialog::Installing(_))
    }
}

fn badge(label: &str, version: &str, accent: bool) -> Element<'static, Message> {
    column![
        text(label.to_uppercase()).size(10).color(theme::TEXT_MUTED),
        text(version.to_string()).size(15).font(theme::semibold(theme::INTER)).color(if accent { theme::SUCCESS } else { theme::TEXT }),
    ]
    .spacing(2)
    .align_x(Alignment::Center)
    .into()
}

/// Each version's title and changes.
fn notes(notes: &[Note]) -> Element<'_, Message> {
    if notes.is_empty() {
        return text(t("app.updateNoChangelog")).size(12).color(theme::TEXT_MUTED).into();
    }
    let mut list = Column::new().spacing(14);
    for note in notes {
        let mut entry = column![row![
            text(format!("v{}", note.version)).size(12).font(theme::semibold(theme::INTER)).color(theme::ACCENT),
            text(note.date.clone()).size(11).color(theme::TEXT_MUTED),
        ]
        .spacing(8)
        .align_y(Alignment::Center)]
        .spacing(6);
        if !note.title.is_empty() {
            entry = entry.push(text(note.title.clone()).size(13).font(theme::semibold(theme::INTER)));
        }
        for (kind, description) in &note.changes {
            let mark = match kind.as_str() {
                "feature" => "✦",
                "improvement" => "↑",
                "fix" => "✓",
                _ => "•",
            };
            entry = entry.push(
                row![text(mark).size(12).color(theme::ACCENT).width(14), text(description.clone()).size(12).color(theme::TEXT_SECONDARY).width(Length::Fill)].spacing(6),
            );
        }
        list = list.push(entry);
    }
    // Long changelogs scroll inside the dialog.
    container(scrollable(list).height(Length::Shrink).style(theme::thin_scroll)).max_height(380).into()
}

fn progress_bar<'a>(fraction: f32) -> Element<'a, Message> {
    let filled = (fraction.clamp(0.0, 1.0) * 1000.0).round() as u16;
    let fill = container(space().height(6)).width(Length::FillPortion(filled.max(1))).style(|_: &iced::Theme| container::Style {
        background: Some(Background::Color(theme::ACCENT)),
        border: Border { radius: 3.0.into(), ..Default::default() },
        ..Default::default()
    });
    let mut bar = row![fill];
    if filled < 1000 {
        bar = bar.push(space().width(Length::FillPortion(1000 - filled)));
    }
    container(bar)
        .width(Length::Fill)
        .style(|_: &iced::Theme| container::Style {
            background: Some(Background::Color(Color::from_rgba(1.0, 1.0, 1.0, 0.08))),
            border: Border { radius: 3.0.into(), ..Default::default() },
            ..Default::default()
        })
        .into()
}

fn frame<'a>(title: String, glyph: Element<'a, Message>, body: Element<'a, Message>, footer: Element<'a, Message>, close: Option<Message>) -> Element<'a, Message> {
    let mut header = row![glyph, text(title).size(15).font(theme::semibold(theme::INTER)), space().width(Length::Fill)].spacing(8).align_y(Alignment::Center);
    if let Some(m) = close.clone() {
        header = header.push(button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(m));
    }
    let dialog = container(column![
        container(header).padding([16, 20]).style(theme::modal_header),
        container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
        container(body).padding(20).max_height(460),
        container(footer).padding([16, 20]).width(Length::Fill).style(theme::modal_footer),
    ])
    .width(460)
    .clip(true)
    .style(theme::modal);
    let backdrop = mouse_area(container(opaque(dialog)).center(Length::Fill).style(theme::backdrop));
    opaque(match close {
        Some(m) => backdrop.on_press(m),
        None => backdrop,
    })
}

/// `downloaded`: bytes so far, while downloading.
pub fn view(dialog: &Dialog, downloaded: u64) -> Element<'_, Message> {
    let (offer, failed) = match dialog {
        Dialog::Critical { version, message, url } => {
            let message = if message.is_empty() { t("app.updateCriticalDefault").to_string() } else { message.clone() };
            let body = column![
                row![badge(t("app.updateCurrent"), crate::update::current(), false), crate::svg_icon(ARROW_SVG, 18.0, theme::TEXT_MUTED), badge(t("app.updateNew"), version, true)]
                    .spacing(24)
                    .align_y(Alignment::Center),
                container(
                    column![
                        row![theme::icon(theme::icon::WARNING, 18.0).color(theme::ERROR), text(t("app.updateCritical")).size(14).font(theme::semibold(theme::INTER)).color(theme::ERROR)]
                            .spacing(8)
                            .align_y(Alignment::Center),
                        text(message).size(12).color(theme::TEXT_SECONDARY),
                    ]
                    .spacing(8),
                )
                .padding(14)
                .width(Length::Fill)
                .style(theme::path_box),
            ]
            .spacing(18)
            .align_x(Alignment::Center);
            let download = button(text(t("app.updateDownloadGithub")).size(13).font(theme::semibold(theme::INTER)))
                .padding([10, 16])
                .style(theme::danger_button)
                .on_press(Message::UpdateOpen(url.clone()));
            let footer = row![space().width(Length::Fill), download].into();
            return frame(t("app.updateCritical").to_string(), crate::svg_icon(DOWNLOAD_SVG, 20.0, theme::ERROR), body.into(), footer, None);
        }
        Dialog::Offer(o) | Dialog::Downloading(o) | Dialog::Installing(o) => (o, None),
        Dialog::Failed(o, e) => (o, Some(e)),
    };
    let mut body = column![
        container(
            row![badge(t("app.updateCurrent"), crate::update::current(), false), crate::svg_icon(ARROW_SVG, 18.0, theme::TEXT_MUTED), badge(t("app.updateNew"), &offer.version, true)]
                .spacing(24)
                .align_y(Alignment::Center),
        )
        .center_x(Length::Fill),
        text(t("app.updateWhatsNew").to_uppercase()).size(11).font(theme::semibold(theme::INTER)).color(theme::TEXT_MUTED),
        notes(&offer.notes),
    ]
    .spacing(14);
    match offer.how {
        How::Page => body = body.push(text(t("app.updatePageHint")).size(12).color(theme::TEXT_MUTED)),
        How::OlderPage => body = body.push(text(t("app.updateOlderHint")).size(12).color(theme::TEXT_MUTED)),
        How::InApp => {}
    }
    match dialog {
        Dialog::Downloading(_) => {
            let fraction = if offer.asset.size > 0 { downloaded as f32 / offer.asset.size as f32 } else { 0.0 };
            let percent = format!("{}", (fraction * 100.0).floor().clamp(0.0, 100.0) as u32);
            body = body.push(column![progress_bar(fraction), text(tf("app.updateDownloading", &[("percent", &percent)])).size(12).color(theme::TEXT_SECONDARY)].spacing(8));
        }
        Dialog::Installing(_) => {
            body = body.push(column![progress_bar(1.0), text(t("app.updateInstalling")).size(12).color(theme::TEXT_SECONDARY)].spacing(8));
        }
        _ => {}
    }
    if let Some(e) = failed {
        body = body.push(text(tf("app.updateFailed", &[("error", e)])).size(12).color(theme::ERROR));
    }
    let busy = dialog.busy();
    let later = button(text(t("app.updateLater")).size(13).font(theme::semibold(theme::INTER)))
        .padding([10, 16])
        .style(theme::secondary_button)
        .on_press_maybe((!busy).then_some(Message::UpdateLater));
    let go = match offer.how {
        How::InApp => button(
            row![crate::svg_icon(DOWNLOAD_SVG, 14.0, theme::BG), text(t("app.updateNow")).size(13).font(theme::semibold(theme::INTER))]
                .spacing(6)
                .align_y(Alignment::Center),
        )
        .padding([10, 16])
        .style(theme::primary_button)
        .on_press_maybe((!busy).then_some(Message::UpdateNow)),
        How::Page | How::OlderPage => button(text(t("app.updateOpenPage")).size(13).font(theme::semibold(theme::INTER)))
            .padding([10, 16])
            .style(theme::primary_button)
            .on_press(Message::UpdateOpen(offer.page.clone())),
    };
    let footer = row![space().width(Length::Fill), later, go].spacing(10).into();
    frame(t("app.updateTitle").to_string(), crate::svg_icon(DOWNLOAD_SVG, 20.0, theme::SUCCESS), body.into(), footer, (!busy).then_some(Message::UpdateLater))
}

/// Asked before switching to pre-release updates.
pub fn prerelease_question<'a>() -> Element<'a, Message> {
    let body = text(t("ui.settings.prereleaseWarnBody")).size(13).color(theme::TEXT_SECONDARY);
    let cancel = button(text(t("ui.settings.prereleaseWarnCancel")).size(13).font(theme::semibold(theme::INTER)))
        .padding([10, 16])
        .style(theme::secondary_button)
        .on_press(Message::PrereleaseAnswer(false));
    let confirm = button(text(t("ui.settings.prereleaseWarnConfirm")).size(13).font(theme::semibold(theme::INTER)))
        .padding([10, 16])
        .style(theme::primary_button)
        .on_press(Message::PrereleaseAnswer(true));
    let footer = row![space().width(Length::Fill), cancel, confirm].spacing(10).into();
    let glyph = crate::svg_icon(DOWNLOAD_SVG, 20.0, theme::WARNING);
    frame(t("ui.settings.prereleaseWarnTitle").to_string(), glyph, body.into(), footer, Some(Message::PrereleaseAnswer(false)))
}

/// Settings › View Changelog: every version, newest first.
pub fn changelog(all: &[Note]) -> Element<'_, Message> {
    let close = button(text(t("ui.changelog.close")).size(13).font(theme::semibold(theme::INTER)))
        .padding([10, 16])
        .style(theme::primary_button)
        .on_press(Message::ChangelogClose);
    let footer = row![space().width(Length::Fill), close].into();
    let glyph = crate::svg_icon(DOC_SVG, 18.0, theme::ACCENT);
    frame(t("ui.changelog.title").to_string(), glyph, notes(all), footer, Some(Message::ChangelogClose))
}
