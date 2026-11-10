//! The Settings window: a header with the gradient accent line, a sidebar
//! with search and the sections, compact rows on the right, and a footer
//! with Done. Selects open the macOS menu on a Mac and a dropdown
//! elsewhere; changes apply at once and are saved.

use crate::i18n::{self, t};
use crate::dashboard::AccelMode;
use crate::settings::{DateFormat, Settings};
use crate::shortcuts::{self, Action, Shortcuts};
use crate::theme;
use crate::Message;
use iced::widget::{button, column, container, mouse_area, opaque, pick_list, row, slider, space, stack, text, text_input, toggler, Column};
use iced::{Alignment, Element, Length, Padding};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Section {
    #[default]
    Display,
    Playback,
    Shortcuts,
    Storage,
    SentryUsb,
    System,
}

/// Playback & Overlays has subtabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Subtab {
    #[default]
    Dashboard,
    Map,
    Cameras,
}

/// Where the window is: section, subtab, search text, the shortcut being
/// recorded, and whether System's details are open.
#[derive(Debug, Clone, Default)]
pub struct Ui {
    pub section: Section,
    pub subtab: Subtab,
    pub search: String,
    pub recording: Option<Action>,
    pub learn_more: bool,
    /// Check Now: what the last check found (shown for a few seconds).
    pub update_check: CheckState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CheckState {
    #[default]
    Idle,
    Checking,
    Found,
    UpToDate,
    Failed,
}

/// One change from the Settings window.
#[derive(Debug, Clone)]
pub enum Change {
    Metric(bool),
    Mirror(bool),
    Blur(f32),
    PlaceNames(bool),
    ShowDriveStats(bool),
    SentryGlow(bool),
    DashboardEnabled(bool),
    MapEnabled(bool),
    ShowFsdEvents(bool),
    CompactFixed(bool),
    SavedGlow(bool),
    /// Opens a select's macOS menu.
    Open(Menu),
    /// A select's choice (an index into `choices`).
    Choose(Menu, usize),
    ResetCameraOrder,
    ViewChangelog,
    OpenSupportChat,
    /// The list of clips shared from this computer.
    OpenSharedClips,
    /// Opens the licences (this app's and the third-party notices).
    OpenLicences,
    /// Waits for the next key or mouse button for an action (again: stop).
    RecordKey(Action),
    ClearKey(Action),
    BrowseFolder,
    ClearFolder,
    BrowseDriveData,
    ClearDriveData,
    LearnMore,
    OpenLink(&'static str),
    /// Pre-release updates on or off.
    Prerelease(bool),
    CheckUpdates,
}

/// The Skip Duration choices, in seconds.
pub const SKIP_CHOICES: [f64; 3] = [1.0, 5.0, 15.0];

/// The dialog's corner radius.
pub const RADIUS: f32 = 24.0;

// SVG icons for the sidebar and search (the icon font subset has no
// glyphs for these).
const SEARCH_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>"#;
const DISPLAY_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>"#;
const PLAYBACK_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>"#;
const SHORTCUTS_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 16h.01M18 16h.01"/></svg>"#;
const STORAGE_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>"#;
const SENTRYUSB_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M6 14h.01M10 10h4M10 14h4"/></svg>"#;
const SYSTEM_SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>"#;

pub const PRIVACY_URL: &str = "https://sentry-six.com/privacy";
pub const TERMS_URL: &str = "https://sentry-six.com/terms";


/// One setting. `words` is what search matches (label and description).
struct Row<'a> {
    section: Section,
    subtab: Option<Subtab>,
    words: String,
    view: Element<'a, Message>,
}

fn labelled<'a>(label: &'a str, desc: Option<&'a str>, control: Element<'a, Message>) -> Element<'a, Message> {
    let mut words = column![text(label).size(12).font(theme::medium(theme::INTER))].spacing(2);
    if let Some(d) = desc {
        words = words.push(text(d).size(10).color(theme::TEXT_MUTED));
    }
    // A setting's row: 8 px by 14 px of padding, no box.
    container(row![words.width(Length::Fill), control].spacing(12).align_y(Alignment::Center))
        .padding([8, 14])
        .width(Length::Fill)
        .into()
}

fn setting<'a>(section: Section, subtab: Option<Subtab>, label: &'static str, desc: Option<&'static str>, control: Element<'a, Message>) -> Row<'a> {
    Row { section, subtab, words: format!("{label} {}", desc.unwrap_or("")), view: labelled(label, desc, control) }
}

fn toggle<'a>(on: bool, change: fn(bool) -> Change) -> Element<'a, Message> {
    toggler(on).size(22).on_toggle(move |b| Message::Setting(change(b))).style(theme::toggle).into()
}

/// The settings picked from a list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Menu {
    Language,
    TimeFormat,
    DateFormat,
    DashboardStyle,
    Accel,
    MapStyle,
    Skip,
    DialogStyle,
}

/// A select's choices, and which is the current one.
pub fn choices(s: &Settings, menu: Menu) -> (Vec<String>, Option<usize>) {
    let words = |keys: &[&'static str]| keys.iter().map(|k| t(k).to_string()).collect::<Vec<_>>();
    match menu {
        Menu::Language => (
            i18n::LANGUAGES.iter().map(|(_, name)| name.to_string()).collect(),
            i18n::LANGUAGES.iter().position(|(c, _)| *c == s.language),
        ),
        Menu::TimeFormat => (words(&["ui.settings.time12h", "ui.settings.time24h"]), Some(s.time_24h as usize)),
        Menu::DateFormat => (
            DateFormat::ALL.iter().map(|f| t(f.label_key()).to_string()).collect(),
            DateFormat::ALL.iter().position(|f| *f == s.date_format),
        ),
        Menu::DashboardStyle => (words(&["ui.settings.default", "ui.export.compact"]), Some(s.dashboard_compact as usize)),
        Menu::Accel => (
            AccelMode::ALL.iter().map(|m| m.label().to_string()).collect(),
            AccelMode::ALL.iter().position(|m| *m == s.accel_mode),
        ),
        Menu::MapStyle => (words(&["ui.settings.mapStyleLight", "ui.settings.mapStyleDark"]), Some(s.map_dark as usize)),
        Menu::DialogStyle => (words(&["ui.settings.dialogFrosted", "ui.settings.dialogSolid"]), Some(s.solid_dialogs as usize)),
        Menu::Skip => (
            SKIP_CHOICES.iter().map(|c| format!("{}s", *c as u32)).collect(),
            SKIP_CHOICES.iter().position(|c| *c == s.skip_seconds),
        ),
    }
}

/// One of a dropdown's choices: its index and words.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Choice(usize, String);

impl std::fmt::Display for Choice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.1)
    }
}

/// A select: the macOS menu on a Mac, iced's dropdown elsewhere.
fn select<'a>(s: &Settings, menu: Menu) -> Element<'a, Message> {
    let (labels, current) = choices(s, menu);
    if crate::native_menu::AVAILABLE {
        let value = current.and_then(|i| labels.get(i).cloned()).unwrap_or_default();
        return button(row![text(value).size(11), theme::icon(theme::icon::EXPAND_MORE, 15.0)].spacing(6).align_y(Alignment::Center))
            .padding([4, 8])
            .style(theme::settings_select)
            .on_press(Message::Setting(Change::Open(menu)))
            .into();
    }
    let options: Vec<Choice> = labels.into_iter().enumerate().map(|(i, l)| Choice(i, l)).collect();
    let selected = current.and_then(|i| options.get(i).cloned());
    pick_list(options, selected, move |c: Choice| Message::Setting(Change::Choose(menu, c.0)))
        .text_size(11)
        .padding([4, 8])
        .handle(theme::chevron_handle(15.0))
        .style(theme::settings_pick)
        .into()
}

fn small_button<'a>(label: &'a str, change: Change) -> Element<'a, Message> {
    button(text(label).size(12).font(theme::medium(theme::INTER)))
        .padding([6, 12])
        .style(theme::secondary_button)
        .on_press(Message::Setting(change))
        .into()
}

/// A folder or file setting: a read-only path, Browse, and ✕ to clear.
fn path_row<'a>(heading: &'a str, path: Option<String>, empty: &'a str, browse: Change, clear: Change) -> Element<'a, Message> {
    let shown = match path {
        Some(p) => text(p).size(12).color(theme::TEXT),
        None => text(empty).size(12).color(theme::TEXT_FAINT),
    };
    column![
        text(heading.to_uppercase()).size(11).font(theme::semibold(theme::INTER)).color(theme::TEXT_FAINT),
        row![
            container(shown).padding([8, 12]).width(Length::Fill).clip(true).style(theme::path_field),
            small_button(t("ui.settings.browse"), browse),
            small_button("✕", clear),
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    ]
    .spacing(4)
    .padding([8, 14])
    .into()
}

/// A shortcut's row: the action, its key, and ✕.
fn keybind_row<'a>(action: Action, keys: &Shortcuts, recording: Option<Action>) -> Element<'a, Message> {
    let is_recording = recording == Some(action);
    let shown = if is_recording {
        t("app.pressKey").to_string()
    } else {
        keys.key_for(action).map(shortcuts::display).unwrap_or_else(|| "—".into())
    };
    let field = button(container(text(shown).size(11).font(theme::MONO)).center_x(Length::Fill))
        .width(120)
        .padding([6, 10])
        .style(theme::keybind_field(is_recording))
        .on_press(Message::Setting(Change::RecordKey(action)));
    let clear = button(container(text("✕").size(12)).center(Length::Fill))
        .width(22)
        .height(22)
        .padding(0)
        .style(theme::keybind_clear)
        .on_press(Message::Setting(Change::ClearKey(action)));
    container(
        row![text(action_label(action)).size(12).width(Length::Fill), row![field, clear].spacing(4).align_y(Alignment::Center)]
            .spacing(12)
            .align_y(Alignment::Center),
    )
    .padding([6, 14])
    .width(Length::Fill)
    .into()
}

/// The Mac App Store build: the App Store updates it, so no update
/// settings or checks.
pub const APP_STORE: bool = cfg!(feature = "app-store");

pub fn action_label(action: Action) -> &'static str {
    t(match action {
        Action::PlayPause => "ui.settings.playPause",
        Action::SkipForward => "ui.settings.skipForward",
        Action::SkipBackward => "ui.settings.skipBackward",
        Action::ToggleDash => "ui.settings.toggleDashboard",
        Action::ToggleMap => "ui.settings.toggleMap",
        Action::ToggleMetric => "ui.settings.toggleMphKmh",
        Action::ToggleClips => "ui.settings.toggleClipsPanel",
        Action::SetMarkerIn => "ui.settings.setExportMarkerIn",
        Action::SetMarkerOut => "ui.settings.setExportMarkerOut",
        Action::NextClip => "ui.settings.nextClip",
        Action::PrevClip => "ui.settings.prevClip",
        Action::SpeedUp => "ui.settings.speedUp",
        Action::SpeedDown => "ui.settings.speedDown",
        Action::SpeedReset => "ui.settings.speedReset",
        Action::SpeedMax => "ui.settings.speedMax",
    })
}

/// OS and architecture, in the names the update check uses (such as
/// arm64 and x64).
fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn detail<'a>(label: &'a str, value: String) -> Element<'a, Message> {
    row![
        text(label).size(12).font(theme::medium(theme::INTER)).color(theme::TEXT_MUTED).width(Length::Fill),
        text(value).size(12).font(theme::semibold(theme::MONO)).color(theme::ACCENT),
    ]
    .padding([4, 0])
    .align_y(Alignment::Center)
    .into()
}

/// A security table row: feature, a status badge, what it means.
fn privacy_row<'a>(feature: &'a str, badge: &'a str, on: bool, desc: &'a str) -> Element<'a, Message> {
    column![
        row![
            text(feature).size(12).font(theme::semibold(theme::INTER)).width(Length::Fill),
            container(text(badge).size(11).font(theme::semibold(theme::INTER))).padding([2, 8]).style(theme::status_badge(on)),
        ]
        .align_y(Alignment::Center),
        text(desc).size(11).color(theme::TEXT_MUTED),
    ]
    .spacing(4)
    .padding([6, 0])
    .into()
}

fn system_section<'a>(s: &'a Settings, ui: &'a Ui) -> Element<'a, Message> {
    let mut col = column![
        detail(t("app.os"), os_name().to_string()),
        detail(t("ui.settings.architecture"), arch_name().to_string()),
        detail(t("ui.settings.appVersion"), env!("CARGO_PKG_VERSION").to_string()),
        row![
            text(t("ui.settings.openSource")).size(12).font(theme::medium(theme::INTER)).color(theme::TEXT_MUTED).width(Length::Fill),
            button(text(t("app.licences")).size(12).font(theme::semibold(theme::INTER)).color(theme::ACCENT))
                .padding(0)
                .style(theme::link_button)
                .on_press(Message::Setting(Change::OpenLicences)),
        ]
        .padding([4, 0])
        .align_y(Alignment::Center),
        button(text(t("ui.settings.learnMore")).size(12).color(theme::ACCENT))
            .padding([6, 0])
            .style(theme::link_button)
            .on_press(Message::Setting(Change::LearnMore)),
    ]
    .spacing(2);
    if ui.learn_more {
        // What the app sends, and when.
        col = col
            .push(privacy_row(t("ui.settings.footagePrivacy"), t("ui.settings.localOnly"), true, t("ui.settings.footagePrivacyDesc")))
            .push(privacy_row(
                t("ui.settings.placeNames"),
                if s.place_names { t("ui.settings.statusActive") } else { t("app.off") },
                s.place_names,
                t("ui.settings.placeNamesDesc"),
            ))
            .push(privacy_row(
                t("app.mapTiles"),
                if s.map_enabled { t("ui.settings.statusActive") } else { t("app.off") },
                s.map_enabled,
                t("app.mapTilesDesc"),
            ))
            ;
        // The App Store build makes no update checks (the App Store
        // updates it), so it sends neither.
        if !APP_STORE {
            col = col
                .push(privacy_row(t("ui.settings.updateReporting"), t("ui.settings.statusActive"), true, t("ui.settings.updateReportingDesc")))
                .push(privacy_row(t("ui.settings.deviceHash"), t("ui.settings.hashedSha256"), true, t("ui.settings.deviceHashDesc")));
        }
    }
    let check_label = match ui.update_check {
        CheckState::Idle => t("ui.settings.checkNow").to_string(),
        CheckState::Checking => t("ui.settings.checking").to_string(),
        CheckState::Found => t("ui.settings.updateFound").to_string(),
        CheckState::UpToDate => format!("{} ✓", t("ui.settings.upToDate")),
        CheckState::Failed => t("ui.settings.checkFailed").to_string(),
    };
    let check = button(text(check_label).size(12).font(theme::medium(theme::INTER)))
        .padding([6, 12])
        .style(theme::secondary_button)
        .on_press_maybe((ui.update_check == CheckState::Idle).then_some(Message::Setting(Change::CheckUpdates)));
    let update_row = |label: &'a str, desc: &'a str, control: Element<'a, Message>| {
        row![column![text(label).size(12).font(theme::medium(theme::INTER)), text(desc).size(10).color(theme::TEXT_MUTED)].spacing(2).width(Length::Fill), control]
            .spacing(12)
            .padding([8, 0])
            .align_y(Alignment::Center)
    };
    if !APP_STORE {
        col = col
            .push(update_row(t("ui.settings.prereleaseUpdates"), t("ui.settings.prereleaseUpdatesDesc"), toggle(s.prerelease, Change::Prerelease)))
            .push(update_row(t("ui.settings.checkForUpdates"), t("ui.settings.checkForUpdatesDesc"), check.into()));
    }
    col = col
        .push(
            container(
                row![
                    small_button(t("ui.settings.openSupportChat"), Change::OpenSupportChat),
                    small_button(t("ui.settings.viewChangelog"), Change::ViewChangelog),
                    small_button(t("ui.sharedClips.title"), Change::OpenSharedClips),
                ]
                .spacing(8),
            )
                .padding([8, 0]),
        );
    col = col.push(
        container(
            row![
                button(text(t("welcomeScreen.privacyLink")).size(12).color(theme::TEXT_SECONDARY))
                    .padding(0)
                    .style(theme::link_button)
                    .on_press(Message::Setting(Change::OpenLink(PRIVACY_URL))),
                text("·").size(12).color(theme::TEXT_FAINT),
                button(text(t("welcomeScreen.termsLink")).size(12).color(theme::TEXT_SECONDARY))
                    .padding(0)
                    .style(theme::link_button)
                    .on_press(Message::Setting(Change::OpenLink(TERMS_URL))),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
        )
        .padding(Padding { top: 12.0, ..Padding::ZERO })
        .center_x(Length::Fill),
    );
    container(col).padding([8, 14]).width(Length::Fill).into()
}

fn rows<'a>(s: &'a Settings, ui: &'a Ui, keys: &'a Shortcuts) -> Vec<Row<'a>> {
    use Section::*;
    let mut list = vec![
        setting(Display, None, t("ui.settings.language"), None, select(s, Menu::Language)),
        setting(Display, None, t("ui.settings.metricUnits"), None, toggle(s.metric, Change::Metric)),
        setting(
            Display,
            None,
            t("ui.settings.timeFormat"),
            None,
            select(s, Menu::TimeFormat),
        ),
        setting(Display, None, t("ui.settings.dateFormat"), None, select(s, Menu::DateFormat)),
        setting(Display, None, t("ui.settings.dialogStyle"), Some(t("ui.settings.dialogStyleDesc")), select(s, Menu::DialogStyle)),
        setting(
            Display,
            None,
            t("ui.settings.glassBlur"),
            None,
            row![
                slider(0.0..=30.0, s.glass_blur, |v| Message::Setting(Change::Blur(v))).step(1.0_f32).width(100).style(theme::settings_slider),
                text(format!("{}px", s.glass_blur.round() as i32))
                    .size(11)
                    .font(theme::semibold(theme::MONO))
                    .color(theme::TEXT_SECONDARY)
                    .width(32)
                    .align_x(iced::alignment::Horizontal::Right),
            ]
            .spacing(10)
            .align_y(Alignment::Center)
            .into(),
        ),
        setting(Playback, Some(Subtab::Dashboard), t("ui.settings.dashboard"), None, toggle(s.dashboard_enabled, Change::DashboardEnabled)),
        setting(
            Playback,
            Some(Subtab::Dashboard),
            t("ui.settings.dashboardStyle"),
            None,
            select(s, Menu::DashboardStyle),
        ),
        setting(
            Playback,
            Some(Subtab::Dashboard),
            t("ui.settings.acceleratorDisplay"),
            None,
            select(s, Menu::Accel),
        ),
        setting(Playback, Some(Subtab::Map), t("ui.settings.gpsMap"), None, toggle(s.map_enabled, Change::MapEnabled)),
        setting(
            Playback,
            Some(Subtab::Map),
            t("ui.settings.mapStyle"),
            None,
            select(s, Menu::MapStyle),
        ),
        setting(Playback, Some(Subtab::Map), t("ui.settings.placeNames"), Some(t("ui.settings.placeNamesDesc")), toggle(s.place_names, Change::PlaceNames)),
        setting(
            Playback,
            Some(Subtab::Cameras),
            t("ui.settings.sentryCameraGlow"),
            Some(t("ui.settings.sentryCameraGlowDesc")),
            toggle(s.sentry_glow, Change::SentryGlow),
        ),
        setting(
            Playback,
            Some(Subtab::Cameras),
            t("ui.settings.savedCameraGlow"),
            Some(t("ui.settings.savedCameraGlowDesc")),
            toggle(s.saved_glow, Change::SavedGlow),
        ),
        setting(Playback, Some(Subtab::Cameras), t("ui.settings.mirrorCameras"), None, toggle(s.mirror_cameras, Change::Mirror)),
        setting(
            Playback,
            Some(Subtab::Cameras),
            t("ui.settings.resetCameraOrder"),
            Some(t("ui.settings.resetCameraOrderDesc")),
            small_button(t("ui.settings.reset"), Change::ResetCameraOrder),
        ),
    ];
    // Fixed to Front Camera: only for the compact style (after its row).
    if s.dashboard_compact {
        // Language, metric, time, date, blur, overlay, style: then this.
        list.insert(
            7,
            setting(Playback, Some(Subtab::Dashboard), t("ui.settings.fixedToFrontCamera"), None, toggle(s.compact_fixed, Change::CompactFixed)),
        );
    }
    // Keyboard Shortcuts, in the order earlier versions used (Skip Duration
    // after the skips).
    for action in shortcuts::EDITABLE {
        list.push(Row { section: Shortcuts, subtab: None, words: action_label(action).to_string(), view: keybind_row(action, keys, ui.recording) });
        if action == Action::SkipBackward {
            list.push(setting(Shortcuts, None, t("ui.settings.skipDuration"), None, select(s, Menu::Skip)));
        }
    }
    let path = |p: &Option<std::path::PathBuf>| p.as_ref().map(|p| p.display().to_string());
    list.push(Row {
        section: Storage,
        subtab: None,
        words: t("ui.settings.teslacamFolder").to_string(),
        view: path_row(t("ui.settings.teslacamFolder"), path(&s.default_folder), t("ui.settings.noFolderSet"), Change::BrowseFolder, Change::ClearFolder),
    });
    list.push(Row {
        section: SentryUsb,
        subtab: None,
        words: t("app.driveDataHeading").into(),
        view: path_row(t("app.driveDataHeading"), path(&s.drive_data), t("app.noDriveDataFile"), Change::BrowseDriveData, Change::ClearDriveData),
    });
    list.push(setting(
        SentryUsb,
        None,
        t("app.showDriveStats"),
        Some(t("app.showDriveStatsDesc")),
        toggle(s.show_drive_stats, Change::ShowDriveStats),
    ));
    list.push(setting(
        SentryUsb,
        None,
        t("app.showFsdEvents"),
        Some(t("app.showFsdEventsDesc")),
        toggle(s.show_fsd_events, Change::ShowFsdEvents),
    ));
    list.push(Row { section: System, subtab: None, words: format!(
            "{} {} {} {} {} {} {} {}",
            t("ui.sharedClips.title"),
            t("ui.settings.appVersion"),
            t("ui.settings.architecture"),
            t("ui.settings.prereleaseUpdates"),
            t("ui.settings.checkForUpdates"),
            t("ui.settings.viewChangelog"),
            t("ui.settings.openSource"),
            t("ui.settings.openSupportChat")
        ),
        view: system_section(s, ui),
    });
    list
}

fn nav_item<'a>(glyph: &'static str, label: &'a str, active: bool, highlight: bool, section: Section) -> Element<'a, Message> {
    let color = if active || highlight { theme::ACCENT } else { theme::TEXT_SECONDARY };
    button(row![crate::svg_icon(glyph, 16.0, color), text(label).size(12).font(theme::medium(theme::INTER))].spacing(8).align_y(Alignment::Center))
        .width(Length::Fill)
        .padding([8, 10])
        .style(theme::settings_nav(active, highlight))
        .on_press(Message::SettingsSection(section))
        .into()
}

fn subtab_bar<'a>(current: Subtab) -> Element<'a, Message> {
    let tab = |label: &'a str, sub: Subtab| -> Element<'a, Message> {
        button(container(text(label).size(12).font(theme::semibold(theme::INTER))).center_x(Length::Fill))
            .width(Length::Fill)
            .padding([7, 10])
            .style(theme::settings_nav(sub == current, false))
            .on_press(Message::SettingsSubtab(sub))
            .into()
    };
    container(
        row![
            tab(t("ui.settings.subtabDashboard"), Subtab::Dashboard),
            tab(t("ui.settings.subtabMap"), Subtab::Map),
            tab(t("ui.settings.subtabCameras"), Subtab::Cameras)
        ]
        .spacing(4),
    )
        .padding(4)
        .width(Length::Fill)
        .style(theme::subtab_bar)
        .into()
}

/// `on_size` reports the dialog's size, so the video under it is frosted.
pub fn view<'a>(s: &'a Settings, ui: &'a Ui, keys: &'a Shortcuts, on_size: fn(iced::Size) -> Message) -> Element<'a, Message> {
    let needle = ui.search.trim().to_lowercase();
    let searching = !needle.is_empty();
    let all = rows(s, ui, keys);
    let matches = |r: &Row<'_>| r.words.to_lowercase().contains(&needle);
    let hit = |sec: Section| searching && all.iter().any(|r| r.section == sec && matches(r));

    let search = stack![
        text_input(t("ui.settings.searchPlaceholder"), &ui.search)
            .on_input(Message::SettingsSearch)
            .size(11)
            .padding(Padding { top: 7.0, right: 10.0, bottom: 7.0, left: 30.0 })
            .style(theme::settings_search),
        container(crate::svg_icon(SEARCH_SVG, 13.0, theme::TEXT_FAINT)).padding(Padding { left: 9.0, ..Padding::ZERO }).center_y(Length::Fill),
    ];
    let nav = |glyph, key, section| nav_item(glyph, t(key), !searching && ui.section == section, hit(section), section);
    let sidebar = container(
        column![
            container(search).padding(Padding { bottom: 4.0, ..Padding::ZERO }),
            column![
                nav(DISPLAY_SVG, "ui.settings.displaySection", Section::Display),
                nav(PLAYBACK_SVG, "ui.settings.playbackOverlays", Section::Playback),
                nav(SHORTCUTS_SVG, "ui.settings.keyboardShortcuts", Section::Shortcuts),
                nav(STORAGE_SVG, "ui.settings.storageSection", Section::Storage),
                nav_item(SENTRYUSB_SVG, "Sentry USB", !searching && ui.section == Section::SentryUsb, hit(Section::SentryUsb), Section::SentryUsb),
                nav(SYSTEM_SVG, "ui.settings.systemSecurity", Section::System),
            ]
            .spacing(2),
        ]
        .spacing(8),
    )
    .padding([14, 10])
    .width(160)
    .height(Length::Fill)
    .style(theme::modal_nav);

    let mut body: Column<'_, Message> = Column::new();
    if searching {
        let found: Vec<Row<'_>> = all.into_iter().filter(|r| matches(r)).collect();
        if found.is_empty() {
            body = body.push(container(text(t("app.noMatchingSettings")).size(12).color(theme::TEXT_MUTED)).padding([24, 14]));
        }
        for r in found {
            body = body.push(r.view);
        }
    } else {
        if ui.section == Section::Playback {
            body = body.push(container(subtab_bar(ui.subtab)).padding(Padding { bottom: 14.0, ..Padding::ZERO }));
        }
        for r in all.into_iter().filter(|r| r.section == ui.section && r.subtab.is_none_or(|sub| sub == ui.subtab)) {
            body = body.push(r.view);
        }
    }
    let content = container(iced::widget::scrollable(container(body).padding([16, 20]).width(Length::Fill)).style(theme::thin_scroll))
        .width(Length::Fill)
        .height(Length::Fill);

    // The header: icon and title, the close button, then the gradient
    // accent line along the bottom.
    let header = column![
        container(
            row![
                theme::icon(theme::icon::SETTINGS, 20.0).color(theme::ACCENT),
                text(t("ui.settings.title")).size(15).font(theme::semibold(theme::INTER)),
                space().width(Length::Fill),
                button(container(text("×").size(18)).center(Length::Fill))
                    .width(28)
                    .height(28)
                    .padding(0)
                    .style(theme::modal_close)
                    .on_press(Message::CloseSettings),
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        )
        .padding([18, 22]),
        container(container(space().height(1)).width(Length::Fill).style(theme::accent_line)).padding([0, 20]),
    ];

    let footer = container(row![
        space().width(Length::Fill),
        button(text(t("ui.settings.done")).size(13).font(theme::semibold(theme::INTER)))
            .padding([10, 20])
            .style(theme::primary_button)
            .on_press(Message::CloseSettings),
    ])
    .padding([16, 22])
    .width(Length::Fill)
    .style(theme::modal_footer);

    let dialog = container(column![
        container(header).style(theme::modal_header),
        row![sidebar, container(space().width(1)).height(Length::Fill).style(theme::subtle_line), content].height(520),
        container(space().height(1)).width(Length::Fill).style(theme::subtle_line),
        footer,
    ])
    .width(700)
    .clip(true)
    .style(theme::modal);

    // Clicking the dimmed page closes the window; clicks on it stay inside.
    let dialog = iced::widget::sensor(opaque(dialog)).on_show(on_size).on_resize(on_size);
    opaque(mouse_area(container(dialog).center(Length::Fill).style(theme::backdrop)).on_press(Message::CloseSettings))
}
