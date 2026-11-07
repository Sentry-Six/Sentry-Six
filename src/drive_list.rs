//! The Drives tab: drive cards under date headers, newest first.
//!
//! A SentryUSB history can hold well over a thousand drives and the view is
//! rebuilt on every video frame while playing, so only the cards near the
//! visible part of the list are built; the rest are empty space of the
//! same height. Every card's height is fixed by what it shows, so the list
//! knows exactly where each one sits.

use crate::drives::{self, DriveInfo};
use crate::theme::{self, icon};
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{Tree, Widget};
use iced::advanced::{mouse, renderer};
use iced::widget::scrollable::{Direction, Scrollbar};
use iced::widget::{button, column, container, row, scrollable, space, stack, text, Column, Space};
use iced::{Alignment, Color, Element, Length, Rectangle, Size};
use std::collections::HashSet;

const HEADER_H: f32 = 30.0;
const GAP: f32 = 8.0;
/// Rows built above and below the visible part.
const OVERSCAN: f32 = 400.0;

/// One row of the list: a date header or a drive (index into the drives).
#[derive(Debug, Clone, Copy)]
pub enum Row {
    Header(usize),
    Drive(usize),
}

/// Width inside a card (panel 340, list and card padding, borders).
const CARD_INNER_W: f32 = 340.0 - 2.0 * 12.0 - 2.0 * 12.0 - 2.0;
const CHIP_H: f32 = 22.0;
const CHIP_GAP: f32 = 5.0;

/// The chips a card shows: icon, label, tone.
fn chips_for(d: &DriveInfo, metric: bool, has_footage: bool, stats: bool) -> Vec<(char, String, theme::ChipTone)> {
    let mut chips = vec![
        (theme::icon::STRAIGHTEN, drives::distance(d, metric), theme::ChipTone::Plain),
        (theme::icon::SCHEDULE, drives::journey_duration(d.duration_ms), theme::ChipTone::Plain),
    ];
    if d.has_fsd {
        // The value is shown as is ("FSD 43.2%"); the tone comes from it.
        let fsd = d.fsd_percent;
        let tone = if fsd >= 95.0 { theme::ChipTone::Green } else if fsd >= 50.0 { theme::ChipTone::Accent } else { theme::ChipTone::Slate };
        chips.push((theme::icon::AUTO_AWESOME, format!("FSD {fsd}%"), tone));
    }
    if has_footage {
        chips.push((theme::icon::VIDEOCAM, crate::i18n::t("app.footage").into(), theme::ChipTone::Green));
    }
    // Settings › SentryUSB › Show Drive Stats hides the accelerator count.
    if stats && d.accel_pushes > 0 {
        chips.push((theme::icon::BOLT, d.accel_pushes.to_string(), theme::ChipTone::Slate));
    }
    chips
}

/// Lines the chips wrap onto, from an estimate of each chip's width
/// (11 px Inter, a little generous so a chip never runs off the card).
fn chip_lines(chips: &[(char, String, theme::ChipTone)]) -> usize {
    let mut lines = 1;
    let mut x = 0.0;
    for (_, label, _) in chips {
        let w = 16.0 + 2.0 + 12.0 + 3.0 + label.chars().count() as f32 * 6.8;
        if x > 0.0 && x + CHIP_GAP + w > CARD_INNER_W {
            lines += 1;
            x = w;
        } else {
            x += if x > 0.0 { CHIP_GAP } else { 0.0 } + w;
        }
    }
    lines
}

/// Shortens the start and end names with "…" so they fit side by side,
/// giving room a short name does not use to the other one. Widths are
/// estimated (12.5 px semibold Inter).
pub fn fit_names(start: &str, end: &str) -> (String, String) {
    const BUDGET: usize = ((CARD_INNER_W - 12.0) / 7.2) as usize;
    const HALF: usize = BUDGET / 2;
    let (a, b) = (start.chars().count(), end.chars().count());
    if a + b <= BUDGET {
        return (start.to_string(), end.to_string());
    }
    let keep_a = a.min(HALF.max(BUDGET.saturating_sub(b)));
    let keep_b = b.min(BUDGET - keep_a);
    let cut = |s: &str, n: usize, len: usize| {
        if len <= n {
            s.to_string()
        } else {
            format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>().trim_end().trim_end_matches(','))
        }
    };
    (cut(start, keep_a, a), cut(end, keep_b, b))
}

/// The height a drive's card takes: padding, journey, chip lines, plus the
/// disengagement and tag rows when it has them.
pub fn card_height(d: &DriveInfo, metric: bool, has_footage: bool, stats: bool) -> f32 {
    let lines = chip_lines(&chips_for(d, metric, has_footage, stats)) as f32;
    let mut h = 24.0 + 2.0 + 56.0 + 10.0 + lines * CHIP_H + (lines - 1.0) * CHIP_GAP;
    if d.disengagements > 0 {
        h += 10.0 + 16.0;
    }
    if !d.tags.is_empty() {
        h += 10.0 + 20.0;
    }
    h
}

pub fn has_footage(d: &DriveInfo, footage_days: &HashSet<String>) -> bool {
    drives::clip_days(d).iter().any(|day| footage_days.contains(day))
}

/// Rows in display order and where each starts, for the drives at
/// `shown` (indices into `drives`, newest first).
pub fn layout(drives: &[DriveInfo], shown: &[usize], metric: bool, stats: bool, footage_days: &HashSet<String>) -> (Vec<Row>, Vec<f32>, f32) {
    let mut rows = Vec::new();
    let mut tops = Vec::new();
    let mut y = 0.0;
    let mut last_date: Option<&str> = None;
    for &i in shown {
        let d = &drives[i];
        if last_date != Some(d.date.as_str()) {
            rows.push(Row::Header(i));
            tops.push(y);
            y += HEADER_H;
            last_date = Some(d.date.as_str());
        }
        rows.push(Row::Drive(i));
        tops.push(y);
        y += card_height(d, metric, has_footage(d, footage_days), stats) + GAP;
    }
    (rows, tops, y)
}

pub struct ListView<'a> {
    pub drives: &'a [DriveInfo],
    pub rows: &'a [Row],
    pub tops: &'a [f32],
    pub total: f32,
    pub selected: Option<u64>,
    pub scroll: f32,
    pub viewport: f32,
    pub metric: bool,
    /// Settings › SentryUSB › Show Drive Stats.
    pub stats: bool,
    pub h24: bool,
    /// Days that have footage in the opened folder.
    pub footage_days: &'a HashSet<String>,
    /// Place names for start and end points (coordinates until known).
    pub places: Option<&'a crate::geocode::Geocoder>,
}

pub fn view<'a, M: Clone + 'a>(
    v: ListView<'a>,
    on_select: impl Fn(usize) -> M + 'a,
    on_scroll: impl Fn(f32, f32) -> M + 'a,
) -> Element<'a, M> {
    let from = v.scroll - OVERSCAN;
    let to = v.scroll + v.viewport.max(600.0) + OVERSCAN;
    let first = v.tops.partition_point(|&t| t < from).saturating_sub(1);
    let last = v.tops.partition_point(|&t| t < to).min(v.rows.len());
    let mut col = Column::new();
    let top_space = v.tops.get(first).copied().unwrap_or(0.0);
    col = col.push(Space::new().height(top_space));
    let mut bottom = top_space;
    // Unnamed spots, on screen first and then the overscan, for the
    // geocoder to look up in that order.
    let (mut on_screen, mut nearby) = (Vec::new(), Vec::new());
    for k in first..last {
        let row_el: Element<'a, M> = match v.rows[k] {
            Row::Header(i) => container(text(drives::date_header(&v.drives[i].date)).size(10).font(theme::semibold(theme::INTER)).color(theme::TEXT_FAINT))
                .height(HEADER_H - 4.0)
                .width(Length::Fill)
                .padding([8, 6])
                .style(theme::date_band)
                .into(),
            Row::Drive(i) => {
                let d = &v.drives[i];
                let footage = has_footage(d, v.footage_days);
                let top = v.tops[k];
                let visible = top + 60.0 >= v.scroll && top <= v.scroll + v.viewport;
                let mut place = |p: Option<(f64, f64)>| -> String {
                    if let (Some((lat, lon)), Some(g)) = (p, v.places) {
                        match g.cached(lat, lon) {
                            Some(Some(name)) => return name,
                            Some(None) => {}
                            None => if visible { on_screen.push((lat, lon)) } else { nearby.push((lat, lon)) },
                        }
                    }
                    drives::gps_label(p)
                };
                let names = (place(d.start_point), place(d.end_point));
                column![card(d, names, v.selected == Some(d.id), footage, Look { metric: v.metric, stats: v.stats, h24: v.h24 }, on_select(i)), Space::new().height(GAP)].into()
            }
        };
        col = col.push(row_el);
        bottom = v.tops.get(k + 1).copied().unwrap_or(v.total);
    }
    col = col.push(Space::new().height((v.total - bottom).max(0.0)));
    if let Some(g) = v.places {
        on_screen.extend(nearby);
        g.show(&on_screen);
    }
    // A thin pill over the content.
    scrollable(col.padding([0, 12]))
        .direction(Direction::Vertical(Scrollbar::new().width(6).scroller_width(6).margin(3)))
        .style(theme::thin_scroll)
        .height(Length::Fill)
        .on_scroll(move |vp| on_scroll(vp.absolute_offset().y, vp.bounds().height))
        .into()
}

/// A dashed 1 px line across the space it is given.
struct Dashes;

impl<M, Theme, R: iced::advanced::Renderer> Widget<M, Theme, R> for Dashes {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fixed(1.0))
    }
    fn layout(&mut self, _tree: &mut Tree, _renderer: &R, limits: &layout::Limits) -> layout::Node {
        layout::atomic(limits, Length::Fill, Length::Fixed(1.0))
    }
    fn draw(
        &self,
        _tree: &Tree,
        renderer: &mut R,
        _theme: &Theme,
        _style: &renderer::Style,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _viewport: &Rectangle,
    ) {
        let b = layout.bounds();
        let (dash, gap): (f32, f32) = (3.0, 3.0);
        let mut x = b.x;
        while x < b.x + b.width {
            let w = dash.min(b.x + b.width - x);
            renderer.fill_quad(
                renderer::Quad { bounds: Rectangle { x, y: b.y, width: w, height: 1.0 }, ..Default::default() },
                Color { a: 0.22, ..Color::WHITE },
            );
            x += dash + gap;
        }
    }
}

fn dashes<'a, M: 'a>() -> Element<'a, M> {
    Element::new(Dashes)
}

fn chip<'a, M: 'a>(glyph: char, label: String, tone: theme::ChipTone) -> Element<'a, M> {
    container(row![icon(glyph, 12.0), text(label).size(11).font(theme::medium(theme::INTER))].spacing(3).align_y(Alignment::Center))
        .padding([3, 8])
        .style(theme::chip(tone))
        .into()
}

/// The Settings a card follows: units, Show Drive Stats, 24-hour clock.
#[derive(Clone, Copy)]
struct Look {
    metric: bool,
    stats: bool,
    h24: bool,
}

fn card<'a, M: Clone + 'a>(d: &DriveInfo, names: (String, String), selected: bool, has_footage: bool, look: Look, on_press: M) -> Element<'a, M> {
    let Look { metric, stats, h24 } = look;
    let time = |s: String| text(s).size(13).font(theme::semibold(theme::INTER)).color(theme::TEXT);
    // The journey track: origin pin, dashed line, destination pin
    let track = row![
        container(Space::new().width(8).height(8)).style(theme::pin_origin),
        dashes(),
        container(Space::new().width(8).height(8)).style(theme::pin_dest),
    ]
    .spacing(5)
    .align_y(Alignment::Center)
    .width(Length::Fill);
    let label = |s: &'static str| text(s).size(11).font(theme::semibold(theme::INTER)).color(theme::TEXT_FAINT);
    // Place names: one line each, start on the left and end on the right.
    let place = |s: String, right: bool| {
        text(s)
            .size(12.5)
            .font(theme::semibold(theme::INTER))
            .color(theme::TEXT)
            .wrapping(iced::widget::text::Wrapping::None)
            .width(Length::FillPortion(1))
            .align_x(if right { iced::alignment::Horizontal::Right } else { iced::alignment::Horizontal::Left })
    };
    let journey = column![
        row![time(drives::clock(d.start_ms, h24)), track, time(drives::clock(d.end_ms, h24))].spacing(8).align_y(Alignment::Center),
        row![label(crate::i18n::t("app.departed")), space().width(Length::Fill), label(crate::i18n::t("app.arrived"))],
        {
            let (a, b) = fit_names(&names.0, &names.1);
            row![
                container(place(a, false)).width(Length::FillPortion(1)).clip(true),
                container(place(b, true)).width(Length::FillPortion(1)).align_x(iced::alignment::Horizontal::Right).clip(true),
            ]
            .spacing(12)
        },
    ]
    .spacing(4)
    .height(56);

    let chip_list = chips_for(d, metric, has_footage, stats);
    let lines = chip_lines(&chip_list) as f32;
    let chips = chip_list
        .into_iter()
        .fold(row![].spacing(CHIP_GAP), |r, (glyph, label, tone)| r.push(chip(glyph, label, tone)))
        .wrap()
        .vertical_spacing(CHIP_GAP)
        .align_x(Alignment::Center);

    let mut body = Column::new().spacing(10).push(journey);
    if d.disengagements > 0 {
        let red = Color { a: 0.9, ..theme::ERROR };
        let n = d.disengagements;
        body = body.push(
            row![
                icon(theme::icon::WARNING, 13.0).color(red),
                text(if n == 1 { crate::i18n::t("app.disengagementOne").to_string() } else { crate::i18n::tf("app.disengagements", &[("n", &n.to_string())]) }).size(11).font(theme::medium(theme::INTER)).color(red),
            ]
            .spacing(5)
            .align_y(Alignment::Center)
            .height(16),
        );
    }
    body = body.push(container(chips).width(Length::Fill).height(lines * CHIP_H + (lines - 1.0) * CHIP_GAP));
    if !d.tags.is_empty() {
        let tags = d.tags.iter().fold(row![].spacing(5), |r, t| {
            r.push(container(text(t.clone()).size(10).font(theme::semibold(theme::INTER))).padding([2, 8]).style(theme::tag_pill))
        });
        body = body.push(container(tags).height(20));
    }
    let content = container(body).padding(12).width(Length::Fill).height(Length::Fill).clip(true);
    button(stack![content])
        .padding(0)
        .width(Length::Fill)
        .height(card_height(d, metric, has_footage, stats))
        .style(theme::clip_card(selected))
        .on_press(on_press)
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(id: u64, date: &str) -> DriveInfo {
        DriveInfo {
            id,
            date: date.into(),
            start_ms: 0.0,
            end_ms: 0.0,
            duration_ms: 0.0,
            km: 0.0,
            mi: 0.0,
            has_fsd: false,
            fsd_percent: 0.0,
            disengagements: 0,
            accel_pushes: 0,
            tags: vec![],
            clip_keys: vec![],
            start_point: None,
            route: Vec::new(),
            fsd_events: Vec::new(),
            end_point: None,
        }
    }

    #[test]
    fn headers_between_days_and_exact_offsets() {
        let mut ds = vec![drive(1, "2026-11-06"), drive(2, "2026-11-06"), drive(3, "2026-11-05")];
        ds[1].tags = vec!["work".into()];
        let none = HashSet::new();
        let (rows, tops, total) = layout(&ds, &[0, 1, 2], true, true, &none);
        assert!(matches!(rows[0], Row::Header(0)));
        assert!(matches!(rows[3], Row::Header(2)));
        assert_eq!(rows.len(), 5);
        assert_eq!(tops[1], HEADER_H);
        assert_eq!(tops[2], HEADER_H + card_height(&ds[0], true, false, true) + GAP);
        assert_eq!(total, 2.0 * HEADER_H + ds.iter().map(|d| card_height(d, true, false, true) + GAP).sum::<f32>());
    }

    #[test]
    fn long_names_share_the_line() {
        let (a, b) = fit_names("Ellerslie Road SW", "5221, 5225, 5229, 5233 Ellerslie Road SW");
        assert_eq!(a, "Ellerslie Road SW");
        let budget = ((CARD_INNER_W - 12.0) / 7.2) as usize;
        assert!(b.ends_with('…') && a.chars().count() + b.chars().count() <= budget, "{a} | {b}");
        let (a, b) = fit_names("Chivers Crescent SW", "Ellerslie Road SW");
        assert_eq!((a.as_str(), b.as_str()), ("Chivers Crescent SW", "Ellerslie Road SW"));
    }

    #[test]
    fn card_wraps_its_chips() {
        // 14.5 km, 19 min, FSD 43.2%, Footage: Footage goes on a second line.
        let mut d = drive(1, "2026-11-05");
        d.km = 14.5;
        d.duration_ms = 19.0 * 60000.0;
        d.has_fsd = true;
        d.fsd_percent = 43.2;
        assert_eq!(chip_lines(&chips_for(&d, true, true, true)), 2);
        assert_eq!(chip_lines(&chips_for(&d, true, false, true)), 1);
    }
}
