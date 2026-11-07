//! Translations in 13 languages. `t("ui.settings.title")` gives the text in
//! the chosen language, falling back to English (and to the key itself if
//! even that is missing).
//!
//! The strings are in assets/i18n/translations.json: ui.* and
//! welcomeScreen.* (worded as in earlier versions of Sentry Studio) and
//! app.* (added since: the Drives list, newer Settings rows, the privacy
//! notice).

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

/// The languages, in Settings order: code and name.
pub const LANGUAGES: [(&str, &str); 13] = [
    ("en", "English"),
    ("es", "Español"),
    ("fr", "Français"),
    ("de", "Deutsch"),
    ("zh", "简体中文"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("pt", "Português"),
    ("ru", "Русский"),
    ("it", "Italiano"),
    ("nl", "Nederlands"),
    ("pl", "Polski"),
    ("tr", "Türkçe"),
];

type Table = HashMap<&'static str, HashMap<&'static str, &'static str>>;

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let raw: HashMap<String, HashMap<String, String>> =
            serde_json::from_str(include_str!("../assets/i18n/translations.json")).unwrap_or_default();
        // Kept for the life of the app, so lookups hand out &'static str.
        raw.into_iter()
            .map(|(lang, map)| {
                let map = map.into_iter().map(|(k, v)| (&*Box::leak(k.into_boxed_str()), &*Box::leak(v.into_boxed_str()))).collect();
                (&*Box::leak(lang.into_boxed_str()), map)
            })
            .collect()
    })
}

/// Index into LANGUAGES of the current language.
static CURRENT: AtomicUsize = AtomicUsize::new(0);

/// Switches the language ("de"); unknown codes fall back to English.
pub fn set_language(code: &str) {
    let i = LANGUAGES.iter().position(|(c, _)| *c == code).unwrap_or(0);
    CURRENT.store(i, Ordering::Relaxed);
}

pub fn language() -> &'static str {
    LANGUAGES[CURRENT.load(Ordering::Relaxed)].0
}

/// The text for a key in the current language.
pub fn t(key: &'static str) -> &'static str {
    lookup(language(), key)
}

/// `t` with `{name}` placeholders filled in ("Found {count} dates").
pub fn tf(key: &'static str, args: &[(&str, &str)]) -> String {
    let mut s = t(key).to_string();
    for (name, value) in args {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

fn lookup(lang: &str, key: &'static str) -> &'static str {
    let table = table();
    table
        .get(lang)
        .and_then(|m| m.get(key))
        .or_else(|| table.get("en").and_then(|m| m.get(key)))
        .copied()
        .unwrap_or(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_up_and_falls_back() {
        // Not through set_language: other tests read the shared language.
        assert_eq!(lookup("en", "ui.settings.title"), "Settings");
        assert_eq!(lookup("de", "ui.settings.title"), "Einstellungen");
        assert_eq!(lookup("de", "ui.no.such.key"), "ui.no.such.key");
        // A key a language lacks falls back to English.
        assert_eq!(lookup("xx", "ui.settings.done"), "Done");
        // Every language is in the table, with every string English has.
        for (code, _) in LANGUAGES {
            let lang = table().get(code).unwrap_or_else(|| panic!("{code} missing"));
            for key in table()["en"].keys() {
                assert!(lang.contains_key(key), "{code} lacks {key}");
            }
        }
        assert_eq!(lookup("fr", "app.departed"), "Départ");
    }
}
