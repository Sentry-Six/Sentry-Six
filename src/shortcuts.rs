//! Keyboard and mouse-button shortcuts.
//!
//! Every action starts unbound; the user assigns keys in Settings and they
//! are saved as identifiers like "space", "arrowleft", "ctrl+keyk" or
//! "mouse3" (modifiers, then the browser-style key code or mouse button
//! number, lower case), the format earlier versions of Sentry Studio saved,
//! so their keys carry over. On top of that Space and the arrow keys
//! play/pause and skip, unless the user put that key or that action
//! elsewhere. Escape always leaves a focused camera.

use iced::keyboard::{key::Code, Modifiers};
use iced::mouse::Button;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    PlayPause,
    SkipForward,
    SkipBackward,
    SpeedUp,
    SpeedDown,
    SpeedReset,
    SpeedMax,
    ToggleDash,
    ToggleMap,
    ToggleMetric,
    ToggleClips,
    NextClip,
    PrevClip,
}

impl Action {
    /// The action names (the keys of the `keybinds` setting).
    fn from_setting_name(name: &str) -> Option<Self> {
        Some(match name {
            "playPause" => Action::PlayPause,
            "skipForward" => Action::SkipForward,
            "skipBackward" => Action::SkipBackward,
            "speedUp" => Action::SpeedUp,
            "speedDown" => Action::SpeedDown,
            "speedReset" => Action::SpeedReset,
            "speedMax" => Action::SpeedMax,
            "toggleDash" => Action::ToggleDash,
            "toggleMap" => Action::ToggleMap,
            "toggleMetric" => Action::ToggleMetric,
            "toggleClips" => Action::ToggleClips,
            "nextClip" => Action::NextClip,
            "prevClip" => Action::PrevClip,
            // setMarkerIn/Out: export markers, which this version doesn't have.
            _ => return None,
        })
    }

    /// The action's name (its key in the `keybinds` setting).
    pub fn setting_name(self) -> &'static str {
        match self {
            Action::PlayPause => "playPause",
            Action::SkipForward => "skipForward",
            Action::SkipBackward => "skipBackward",
            Action::SpeedUp => "speedUp",
            Action::SpeedDown => "speedDown",
            Action::SpeedReset => "speedReset",
            Action::SpeedMax => "speedMax",
            Action::ToggleDash => "toggleDash",
            Action::ToggleMap => "toggleMap",
            Action::ToggleMetric => "toggleMetric",
            Action::ToggleClips => "toggleClips",
            Action::NextClip => "nextClip",
            Action::PrevClip => "prevClip",
        }
    }

    /// The key Space and the arrows give the action when it has none.
    pub fn default_key(self) -> Option<&'static str> {
        match self {
            Action::PlayPause => Some("space"),
            Action::SkipForward => Some("arrowright"),
            Action::SkipBackward => Some("arrowleft"),
            _ => None,
        }
    }

    /// Whether holding the key down should repeat the action.
    pub fn repeats(self) -> bool {
        matches!(self, Action::SkipForward | Action::SkipBackward)
    }
}

/// The actions in Settings › Keyboard Shortcuts, in the order earlier
/// versions used (without their export marker rows).
pub const EDITABLE: [Action; 13] = [
    Action::PlayPause,
    Action::SkipForward,
    Action::SkipBackward,
    Action::ToggleDash,
    Action::ToggleMap,
    Action::ToggleMetric,
    Action::ToggleClips,
    Action::NextClip,
    Action::PrevClip,
    Action::SpeedUp,
    Action::SpeedDown,
    Action::SpeedReset,
    Action::SpeedMax,
];

/// Whether an identifier is only a modifier key (ignored while recording).
pub fn is_modifier_only(id: &str) -> bool {
    let key = id.rsplit('+').next().unwrap_or(id);
    ["controlleft", "controlright", "shiftleft", "shiftright", "altleft", "altright", "superleft", "superright", "metaleft", "metaright"]
        .contains(&key)
}

/// How a binding is shown: "Space", "Ctrl + K", "←", "Mouse Back".
pub fn display(id: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in id.split('+') {
        let name = match part {
            "ctrl" => crate::i18n::t("app.keyCtrl").to_string(),
            "alt" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            "meta" => "Meta".to_string(),
            "space" => crate::i18n::t("app.keySpace").to_string(),
            "arrowup" => "↑".to_string(),
            "arrowdown" => "↓".to_string(),
            "arrowleft" => "←".to_string(),
            "arrowright" => "→".to_string(),
            "mouse1" => crate::i18n::t("app.keyMouseMiddle").to_string(),
            "mouse3" => crate::i18n::t("app.keyMouseBack").to_string(),
            "mouse4" => crate::i18n::t("app.keyMouseForward").to_string(),
            k if k.starts_with("key") && k.len() == 4 => k[3..].to_uppercase(),
            k if k.starts_with("digit") && k.len() == 6 => k[5..].to_string(),
            k if k.starts_with("numpad") => format!("Num {}", &k[6..]),
            k => {
                // "pageup" -> "Pageup", "f5" -> "F5", "comma" -> "Comma".
                let mut c = k.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            }
        };
        parts.push(name);
    }
    parts.join(" + ")
}

#[derive(Debug, Clone, Default)]
pub struct Shortcuts {
    by_identifier: HashMap<String, Action>,
}

impl Shortcuts {
    /// `keybinds` is the setting: action name -> identifier.
    pub fn new(keybinds: &HashMap<String, String>) -> Self {
        let mut by_identifier = HashMap::new();
        let mut bound = Vec::new();
        for (name, id) in keybinds {
            if let Some(action) = Action::from_setting_name(name) {
                // An empty binding means "none" (a cleared default).
                if !id.is_empty() {
                    by_identifier.insert(id.to_lowercase(), action);
                }
                bound.push(action);
            }
        }
        for action in EDITABLE {
            let Some(id) = action.default_key() else { continue };
            if !bound.contains(&action) && !by_identifier.contains_key(id) {
                by_identifier.insert(id.to_string(), action);
            }
        }
        Self { by_identifier }
    }

    pub fn action(&self, identifier: &str) -> Option<Action> {
        self.by_identifier.get(identifier).copied()
    }

    /// The key that runs an action (its own, or the default one).
    pub fn key_for(&self, action: Action) -> Option<&str> {
        let mut keys: Vec<&str> = self.by_identifier.iter().filter(|(k, a)| **a == action && !k.is_empty()).map(|(k, _)| k.as_str()).collect();
        keys.sort();
        keys.first().copied()
    }
}

fn with_modifiers(mods: Modifiers, key: &str) -> String {
    let mut parts = Vec::new();
    if mods.control() {
        parts.push("ctrl");
    }
    if mods.alt() {
        parts.push("alt");
    }
    if mods.shift() {
        parts.push("shift");
    }
    if mods.logo() {
        parts.push("meta");
    }
    parts.push(key);
    parts.join("+").to_lowercase()
}

/// The identifier for a key press. The browser-style `KeyboardEvent.code`
/// names earlier versions saved match iced's key codes ("Space",
/// "ArrowLeft", "KeyK", "Digit1").
pub fn key_identifier(code: Code, mods: Modifiers) -> String {
    with_modifiers(mods, &format!("{code:?}"))
}

/// The identifier for the bindable mouse buttons (middle, back, forward
/// are buttons 1, 3 and 4, numbered as browsers do).
pub fn mouse_identifier(button: Button, mods: Modifiers) -> Option<String> {
    let n = match button {
        Button::Middle => 1,
        Button::Back => 3,
        Button::Forward => 4,
        _ => return None,
    };
    Some(with_modifiers(mods, &format!("mouse{n}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_match_the_saved_format() {
        assert_eq!(key_identifier(Code::Space, Modifiers::empty()), "space");
        assert_eq!(key_identifier(Code::KeyK, Modifiers::CTRL | Modifiers::SHIFT), "ctrl+shift+keyk");
        assert_eq!(key_identifier(Code::ArrowLeft, Modifiers::empty()), "arrowleft");
        assert_eq!(mouse_identifier(Button::Back, Modifiers::empty()).as_deref(), Some("mouse3"));
        assert_eq!(mouse_identifier(Button::Left, Modifiers::empty()), None);
    }

    #[test]
    fn cleared_default_stays_off() {
        let mut saved = HashMap::new();
        saved.insert("playPause".to_string(), String::new());
        let s = Shortcuts::new(&saved);
        assert_eq!(s.action("space"), None);
        assert_eq!(s.key_for(Action::PlayPause), None);
        assert_eq!(s.key_for(Action::SkipForward), Some("arrowright"));
    }

    #[test]
    fn display_names() {
        assert_eq!(display("space"), "Space");
        assert_eq!(display("ctrl+shift+keyk"), "Ctrl + Shift + K");
        assert_eq!(display("arrowleft"), "←");
        assert_eq!(display("digit5"), "5");
        assert_eq!(display("mouse3"), "Mouse Back");
        assert_eq!(display("f5"), "F5");
        assert!(is_modifier_only("ctrl+controlleft"));
        assert!(!is_modifier_only("ctrl+keyk"));
    }

    #[test]
    fn saved_bindings_win_over_defaults() {
        let mut saved = HashMap::new();
        saved.insert("playPause".to_string(), "keyk".to_string());
        saved.insert("nextClip".to_string(), "arrowright".to_string());
        let s = Shortcuts::new(&saved);
        assert_eq!(s.action("keyk"), Some(Action::PlayPause));
        assert_eq!(s.action("space"), None); // play/pause already has a key
        assert_eq!(s.action("arrowright"), Some(Action::NextClip)); // key taken
        assert_eq!(s.action("arrowleft"), Some(Action::SkipBackward));
    }
}
