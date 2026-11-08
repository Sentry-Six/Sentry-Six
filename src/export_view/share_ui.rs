//! Share Clip in the export dialog: the option before exporting, sharing
//! the finished video (a link at clip.sentry-six.com, its upload's
//! progress, Copy and Open), and the list of clips shared from here.
//!
//! A share is never sent without a click on the finished screen. It needs
//! an H.264 export below Maximum quality (so the link plays in every
//! browser), of ten minutes or less and at most 3 GB (the server's
//! limits, as earlier versions kept them).

use super::{card_style, info, labelled, primary, progress_bar, secondary, select, wrap, ExportMsg, State};
use crate::export::encode::Format;
use crate::export::job::Quality;
use crate::i18n::{t, tf};
use crate::share::{self, Reserved, SharedClip, Status};
use crate::theme;
use crate::{measured, off_thread_or, App, Message};
use iced::widget::{button, column, container, mouse_area, opaque, row, space, text, toggler, Column};
use iced::{Alignment, Element, Length, Task};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Where a share of the finished video is.
#[derive(Debug, Clone, Default)]
pub enum Sharing {
    #[default]
    Idle,
    Reserving,
    /// The link (when reserved: shown while the file goes up) and the
    /// file's size.
    Uploading { url: Option<String>, total: u64 },
    Done(SharedClip),
    Failed(String),
}

/// Sharing's part of the export dialog.
#[derive(Debug)]
pub struct ShareUi {
    /// "Generate Shareable Link" before exporting: the finished screen then
    /// asks to confirm the upload.
    pub intent: bool,
    pub hours: f64,
    pub state: Sharing,
    /// Which share the answers belong to.
    id: u64,
    sent: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
    /// A link was just copied ("Copied!").
    copied: bool,
    /// The list of shared clips is open; a clip waiting to be confirmed
    /// for deletion; one being deleted.
    pub list_open: bool,
    confirm: Option<String>,
    deleting: Option<String>,
}

impl Default for ShareUi {
    fn default() -> Self {
        ShareUi {
            intent: false,
            hours: share::DEFAULT_HOURS,
            state: Sharing::Idle,
            id: 0,
            sent: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
            copied: false,
            list_open: false,
            confirm: None,
            deleting: None,
        }
    }
}

impl ShareUi {
    pub fn uploading(&self) -> bool {
        matches!(self.state, Sharing::Reserving | Sharing::Uploading { .. })
    }

    /// A new export: nothing shared yet.
    pub fn reset(&mut self) {
        self.state = Sharing::Idle;
        self.copied = false;
    }
}

#[derive(Debug, Clone)]
pub enum ShareMsg {
    Intent(bool),
    HoursMenu,
    Hours(usize),
    Start,
    Reserved(u64, Result<Reserved, String>),
    Tick(u64),
    Finished(u64, Result<SharedClip, String>),
    Cancel,
    Copy(String),
    CopiedReset,
    Open(String),
    ListOpen,
    ListClose,
    Synced(Result<HashMap<String, Status>, String>),
    AskDelete(String),
    KeepClip,
    Delete(String),
    Deleted(String, Result<(), String>),
}

fn msg(m: ShareMsg) -> Message {
    wrap(ExportMsg::Share(m))
}

/// Why this export can't be shared, if it can't: too long, too big, or
/// not H.264 below Maximum.
fn refusal(seconds: f64, bytes: Option<u64>, format: Format, quality: Quality) -> Option<String> {
    if seconds > share::MAX_SECONDS + 0.5 {
        return Some(t("ui.export.shareClipWarning").to_string());
    }
    if format != Format::H264 || quality == Quality::Max {
        return Some(t("ui.share.needsH264").to_string());
    }
    if bytes.is_some_and(|b| b > share::MAX_BYTES) {
        return Some(t("ui.share.tooBig").to_string());
    }
    None
}

fn hours_select(current: f64, enabled: bool) -> Element<'static, Message> {
    let labels: Vec<String> = share::HOURS.iter().map(|h| share::hours_label(*h)).collect();
    let index = share::HOURS.iter().position(|h| *h == current).unwrap_or(6);
    select(labels, index, enabled, ExportMsg::Share(ShareMsg::HoursMenu), |i| ExportMsg::Share(ShareMsg::Hours(i)))
}

impl App {
    pub(crate) fn share_step(&mut self, m: ShareMsg) -> Task<Message> {
        let s = &mut self.export.share;
        match m {
            ShareMsg::Intent(on) => s.intent = on,
            ShareMsg::HoursMenu => {
                let labels: Vec<String> = share::HOURS.iter().map(|h| share::hours_label(*h)).collect();
                let current = share::HOURS.iter().position(|h| *h == s.hours);
                return crate::native_menu::choose(labels, current, |i| crate::export_view::wrap(ExportMsg::Share(ShareMsg::Hours(i))));
            }
            ShareMsg::Hours(i) => {
                if let Some(h) = share::HOURS.get(i).filter(|_| !s.uploading()) {
                    s.hours = *h;
                }
            }
            ShareMsg::Start => {
                let State::Done { length, format, quality, bytes, .. } = &self.export.state else { return Task::none() };
                if s.uploading() || refusal(*length, Some(*bytes), *format, *quality).is_some() {
                    return Task::none();
                }
                s.id += 1;
                s.state = Sharing::Reserving;
                s.copied = false;
                let (id, hours) = (s.id, s.hours);
                return Task::perform(off_thread_or(Err("the share stopped unexpectedly".into()), move || share::reserve(hours)), move |r| msg(ShareMsg::Reserved(id, r)));
            }
            ShareMsg::Reserved(id, result) => {
                let State::Done { output, bytes, .. } = &self.export.state else { return Task::none() };
                if id != s.id || !matches!(s.state, Sharing::Reserving) {
                    return Task::none();
                }
                // Without a reservation the upload makes its own link.
                let (url, code) = match result {
                    Ok(r) => (Some(r.url), Some(r.code)),
                    Err(e) => {
                        log::warn!("share: no reservation ({e}); uploading without one");
                        (None, None)
                    }
                };
                s.state = Sharing::Uploading { url, total: *bytes };
                s.sent = Arc::new(AtomicU64::new(0));
                s.cancel = Arc::new(AtomicBool::new(false));
                let (path, hours, sent, cancel) = (output.clone(), s.hours, s.sent.clone(), s.cancel.clone());
                log::info!("share: uploading {:.1} MB for {} h", *bytes as f64 / 1e6, hours);
                let upload = Task::perform(
                    off_thread_or(Err("the share stopped unexpectedly".into()), move || share::upload(&path, hours, code.as_deref(), sent, cancel)),
                    move |r| msg(ShareMsg::Finished(id, r)),
                );
                return Task::batch([upload, tick(id)]);
            }
            ShareMsg::Tick(id) => {
                if id == s.id && s.uploading() {
                    return tick(id);
                }
            }
            ShareMsg::Finished(id, result) => {
                if id != s.id {
                    return Task::none();
                }
                match result {
                    Ok(clip) => {
                        log::info!("share: shared as {}", clip.url);
                        share::remember(&mut self.settings.shared_clips, clip.clone());
                        crate::settings::save(&self.settings);
                        self.export.share.state = Sharing::Done(clip);
                        return self.notify(t("ui.share.shared").to_string(), false);
                    }
                    Err(e) if e == "cancelled" => s.state = Sharing::Idle,
                    Err(e) => {
                        log::warn!("share: upload failed: {e}");
                        s.state = Sharing::Failed(e);
                    }
                }
            }
            ShareMsg::Cancel => s.cancel.store(true, Ordering::Relaxed),
            ShareMsg::Copy(url) => {
                s.copied = true;
                let reset = Task::perform(async { std::thread::sleep(Duration::from_secs(2)) }, |_| msg(ShareMsg::CopiedReset));
                return Task::batch([iced::clipboard::write(url), reset]);
            }
            ShareMsg::CopiedReset => s.copied = false,
            ShareMsg::Open(url) => crate::open_url(&url),
            ShareMsg::ListOpen => {
                s.list_open = true;
                s.confirm = None;
                // What the server still has (the list stays as it is when
                // it can't be asked).
                let codes: Vec<String> = self.settings.shared_clips.iter().map(|c| c.code.clone()).collect();
                if !codes.is_empty() {
                    return Task::perform(off_thread_or(Err(String::new()), move || share::check(&codes)), |r| msg(ShareMsg::Synced(r)));
                }
            }
            ShareMsg::ListClose => {
                s.list_open = false;
                s.confirm = None;
            }
            ShareMsg::Synced(Ok(statuses)) => {
                share::apply_statuses(&mut self.settings.shared_clips, &statuses);
                crate::settings::save(&self.settings);
            }
            ShareMsg::Synced(Err(e)) => log::info!("share: couldn't check the shared clips: {e}"),
            ShareMsg::AskDelete(code) => s.confirm = Some(code),
            ShareMsg::KeepClip => s.confirm = None,
            ShareMsg::Delete(code) => {
                s.confirm = None;
                let Some(clip) = self.settings.shared_clips.iter().find(|c| c.code == code).cloned() else { return Task::none() };
                s.deleting = Some(code.clone());
                return Task::perform(off_thread_or(Err("stopped".into()), move || share::delete(&clip.code, &clip.delete_token)), move |r| msg(ShareMsg::Deleted(code.clone(), r)));
            }
            ShareMsg::Deleted(code, result) => {
                s.deleting = None;
                if let Err(e) = &result {
                    log::warn!("share: deleting {code}: {e}");
                }
                // Gone from the list either way, as earlier versions did:
                // the server no longer has it, or the token can't remove it.
                self.settings.shared_clips.retain(|c| c.code != code);
                crate::settings::save(&self.settings);
            }
        }
        Task::none()
    }

    /// "Share Clip" in the export dialog: the option to share once it's
    /// made, how long the link lasts, and why it can't be when it can't.
    pub(crate) fn share_section(&self, seconds: f64, format: Format) -> Element<'static, Message> {
        let s = &self.export.share;
        let busy = self.export.running();
        let refused = refusal(seconds, None, format, self.export.quality);
        let mut col = Column::new().spacing(8);
        col = col.push(labelled(
            t("ui.export.generateShareableLink"),
            t("ui.export.generateShareableLinkDesc"),
            toggler(s.intent && refused.is_none())
                .size(22)
                .on_toggle_maybe((!busy && refused.is_none()).then_some(|b| msg(ShareMsg::Intent(b))))
                .style(theme::toggle)
                .into(),
        ));
        if let Some(why) = refused {
            col = col.push(info(why, theme::WARNING));
        } else if s.intent {
            col = col.push(super::sub(labelled(t("ui.share.duration"), "", hours_select(s.hours, !busy))));
            let words = t("ui.export.shareClipInfo").replace("<strong>", "").replace("</strong>", "");
            col = col.push(text(words.replace("{hours}", &share::hours_label(s.hours))).size(10).color(theme::TEXT_MUTED));
        }
        if !self.settings.shared_clips.is_empty() {
            col = col.push(
                row![space().width(Length::Fill), secondary(format!("{} ({})", t("ui.sharedClips.title"), self.settings.shared_clips.len()), Some(msg(ShareMsg::ListOpen)))]
                    .align_y(Alignment::Center),
            );
        }
        col.into()
    }

    /// Sharing on the finished screen.
    pub(crate) fn share_block(&self, bytes: u64, length: f64, format: Format, quality: Quality) -> Element<'_, Message> {
        let s = &self.export.share;
        let mut col = Column::new().spacing(8);
        let title = row![text(t("ui.export.shareClip")).size(12).font(theme::semibold(theme::INTER)), space().width(Length::Fill)].align_y(Alignment::Center);
        let title = if self.settings.shared_clips.is_empty() {
            title
        } else {
            title.push(button(text(t("ui.sharedClips.title")).size(11).color(theme::ACCENT)).padding(0).style(|_, _| button::Style::default()).on_press(msg(ShareMsg::ListOpen)))
        };
        col = col.push(title);
        if let Some(why) = refusal(length, Some(bytes), format, quality) {
            col = col.push(text(why).size(11).color(theme::TEXT_MUTED));
            return container(col).padding([10, 12]).width(Length::Fill).style(card_style(false)).into();
        }
        let link = |url: &str, copied: bool| -> Element<'_, Message> {
            row![
                container(text(url.to_string()).size(12).font(theme::MONO)).padding([7, 10]).width(Length::Fill).style(card_style(false)),
                secondary(if copied { t("ui.share.copied") } else { t("ui.share.copy") }, Some(msg(ShareMsg::Copy(url.to_string())))),
                secondary(t("ui.sharedClips.open"), Some(msg(ShareMsg::Open(url.to_string())))),
            ]
            .spacing(8)
            .align_y(Alignment::Center)
            .into()
        };
        match &s.state {
            Sharing::Idle | Sharing::Failed(_) => {
                if let Sharing::Failed(e) = &s.state {
                    col = col.push(text(tf("ui.share.failed", &[("error", e)])).size(11).color(theme::ERROR));
                }
                let label = match (&s.state, s.intent) {
                    (Sharing::Failed(_), _) => t("ui.share.retry"),
                    (_, true) => t("ui.share.confirmUpload"),
                    _ => t("ui.export.shareClip"),
                };
                col = col.push(
                    row![
                        text(t("ui.share.duration")).size(11).color(theme::TEXT_SECONDARY),
                        hours_select(s.hours, true),
                        space().width(Length::Fill),
                        primary(label, Some(msg(ShareMsg::Start))),
                    ]
                    .spacing(8)
                    .align_y(Alignment::Center),
                );
            }
            Sharing::Reserving => {
                col = col.push(text(t("ui.share.reserving")).size(11).color(theme::TEXT_SECONDARY));
                col = col.push(progress_bar(0.0));
            }
            Sharing::Uploading { url, total } => {
                if let Some(url) = url {
                    col = col.push(link(url, s.copied));
                }
                let sent = s.sent.load(Ordering::Relaxed).min(*total);
                let frac = sent as f32 / (*total).max(1) as f32;
                let words = tf(
                    "ui.share.uploading",
                    &[("done", &format!("{:.1}", sent as f64 / 1_048_576.0)), ("total", &format!("{:.1}", *total as f64 / 1_048_576.0)), ("percent", &format!("{:.0}", frac * 100.0))],
                );
                col = col.push(row![text(words).size(11).color(theme::TEXT_SECONDARY), space().width(Length::Fill), secondary(t("ui.export.cancel"), Some(msg(ShareMsg::Cancel)))].align_y(Alignment::Center));
                col = col.push(progress_bar(frac));
            }
            Sharing::Done(clip) => {
                col = col.push(link(&clip.url, s.copied));
                col = col.push(text(tf("ui.export.shareLinkExpiry", &[("hours", &share::hours_label(s.hours))])).size(10).color(theme::TEXT_MUTED));
            }
        }
        container(col).padding([10, 12]).width(Length::Fill).style(card_style(false)).into()
    }

    /// "My Shared Clips": each clip with its time left, Copy, Open and
    /// Delete (confirmed first).
    pub(crate) fn shared_clips_dialog(&self) -> Element<'_, Message> {
        let s = &self.export.share;
        let now = chrono::Utc::now();
        let header = row![
            text(t("ui.sharedClips.title")).size(15).font(theme::semibold(theme::INTER)),
            space().width(Length::Fill),
            button(container(text("×").size(18)).center(Length::Fill)).width(28).height(28).padding(0).style(theme::modal_close).on_press(msg(ShareMsg::ListClose)),
        ]
        .align_y(Alignment::Center);
        let mut list = Column::new().spacing(8);
        if self.settings.shared_clips.is_empty() {
            list = list.push(
                column![
                    text(t("ui.sharedClips.emptyTitle")).size(13).font(theme::semibold(theme::INTER)),
                    text(t("ui.sharedClips.emptyDesc")).size(11).color(theme::TEXT_MUTED)
                ]
                .spacing(4)
                .align_x(Alignment::Center)
                .width(Length::Fill),
            );
        }
        for clip in &self.settings.shared_clips {
            let expired = clip.seconds_left(now).is_none_or(|left| left <= 0);
            let name = if clip.file_name.is_empty() { clip.code.clone() } else { clip.file_name.clone() };
            let facts = format!("{:.1} MB  ·  {}", clip.file_size as f64 / 1e6, share::time_left(clip, now));
            let mut item = Column::new().spacing(6).push(
                row![
                    column![
                        text(name.clone()).size(12).font(theme::semibold(theme::INTER)),
                        text(facts).size(10).color(if expired { theme::TEXT_MUTED } else { theme::TEXT_SECONDARY })
                    ]
                    .spacing(2)
                    .width(Length::Fill),
                    row![
                        if expired { space().width(0).into() } else { secondary(t("ui.sharedClips.copyLink"), Some(msg(ShareMsg::Copy(clip.url.clone())))) },
                        if expired { space().width(0).into() } else { secondary(t("ui.sharedClips.open"), Some(msg(ShareMsg::Open(clip.url.clone())))) },
                        secondary(
                            if s.deleting.as_deref() == Some(clip.code.as_str()) { "…".to_string() } else { t("ui.sharedClips.delete").to_string() },
                            (s.deleting.is_none()).then_some(msg(ShareMsg::AskDelete(clip.code.clone()))),
                        ),
                    ]
                    .spacing(6),
                ]
                .spacing(10)
                .align_y(Alignment::Center),
            );
            if s.confirm.as_deref() == Some(clip.code.as_str()) {
                item = item.push(info(format!("{} {name}? {}", t("ui.sharedClips.deleteConfirm"), t("ui.sharedClips.deleteWarning")), theme::WARNING));
                item = item.push(
                    row![
                        space().width(Length::Fill),
                        secondary(t("ui.sharedClips.cancel"), Some(msg(ShareMsg::KeepClip))),
                        primary(t("ui.sharedClips.deleteClip"), Some(msg(ShareMsg::Delete(clip.code.clone())))),
                    ]
                    .spacing(8),
                );
            }
            list = list.push(container(item).padding([10, 12]).width(Length::Fill).style(card_style(false)));
        }
        let body = iced::widget::scrollable(container(list).padding(20)).style(theme::thin_scroll);
        let footer = row![space().width(Length::Fill), primary(t("ui.settings.done"), Some(msg(ShareMsg::ListClose)))];
        let dialog = container(column![
            container(header).padding([16, 20]).style(theme::modal_header),
            container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
            container(body).max_height(460),
            container(footer).padding([16, 20]).width(Length::Fill).style(theme::modal_footer),
        ])
        .width(620)
        .clip(true)
        .style(theme::modal);
        opaque(mouse_area(container(measured(dialog)).center(Length::Fill).style(theme::backdrop)).on_press(msg(ShareMsg::ListClose)))
    }
}

/// Redraws the upload's progress four times a second.
fn tick(id: u64) -> Task<Message> {
    Task::perform(async { std::thread::sleep(Duration::from_millis(250)) }, move |_| msg(ShareMsg::Tick(id)))
}
