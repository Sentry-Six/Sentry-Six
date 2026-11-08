//! The AI support chat panel: the notice, the conversation, the composer,
//! and the cards for a diagnostics request and for Discord. It floats at the
//! top right of the window, over frosted video, and stays open while you use
//! the app.
//!
//! Server text is shown as text only, with a small Markdown subset
//! (paragraphs, lists, bold, code). The chat's words are English, as in
//! earlier versions of Sentry Studio (the notice is legal wording).

use crate::support::{self, ApiError, ChatMessage, Conversation, FileRequest, Reply, Reset, Status};
use crate::theme;
use crate::{off_thread, off_thread_or, App, Message};
use iced::widget::{button, column, container, rich_text, row, scrollable, space, span, text, text_editor, Column};
use iced::{Alignment, Background, Border, Color, Element, Length, Task};
use std::collections::HashMap;

/// How often to ask for the answer while the assistant writes it.
const POLL: std::time::Duration = std::time::Duration::from_secs(2);

/// Where a diagnostics request stands, for one request of one message.
#[derive(Debug, Clone)]
pub enum FileState {
    Approving,
    Denying,
    Approved(String),
    Denied,
    /// What went wrong, and the decision to retry (if any).
    Failed(String, Option<bool>),
}

#[derive(Default)]
pub struct Chat {
    pub open: bool,
    /// The saved conversation has been read from the settings.
    loaded: bool,
    conversation: Option<Conversation>,
    disclosure_accepted: bool,
    /// The saved chat used an earlier notice: it must be deleted first.
    needs_new_notice: bool,
    messages: Vec<ChatMessage>,
    status: Option<Status>,
    sending: bool,
    deleting: bool,
    error: Option<String>,
    files: HashMap<(String, usize), FileState>,
    /// A message being sent (kept for a retry with the same ID).
    pending: Option<(String, String)>,
    composer: text_editor::Content,
    /// Where the panel was dragged to (top left) and resized to; while the
    /// app runs, as in earlier versions.
    pub pos: Option<iced::Point>,
    pub size: Option<iced::Size>,
    /// Bumped to cancel polls from an earlier conversation.
    poll_gen: u64,
}

impl Chat {
    fn status(&self) -> Status {
        self.status.unwrap_or(Status::Idle)
    }

    fn gated(&self) -> bool {
        (self.conversation.is_some() && self.needs_new_notice) || (self.conversation.is_none() && !self.disclosure_accepted)
    }
}

#[derive(Debug, Clone)]
pub enum ChatMsg {
    Toggle,
    Close,
    Acknowledge,
    Edit(text_editor::Action),
    Send,
    Sent { client_id: String, content: String, result: Result<Reply, ApiError> },
    Poll(u64),
    Polled(u64, Result<Reply, ApiError>),
    NewChat,
    ConfirmNew(bool),
    Deleted(Result<(), ApiError>),
    Forget,
    Decide { message_id: String, index: usize, approve: bool },
    Decided { message_id: String, index: usize, approve: bool, result: Result<Option<(String, u64)>, ApiError> },
    Uploaded { message_id: String, index: usize, result: Result<(String, u64), ApiError> },
    Link(&'static str),
    /// The header dragged, the corner grip dragged.
    Drag(f32, f32),
    Resize(f32, f32),
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn wrap(m: ChatMsg) -> Message {
    Message::Chat(m)
}

impl App {
    fn chat_persist(&mut self) {
        self.settings.support_chat = self.chat.conversation.as_ref().map(|c| crate::settings::SavedChat {
            id: c.id.clone(),
            auth_token: c.auth_token.clone(),
            stored_at: now_ms(),
            disclosure_version: support::DISCLOSURE_VERSION.into(),
        });
        crate::settings::save(&self.settings);
    }

    fn chat_reset(&mut self, error: Option<String>, keep_notice: bool) {
        let c = &mut self.chat;
        c.poll_gen += 1;
        c.conversation = None;
        c.messages.clear();
        c.status = None;
        c.files.clear();
        c.pending = None;
        c.needs_new_notice = false;
        c.disclosure_accepted = keep_notice && c.disclosure_accepted;
        c.error = error;
        self.chat_persist();
    }

    /// Handles errors that end the conversation; false for others.
    fn chat_reset_on(&mut self, e: &ApiError, unavailable: &str) -> bool {
        match e.reset() {
            Some(Reset::Disclosure) if self.chat.conversation.is_some() => {
                self.chat.poll_gen += 1;
                self.chat.needs_new_notice = true;
                self.chat.disclosure_accepted = false;
                self.chat.status = None;
                self.chat.error = None;
                true
            }
            Some(Reset::Unavailable) => {
                self.chat_reset(Some(unavailable.into()), false);
                true
            }
            _ => false,
        }
    }

    /// Takes the server's view; asks again in 2 s while it's writing.
    fn chat_apply(&mut self, reply: Reply) -> Task<Message> {
        support::merge(&mut self.chat.messages, reply.messages);
        self.chat.status = Some(reply.status);
        if reply.status == Status::Generating {
            self.chat_poll_later()
        } else {
            Task::none()
        }
    }

    fn chat_poll_later(&self) -> Task<Message> {
        let gen = self.chat.poll_gen;
        Task::perform(off_thread(move || std::thread::sleep(POLL)), move |_| wrap(ChatMsg::Poll(gen)))
    }

    fn chat_fetch(&self) -> Task<Message> {
        let Some(c) = self.chat.conversation.clone() else { return Task::none() };
        let gen = self.chat.poll_gen;
        let failed = Err(ApiError { message: "The request stopped".into(), status: 0, code: None });
        Task::perform(off_thread_or(failed, move || support::fetch(&c)), move |r| wrap(ChatMsg::Polled(gen, r)))
    }

    /// Reads the conversation saved by this or an earlier version, if it's
    /// recent enough to continue.
    fn chat_load(&mut self) {
        if self.chat.loaded {
            return;
        }
        self.chat.loaded = true;
        let Some(saved) = self.settings.support_chat.clone() else { return };
        let age = now_ms() - saved.stored_at;
        let c = Conversation { id: saved.id, auth_token: saved.auth_token };
        if !c.valid() || !(0..=support::STORED_MAX_AGE_MS).contains(&age) {
            self.settings.support_chat = None;
            crate::settings::save(&self.settings);
            return;
        }
        self.chat.conversation = Some(c);
        self.chat.disclosure_accepted = saved.disclosure_version == support::DISCLOSURE_VERSION;
        self.chat.needs_new_notice = !self.chat.disclosure_accepted;
    }

    pub(crate) fn chat_update(&mut self, m: ChatMsg) -> Task<Message> {
        match m {
            ChatMsg::Toggle => {
                self.chat.open = !self.chat.open;
                if self.chat.open {
                    self.chat_load();
                    if self.chat.conversation.is_some() && !self.chat.needs_new_notice {
                        return self.chat_fetch();
                    }
                }
            }
            ChatMsg::Close => self.chat.open = false,
            ChatMsg::Acknowledge => {
                self.chat.disclosure_accepted = true;
                self.chat.error = None;
            }
            ChatMsg::Edit(action) => {
                // The gateway takes 5,000 characters.
                let typing = action.is_edit();
                self.chat.composer.perform(action);
                if typing && self.chat.composer.text().chars().count() > support::MESSAGE_LIMIT {
                    let cut: String = self.chat.composer.text().chars().take(support::MESSAGE_LIMIT).collect();
                    self.chat.composer = text_editor::Content::with_text(&cut);
                }
            }
            ChatMsg::Send => {
                let content = self.chat.composer.text().trim().to_string();
                let c = &mut self.chat;
                if content.is_empty() || c.sending || c.needs_new_notice || c.status() != Status::Idle {
                    return Task::none();
                }
                if c.conversation.is_none() && !c.disclosure_accepted {
                    c.error = Some("Please confirm the AI Support notice before sending.".into());
                    return Task::none();
                }
                let client_id = match &c.pending {
                    Some((text, id)) if *text == content => id.clone(),
                    _ => support::client_message_id(),
                };
                c.pending = Some((content.clone(), client_id.clone()));
                let at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
                c.messages.push(ChatMessage { id: client_id.clone(), from_user: true, content: content.clone(), created_at: at, file_requests: vec![], suggest_discord: false });
                c.sending = true;
                c.status = Some(Status::Generating);
                c.error = None;
                c.composer = text_editor::Content::new();
                let conversation = c.conversation.clone();
                let (id, text) = (client_id.clone(), content.clone());
                let failed = Err(ApiError { message: "The request stopped".into(), status: 0, code: None });
                log::info!(target: "app", "support chat: message sent");
                return Task::perform(
                    off_thread_or(failed, move || match conversation {
                        None => support::create(&text, &id),
                        Some(c) => support::send(&c, &text, &id),
                    }),
                    move |result| wrap(ChatMsg::Sent { client_id: client_id.clone(), content: content.clone(), result }),
                );
            }
            ChatMsg::Sent { client_id, content, result } => {
                self.chat.sending = false;
                match result {
                    Ok(reply) => {
                        if let Some(c) = reply.conversation.clone() {
                            self.chat.conversation = Some(c);
                        }
                        self.chat_persist();
                        self.chat.pending = None;
                        return self.chat_apply(reply);
                    }
                    Err(e) => {
                        log::warn!(target: "app", "support chat: sending failed: {}", e.message);
                        self.chat.messages.retain(|m| m.id != client_id);
                        self.chat.status = Some(Status::Idle);
                        if !self.chat_reset_on(&e, "This support conversation is no longer available. Confirm the notice to start a new chat.") {
                            self.chat.error = Some(e.message);
                        }
                        self.chat.composer = text_editor::Content::with_text(&content);
                    }
                }
            }
            ChatMsg::Poll(gen) => {
                if gen == self.chat.poll_gen && self.chat.conversation.is_some() && self.chat.status() == Status::Generating {
                    return self.chat_fetch();
                }
            }
            ChatMsg::Polled(gen, result) => {
                if gen != self.chat.poll_gen {
                    return Task::none();
                }
                match result {
                    Ok(reply) => {
                        self.chat.error = None;
                        return self.chat_apply(reply);
                    }
                    Err(e) => {
                        if !self.chat_reset_on(&e, "This saved support conversation is no longer available. Start a new chat to continue.") {
                            if self.chat.status() == Status::Generating {
                                // A passing failure: try again.
                                return self.chat_poll_later();
                            }
                            self.chat.error = Some(e.message);
                        }
                    }
                }
            }
            // Asked in the OS's own dialog, as earlier versions did.
            ChatMsg::NewChat => {
                if self.chat.conversation.is_none() || self.chat.deleting {
                    return Task::none();
                }
                let dialog = rfd::AsyncMessageDialog::new()
                    .set_level(rfd::MessageLevel::Warning)
                    .set_title("New chat")
                    .set_description("Delete this conversation from Sentry Six servers and start a new one? Any diagnostics approved for it are deleted too. This cannot be undone.")
                    .set_buttons(rfd::MessageButtons::OkCancelCustom("Delete & start new".into(), "Cancel".into()));
                return Task::perform(dialog.show(), |answer| {
                    let yes = matches!(answer, rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes)
                        || matches!(&answer, rfd::MessageDialogResult::Custom(label) if label == "Delete & start new");
                    wrap(ChatMsg::ConfirmNew(yes))
                });
            }
            ChatMsg::ConfirmNew(false) => {}
            ChatMsg::ConfirmNew(true) => {
                let Some(c) = self.chat.conversation.clone() else { return Task::none() };
                self.chat.deleting = true;
                self.chat.poll_gen += 1;
                let failed = Err(ApiError { message: "The request stopped".into(), status: 0, code: None });
                return Task::perform(off_thread_or(failed, move || support::delete(&c)), |r| wrap(ChatMsg::Deleted(r)));
            }
            ChatMsg::Deleted(result) => {
                self.chat.deleting = false;
                match result {
                    Ok(()) => self.chat_reset(None, false),
                    Err(e) if matches!(e.status, 404 | 410) => self.chat_reset(None, false),
                    Err(e) => {
                        self.chat.error = Some(format!(
                            "{} Deletion was not verified. Retry, or contact privacy@sentry-six.com; any server copy otherwise expires under the retention policy.",
                            e.message
                        ))
                    }
                }
            }
            ChatMsg::Forget => self.chat_reset(None, false),
            ChatMsg::Decide { message_id, index, approve } => {
                let Some(c) = self.chat.conversation.clone() else { return Task::none() };
                let request = self.chat.messages.iter().find(|m| m.id == message_id).and_then(|m| m.file_requests.get(index)).cloned();
                if approve {
                    if let Some(issue) = request.as_ref().and_then(FileRequest::issue) {
                        self.chat.files.insert((message_id, index), FileState::Failed(issue.into(), None));
                        return Task::none();
                    }
                }
                self.chat.files.insert((message_id.clone(), index), if approve { FileState::Approving } else { FileState::Denying });
                let failed = Err(ApiError { message: "The request stopped".into(), status: 0, code: None });
                let id = message_id.clone();
                return Task::perform(off_thread_or(failed, move || support::decide(&c, &id, index, approve)), move |result| {
                    wrap(ChatMsg::Decided { message_id: message_id.clone(), index, approve, result })
                });
            }
            ChatMsg::Decided { message_id, index, approve, result } => {
                let key = (message_id.clone(), index);
                match result {
                    Ok(None) => {
                        log::info!(target: "app", "support chat: diagnostics request denied");
                        self.chat_persist();
                        self.chat.files.insert(key, FileState::Denied);
                    }
                    Ok(Some((token, max))) => {
                        let Some(c) = self.chat.conversation.clone() else { return Task::none() };
                        let request_max = self.chat.messages.iter().find(|m| m.id == message_id).and_then(|m| m.file_requests.get(index)).map_or(max, |r| r.max_bytes);
                        let limit = request_max.min(max).min(support::DIAGNOSTIC_HARD_LIMIT);
                        // Collected only now, after the approval was recorded.
                        let snap = self.diagnostics_snapshot();
                        log::info!(target: "app", "support chat: diagnostics approved, uploading");
                        let failed = Err(ApiError { message: "The request stopped".into(), status: 0, code: None });
                        let id = message_id.clone();
                        return Task::perform(
                            off_thread_or(failed, move || {
                                let report = crate::diagnostics::report(&snap);
                                if report.len() as u64 > limit {
                                    return Err(ApiError { message: "The diagnostics are larger than this request allows".into(), status: 0, code: None });
                                }
                                support::upload(&c, &id, index, &token, &report)
                            }),
                            move |result| wrap(ChatMsg::Uploaded { message_id: message_id.clone(), index, result }),
                        );
                    }
                    Err(e) => {
                        if !self.chat_reset_on(&e, "This support conversation is no longer available. Confirm the notice to start a new chat.") {
                            self.chat.files.insert(key, FileState::Failed(format!("{} Nothing will retry automatically.", e.message), Some(approve)));
                        }
                    }
                }
            }
            ChatMsg::Uploaded { message_id, index, result } => match result {
                Ok((name, size)) => {
                    self.chat.files.insert((message_id, index), FileState::Approved(format!("{name} ({}) was shared once.", bytes(size))));
                    self.chat.status = Some(Status::Generating);
                    return self.chat_poll_later();
                }
                Err(e) => {
                    log::warn!(target: "app", "support chat: diagnostics upload failed: {}", e.message);
                    if !self.chat_reset_on(&e, "This support conversation is no longer available. Confirm the notice to start a new chat.") {
                        self.chat.files.insert((message_id, index), FileState::Failed(format!("{} Nothing will retry automatically.", e.message), Some(true)));
                    }
                }
            },
            ChatMsg::Link(url) => crate::open_url(url),
            ChatMsg::Drag(dx, dy) => {
                if let Some(r) = self.chat_rect() {
                    self.chat.pos = Some(iced::Point::new(r.x + dx, r.y + dy));
                }
            }
            ChatMsg::Resize(dx, dy) => {
                if let Some(r) = self.chat_rect() {
                    // The top left stays; the bottom right follows the grip.
                    self.chat.pos = Some(iced::Point::new(r.x, r.y));
                    self.chat.size = Some(iced::Size::new((r.width + dx).max(MIN_WIDTH), (r.height + dy).max(MIN_HEIGHT)));
                }
            }
        }
        Task::none()
    }
}

fn bytes(n: u64) -> String {
    if n >= 1 << 20 {
        format!("{:.1} MB", n as f64 / (1 << 20) as f64)
    } else {
        format!("{} KB", n.div_ceil(1024))
    }
}

// ---- View ------------------------------------------------------------------
//
// Laid out as a glass panel with an accent border, a tinted header with icon buttons, "You"
// and "AI" avatars beside rounded bubbles, the notice in a bordered box, an
// amber card for a diagnostics request and a violet one for Discord, and the
// composer with its send button and footer.

/// The bottom of the panel: its corners (iced clips to a rectangle, so the
/// last section rounds its own).
const BOTTOM_ROUNDED: iced::border::Radius = iced::border::Radius { top_left: 0.0, top_right: 0.0, bottom_right: 15.0, bottom_left: 15.0 };

/// The panel's size (as earlier versions: 400 wide, up to 600 tall), and
/// the smallest it can be resized to.
pub const WIDTH: f32 = 400.0;
pub const MAX_HEIGHT: f32 = 600.0;
pub const MIN_WIDTH: f32 = 340.0;
pub const MIN_HEIGHT: f32 = 360.0;

const GRIP_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" stroke="white" stroke-width="1.2" stroke-linecap="round"><path d="M11 5 5 11M11 8.5 8.5 11"/></svg>"#;

const VIOLET: Color = Color::from_rgb(0xc4 as f32 / 255.0, 0xb5 as f32 / 255.0, 0xfd as f32 / 255.0);
const VIOLET_DEEP: Color = Color::from_rgb(0x6d as f32 / 255.0, 0x28 as f32 / 255.0, 0xd9 as f32 / 255.0);
const ACCENT_DEEP: Color = Color::from_rgb(32.0 / 255.0, 160.0 / 255.0, 78.0 / 255.0);
const TEAL: Color = Color::from_rgb(0.0, 0x88 as f32 / 255.0, 0xa3 as f32 / 255.0);
const AMBER: Color = Color::from_rgb(0xfb as f32 / 255.0, 0xbf as f32 / 255.0, 0x24 as f32 / 255.0);
const AMBER_TEXT: Color = Color::from_rgb(0xfd as f32 / 255.0, 0xe6 as f32 / 255.0, 0x8a as f32 / 255.0);

fn alpha(c: Color, a: f32) -> Color {
    Color { a, ..c }
}

fn white(a: f32) -> Color {
    Color::from_rgba(1.0, 1.0, 1.0, a)
}

fn gradient(from: Color, to: Color, degrees: f32) -> Background {
    Background::Gradient(iced::gradient::Linear::new(iced::Degrees(degrees)).add_stop(0.0, from).add_stop(1.0, to).into())
}

const BOT_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/></svg>"#;
const PEOPLE_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>"#;
const RESTART_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>"#;
const CLOSE_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>"#;
const SEND_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>"#;
const SHIELD_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>"#;

fn icon_button<'a>(svg: &'static str, m: ChatMsg) -> iced::widget::Button<'a, Message> {
    button(crate::svg_icon(svg, 16.0, theme::TEXT_SECONDARY)).padding(6).on_press(wrap(m)).style(|_, status| {
        let hover = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(Background::Color(if hover { alpha(theme::ACCENT, 0.15) } else { white(0.08) })),
            border: Border { color: if hover { alpha(theme::ACCENT, 0.3) } else { white(0.10) }, width: 1.0, radius: 8.0.into() },
            text_color: theme::TEXT_SECONDARY,
            ..Default::default()
        }
    })
}

fn small(s: &str) -> iced::widget::Text<'_> {
    text(s).size(12).line_height(1.5).color(theme::TEXT_SECONDARY)
}

fn muted<'a>(s: impl text::IntoFragment<'a>) -> iced::widget::Text<'a> {
    text(s).size(11).color(theme::TEXT_FAINT)
}

/// Secondary: transparent with a border.
fn secondary<'a>(label: &'a str, m: Option<ChatMsg>) -> iced::widget::Button<'a, Message> {
    button(text(label).size(12).font(theme::semibold(theme::INTER)).color(theme::TEXT_SECONDARY)).padding([8, 12]).on_press_maybe(m.map(wrap)).style(|_, status| button::Style {
        background: matches!(status, button::Status::Hovered).then(|| Background::Color(white(0.05))),
        border: Border { color: white(0.10), width: 1.0, radius: 9.0.into() },
        text_color: theme::TEXT_SECONDARY,
        ..Default::default()
    })
}

fn link<'a>(label: &'a str, url: &'static str) -> iced::widget::Button<'a, Message> {
    button(text(format!("{label} ↗")).size(11).color(theme::ACCENT)).padding([4, 0]).style(theme::link_button).on_press(wrap(ChatMsg::Link(url)))
}

/// A tinted card (the diagnostics request, Discord, the notice).
fn card<'a>(content: impl Into<Element<'a, Message>>, tint: Color, fill: f32, edge: f32) -> Element<'a, Message> {
    container(content)
        .padding([10, 12])
        .width(Length::Fill)
        .style(move |_: &iced::Theme| container::Style {
            background: Some(Background::Color(alpha(tint, fill))),
            border: Border { color: alpha(tint, edge), width: 1.0, radius: 10.0.into() },
            ..Default::default()
        })
        .into()
}

/// Bold (**…**) and code (`…`) in a line.
fn inline(line: &str) -> Vec<iced::widget::text::Span<'static, (), iced::Font>> {
    let mut spans = Vec::new();
    let mut rest = line;
    while !rest.is_empty() {
        let bold = rest.find("**");
        let code = rest.find('`');
        let next = match (bold, code) {
            (Some(b), Some(c)) => Some(b.min(c)),
            (b, c) => b.or(c),
        };
        let Some(at) = next else {
            spans.push(span(rest.to_string()));
            break;
        };
        let marker = if rest[at..].starts_with("**") { "**" } else { "`" };
        let after = &rest[at + marker.len()..];
        match after.find(marker).filter(|&n| n > 0 && !after[..n].contains('\n')) {
            Some(n) => {
                if at > 0 {
                    spans.push(span(rest[..at].to_string()));
                }
                let inner = after[..n].to_string();
                spans.push(if marker == "**" {
                    span(inner).font(theme::semibold(theme::INTER))
                } else {
                    span(inner).font(theme::MONO).size(12.5).background(white(0.06)).border(Border { radius: 4.0.into(), ..Default::default() }).padding([0, 4])
                });
                rest = &after[n + marker.len()..];
            }
            None => {
                spans.push(span(rest[..at + marker.len()].to_string()));
                rest = after;
            }
        }
    }
    spans
}

fn paragraph(line: &str, color: Color) -> Element<'static, Message> {
    rich_text(inline(line)).size(13).line_height(1.45).color(color).into()
}

/// Paragraphs, bulleted and numbered lists, bold and code.
fn markdown(content: &str) -> Element<'static, Message> {
    let mut blocks: Vec<Element<'static, Message>> = Vec::new();
    let mut para: Vec<String> = Vec::new();
    let flush = |blocks: &mut Vec<Element<'static, Message>>, para: &mut Vec<String>| {
        if !para.is_empty() {
            blocks.push(paragraph(&para.join("\n"), theme::TEXT));
            para.clear();
        }
    };
    for raw in content.replace("\r\n", "\n").split('\n') {
        let t = raw.trim_end().trim_start();
        let bullet = ["- ", "* ", "• "].iter().find_map(|b| t.strip_prefix(b));
        let numbered = t.split_once(['.', ')']).filter(|(n, rest)| !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(' '));
        if let Some(item) = bullet {
            flush(&mut blocks, &mut para);
            blocks.push(row![text("•").size(13).color(theme::TEXT_SECONDARY).width(14), paragraph(item.trim(), theme::TEXT)].spacing(2).into());
        } else if let Some((n, item)) = numbered {
            flush(&mut blocks, &mut para);
            blocks.push(row![text(format!("{n}.")).size(13).color(theme::TEXT_SECONDARY).width(20), paragraph(item.trim(), theme::TEXT)].spacing(2).into());
        } else if t.is_empty() {
            flush(&mut blocks, &mut para);
        } else {
            para.push(t.to_string());
        }
    }
    flush(&mut blocks, &mut para);
    Column::with_children(blocks).spacing(6).into()
}

fn time_of(iso: &str, h24: bool) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|t| t.with_timezone(&chrono::Local).format(if h24 { "%H:%M" } else { "%-I:%M %p" }).to_string())
        .unwrap_or_default()
}

fn avatar(user: bool) -> Element<'static, Message> {
    let (from, to, label) = if user { (theme::ACCENT, ACCENT_DEEP, "You") } else { (VIOLET, VIOLET_DEEP, "AI") };
    container(text(label).size(11).font(theme::bold(theme::INTER)).color(Color::WHITE))
        .center(32)
        .style(move |_: &iced::Theme| container::Style { background: Some(gradient(from, to, 135.0)), border: Border { radius: 16.0.into(), ..Default::default() }, ..Default::default() })
        .into()
}

fn file_card<'a>(chat: &'a Chat, m: &'a ChatMessage, index: usize, r: &'a FileRequest) -> Element<'a, Message> {
    let state = chat.files.get(&(m.id.clone(), index));
    let mut col = column![
        text("AI requests one-time access").size(12).font(theme::semibold(theme::INTER)),
        small(if r.label.is_empty() { "Sentry Studio diagnostics" } else { &r.label }),
    ]
    .spacing(6);
    let mut facts = Column::new().spacing(2);
    for (k, v) in [
        ("File", format!("{} · max {}", r.file_name, bytes(r.max_bytes.min(support::DIAGNOSTIC_HARD_LIMIT)))),
        ("Destination", "api.sentry-six.com · Sentry Six support servers".into()),
        ("AI processing", "Processed by Anthropic for this answer".into()),
        ("Retention", "Deleted within 7 days".into()),
    ] {
        facts = facts.push(row![text(k).size(11).color(alpha(theme::TEXT, 0.7)).width(90), text(v).size(11).color(theme::TEXT).width(Length::Fill)].spacing(8));
    }
    col = col.push(facts).push(muted(
        "Includes the app version, operating system, CPU, memory and graphics details, the video decoder, update status, app settings (folders only as the kind of drive), playback health, and recent app logs. User, volume and server names in paths are removed on this computer first. Collected and uploaded only after you approve.",
    ));
    let (id, i) = (m.id.clone(), index);
    match state {
        None => {
            if let Some(issue) = r.issue() {
                col = col.push(text(issue).size(12).color(theme::ERROR));
            }
            let approve = button(text("Collect & upload diagnostics once").size(12).font(theme::semibold(theme::INTER)).color(AMBER_TEXT))
                .padding([8, 12])
                .on_press_maybe(r.issue().is_none().then(|| wrap(ChatMsg::Decide { message_id: id.clone(), index: i, approve: true })))
                .style(|_, status| button::Style {
                    background: Some(Background::Color(alpha(AMBER, if matches!(status, button::Status::Hovered) { 0.22 } else { 0.15 }))),
                    border: Border { radius: 9.0.into(), ..Default::default() },
                    text_color: AMBER_TEXT,
                    ..Default::default()
                });
            // Deny moves under the first button when both don't fit.
            col = col.push(row![approve, secondary("Deny", Some(ChatMsg::Decide { message_id: id, index: i, approve: false }))].spacing(8).wrap().vertical_spacing(8));
        }
        Some(FileState::Approving) => col = col.push(text("Preparing and sharing approved diagnostics…").size(12).color(AMBER_TEXT)),
        Some(FileState::Denying) => col = col.push(text("Saving your decision…").size(12).color(AMBER_TEXT)),
        Some(FileState::Approved(detail)) => col = col.push(text(detail.as_str()).size(12).color(theme::SUCCESS)),
        Some(FileState::Denied) => col = col.push(muted("Denied. Nothing was collected or uploaded.")),
        Some(FileState::Failed(detail, retry)) => {
            col = col.push(text(detail.as_str()).size(12).color(theme::ERROR));
            if let Some(approve) = retry {
                let label = if *approve { "Try upload again" } else { "Try deny again" };
                col = col.push(secondary(label, Some(ChatMsg::Decide { message_id: id, index: i, approve: *approve })));
            }
        }
    }
    card(col, AMBER, 0.05, 0.25)
}

/// A message: the avatar beside its bubble (user on the right).
fn message_row<'a>(chat: &'a Chat, m: &'a ChatMessage, h24: bool, width: f32) -> Element<'a, Message> {
    let max = (width - 40.0 - 42.0) * 0.9;
    let time = text(time_of(&m.created_at, h24)).size(10);
    if m.from_user {
        let bubble = container(
            column![paragraph(&m.content, Color::WHITE), container(time.color(theme::TEXT_SECONDARY)).align_right(Length::Fill)].spacing(4),
        )
        .padding([10, 14])
        .max_width(max)
        .style(|_: &iced::Theme| container::Style {
            background: Some(gradient(ACCENT_DEEP, TEAL, 135.0)),
            border: Border { radius: iced::border::Radius { top_left: 16.0, top_right: 16.0, bottom_right: 4.0, bottom_left: 16.0 }, ..Default::default() },
            ..Default::default()
        });
        return row![space().width(Length::Fill), bubble, avatar(true)].spacing(10).align_y(Alignment::End).into();
    }
    let mut col = column![text("Sentry Assistant").size(11).font(theme::semibold(theme::INTER)).color(VIOLET), markdown(&m.content), time.color(theme::TEXT_FAINT)].spacing(4);
    for (i, r) in m.file_requests.iter().enumerate() {
        col = col.push(file_card(chat, m, i, r));
    }
    if m.suggest_discord {
        col = col.push(card(
            column![
                text("Want help from a person?").size(12).font(theme::semibold(theme::INTER)),
                muted("Join the Sentry Six Discord community. This AI conversation is not transferred; share only what you choose.").color(alpha(theme::TEXT_SECONDARY, 0.8)),
                link("Join Discord", support::DISCORD_URL),
            ]
            .spacing(4),
            VIOLET,
            0.07,
            0.25,
        ));
    }
    // Full width (up to the cap): a card inside needs the room.
    let bubble = container(col).padding([10, 14]).width(Length::Fill).max_width(max).style(|_: &iced::Theme| container::Style {
        background: Some(Background::Color(white(0.08))),
        border: Border { color: white(0.08), width: 1.0, radius: iced::border::Radius { top_left: 16.0, top_right: 16.0, bottom_right: 16.0, bottom_left: 4.0 } },
        ..Default::default()
    });
    row![avatar(false), bubble].spacing(10).align_y(Alignment::End).into()
}

/// The notice, in its bordered box with a full-width button.
fn gate<'a>(title: &'a str, paragraphs: Vec<Element<'a, Message>>, buttons: Vec<Element<'a, Message>>) -> Element<'a, Message> {
    let mut col = column![
        container(crate::svg_icon(SHIELD_SVG, 28.0, AMBER)).center_x(Length::Fill),
        container(text(title).size(14).font(theme::semibold(theme::INTER))).center_x(Length::Fill),
    ]
    .spacing(6);
    for p in paragraphs {
        col = col.push(p);
    }
    for b in buttons {
        col = col.push(b);
    }
    container(container(col.spacing(8)).padding(18).max_width(360).style(|_: &iced::Theme| container::Style {
        background: Some(Background::Color(white(0.02))),
        border: Border { color: white(0.10), width: 1.0, radius: 14.0.into() },
        ..Default::default()
    }))
    .center_x(Length::Fill)
    .into()
}

fn wide<'a>(label: &'a str, m: Option<ChatMsg>, danger: bool) -> Element<'a, Message> {
    let (bg, fg) = if danger { (alpha(theme::ERROR, 0.85), Color::WHITE) } else { (theme::ACCENT, theme::BG) };
    button(container(text(label).size(12).font(theme::semibold(theme::INTER)).color(fg)).center_x(Length::Fill))
        .padding([9, 12])
        .width(Length::Fill)
        .on_press_maybe(m.map(wrap))
        .style(move |_, status| button::Style {
            background: Some(Background::Color(if matches!(status, button::Status::Hovered) { Color { a: 1.0, ..bg } } else { bg })),
            border: Border { radius: 9.0.into(), ..Default::default() },
            text_color: fg,
            ..Default::default()
        })
        .into()
}

fn notice<'a>() -> Element<'a, Message> {
    gate(
        "Before you chat",
        vec![
            small("Sentry Assistant is an online AI assistant. Your messages, the Sentry Studio version, operating system and CPU type go to Sentry Six, and Anthropic processes them to write each answer. Your public IP is used for abuse prevention.").into(),
            muted("Chats are redacted and stored on Sentry Six servers in Canada for up to 90 days after your last message, and authorized maintainers may review them to improve support. New chat deletes the current chat.").line_height(1.5).into(),
            muted("Diagnostics are shared only when you approve a request, and are deleted within 7 days. AI can be wrong and cannot approve refunds or warranty claims; Discord is always available for help from a person.").line_height(1.5).into(),
            muted("Keep passwords and other secrets out of the chat.").line_height(1.5).into(),
        ],
        vec![wide("Acknowledge & continue", Some(ChatMsg::Acknowledge), false), container(link("Privacy policy", support::PRIVACY_URL)).center_x(Length::Fill).into()],
    )
}

fn notice_changed(chat: &Chat) -> Element<'_, Message> {
    let mut paragraphs: Vec<Element<'_, Message>> =
        vec![small("Your saved chat used an earlier notice, so it cannot continue. Delete it to see the current notice and start a new chat.").into()];
    if let Some(e) = &chat.error {
        paragraphs.push(text(e.as_str()).size(12).color(theme::ERROR).into());
    }
    let mut buttons = vec![wide("Delete old chat & continue", (!chat.deleting).then_some(ChatMsg::ConfirmNew(true)), true)];
    if chat.error.is_some() {
        buttons.push(secondary("Forget local access without verified deletion", Some(ChatMsg::Forget)).into());
    }
    buttons.push(container(link("Privacy policy", support::PRIVACY_URL)).center_x(Length::Fill).into());
    gate("AI Support privacy update", paragraphs, buttons)
}

fn welcome<'a>() -> Element<'a, Message> {
    container(
        column![
            crate::svg_icon(BOT_SVG, 40.0, alpha(theme::ACCENT, 0.8)),
            text("What can I help with?").size(16).font(theme::semibold(theme::INTER)),
            text("Sentry Assistant answers Sentry Studio questions from Sentry Six's public documentation, and can read a diagnostics report when you approve one.")
                .size(12)
                .line_height(1.5)
                .center()
                .color(theme::TEXT_SECONDARY),
        ]
        .spacing(14)
        .align_x(Alignment::Center),
    )
    .padding([40, 20])
    .center_x(Length::Fill)
    .into()
}

/// The panel (when open), `size` big.
pub fn view<'a>(chat: &'a Chat, h24: bool, size: iced::Size) -> Element<'a, Message> {
    let (width, height) = (size.width, size.height);
    let mut actions = row![icon_button(PEOPLE_SVG, ChatMsg::Link(support::DISCORD_URL))].spacing(6);
    if chat.conversation.is_some() && !chat.needs_new_notice {
        actions = actions.push(icon_button(RESTART_SVG, ChatMsg::NewChat));
    }
    actions = actions.push(icon_button(CLOSE_SVG, ChatMsg::Close));
    // Dragging the header moves the panel (its buttons still click).
    let header = crate::tile_input::tile_input(container(
        row![
            crate::svg_icon(BOT_SVG, 18.0, theme::ACCENT),
            text("AI Support").size(14).font(theme::semibold(theme::INTER)).color(Color::WHITE),
            space().width(Length::Fill),
            actions
        ]
        .spacing(10)
        .align_y(Alignment::Center),
    )
    .padding([12, 16])
    .width(Length::Fill)
    .style(|_: &iced::Theme| container::Style {
        background: Some(gradient(alpha(theme::ACCENT, 0.08), Color::from_rgba(0.0, 0.0, 0.0, 0.2), 180.0)),
        ..Default::default()
    }))
    .on_drag(|dx, dy| wrap(ChatMsg::Drag(dx, dy)))
    .grab(true);

    let mut body = Column::new().spacing(16);
    if chat.conversation.is_some() && chat.needs_new_notice {
        body = body.push(notice_changed(chat));
    } else if chat.conversation.is_none() && !chat.disclosure_accepted {
        body = body.push(notice());
    } else if chat.messages.is_empty() {
        body = body.push(welcome());
    } else {
        for m in &chat.messages {
            body = body.push(message_row(chat, m, h24, width));
        }
    }
    if !chat.gated() && chat.status() == Status::Generating {
        let typing = container(text("Sentry Assistant is preparing a response…").size(12).font(iced::Font { style: iced::font::Style::Italic, ..theme::INTER }).color(alpha(theme::TEXT, 0.75)))
            .padding([10, 14])
            .style(|_: &iced::Theme| container::Style { background: Some(Background::Color(white(0.06))), border: Border { radius: 16.0.into(), ..Default::default() }, ..Default::default() });
        body = body.push(row![avatar(false), typing].spacing(10).align_y(Alignment::End));
    }

    let line = |c: Color| container(space().height(1)).width(Length::Fill).style(move |_: &iced::Theme| container::Style { background: Some(Background::Color(c)), ..Default::default() });
    let mut panel = column![
        header,
        line(alpha(theme::ACCENT, 0.15)),
        scrollable(container(body).padding(20)).anchor_bottom().height(Length::Fill).style(theme::thin_scroll),
    ];
    let status_line = if chat.status() == Status::Closed {
        Some(("This conversation is closed. Use New chat to delete it and start again.".to_string(), theme::TEXT_SECONDARY, Color::TRANSPARENT))
    } else if chat.deleting {
        Some(("Deleting this conversation…".to_string(), theme::ACCENT, alpha(theme::ACCENT, 0.1)))
    } else {
        chat.error.clone().filter(|_| !chat.gated()).map(|e| (e, theme::ERROR, alpha(theme::ERROR, 0.1)))
    };
    if let Some((s, color, bg)) = status_line {
        // Without the composer below, it's the panel's bottom.
        let last = chat.gated();
        panel = panel.push(
            container(text(s).size(12).color(color).center())
                .padding([10, 16])
                .width(Length::Fill)
                .style(move |_: &iced::Theme| container::Style {
                    background: Some(Background::Color(bg)),
                    border: Border { radius: if last { BOTTOM_ROUNDED } else { 0.0.into() }, ..Default::default() },
                    ..Default::default()
                }),
        );
    }
    if !chat.gated() {
        let locked = chat.sending || chat.status() != Status::Idle || chat.files.values().any(|f| matches!(f, FileState::Approving | FileState::Denying));
        let placeholder = if chat.status() == Status::Generating { "Waiting for Sentry Assistant…" } else { "Ask about Sentry Studio…" };
        let mut editor = text_editor(&chat.composer)
            .placeholder(placeholder)
            .height(72)
            .size(13)
            .padding([12, 14])
            .style(|_, status| {
                let focused = matches!(status, text_editor::Status::Focused { .. });
                text_editor::Style {
                    background: Background::Color(white(if focused { 0.10 } else { 0.08 })),
                    border: Border { color: if focused { alpha(theme::ACCENT, 0.5) } else { white(0.10) }, width: 1.0, radius: 12.0.into() },
                    placeholder: theme::TEXT_FAINT,
                    value: Color::WHITE,
                    selection: alpha(theme::ACCENT, 0.35),
                }
            });
        if !locked {
            editor = editor.on_action(|a| wrap(ChatMsg::Edit(a))).key_binding(|key| {
                use iced::keyboard::{key::Named, Key};
                match key.key {
                    // Enter sends; Shift+Enter starts a new line.
                    Key::Named(Named::Enter) if !key.modifiers.shift() => Some(text_editor::Binding::Custom(wrap(ChatMsg::Send))),
                    _ => text_editor::Binding::from_key_press(key),
                }
            });
        }
        let count = chat.composer.text().trim_end_matches('\n').chars().count();
        let can_send = !locked && count > 0;
        let send = button(crate::svg_icon(SEND_SVG, 18.0, Color::WHITE))
            .padding(12)
            .on_press_maybe(can_send.then_some(wrap(ChatMsg::Send)))
            .style(move |_, _| button::Style {
                background: Some(gradient(alpha(theme::ACCENT, if can_send { 1.0 } else { 0.5 }), alpha(ACCENT_DEEP, if can_send { 1.0 } else { 0.5 }), 135.0)),
                border: Border { radius: 12.0.into(), ..Default::default() },
                ..Default::default()
            });
        let footer = row![
            text(format!("{count}/{}", support::MESSAGE_LIMIT)).size(11).font(theme::MONO).color(theme::TEXT_FAINT),
            space().width(Length::Fill),
            crate::svg_icon(SHIELD_SVG, 11.0, alpha(theme::TEXT_FAINT, 0.6)),
            muted("AI answers · redacted chats kept up to 90 days"),
        ]
        .spacing(4)
        .align_y(Alignment::Center);
        panel = panel.push(line(white(0.10))).push(
            container(column![row![editor, send].spacing(10).align_y(Alignment::End), footer].spacing(10))
                .padding(16)
                .style(|_: &iced::Theme| container::Style {
                    background: Some(Background::Color(Color::from_rgba8(7, 9, 12, 0.55))),
                    // The panel's rounded bottom (clipping is square).
                    border: Border { radius: BOTTOM_ROUNDED, ..Default::default() },
                    ..Default::default()
                }),
        );
    }
    // The grip in the bottom right corner resizes it.
    let grip = crate::tile_input::tile_input(container(crate::svg_icon(GRIP_SVG, 12.0, theme::TEXT_FAINT)).padding(4))
        .on_drag(|dx, dy| wrap(ChatMsg::Resize(dx, dy)))
        .grab(true);
    let panel = iced::widget::stack![
        container(panel).width(width).height(height).clip(true).style(theme::chat_panel),
        container(grip).width(width).height(height).align_right(width).align_bottom(height).padding(2),
    ];
    // Opaque: clicks and scrolls on the panel never reach the video below.
    iced::widget::opaque(panel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_marks_split_into_spans() {
        let spans = inline("Open **Settings** and run `sentry-studio --diagnostics` now");
        let texts: Vec<String> = spans.iter().map(|s| s.text.to_string()).collect();
        assert_eq!(texts, vec!["Open ", "Settings", " and run ", "sentry-studio --diagnostics", " now"]);
        // An unclosed mark stays as text.
        let texts: Vec<String> = inline("a ** b").iter().map(|s| s.text.to_string()).collect();
        assert_eq!(texts.concat(), "a ** b");
    }
}
