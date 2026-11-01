//! Keyboard accelerators, action ids (ARCHITECTURE §6) and the effective keymap.

use crate::config::Config;
use std::{collections::HashMap, fmt};

/// A key combination. `key` is a canonical lowercase key name (`t`, `f5`, `pageup`, `plus`, …).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Accel {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub key: String,
}

/// Named (non-alphanumeric, non-F) keys accepted in accelerators.
pub const NAMED_KEYS: &[&str] = &[
    "tab",
    "pageup",
    "pagedown",
    "left",
    "right",
    "up",
    "down",
    "escape",
    "enter",
    "plus",
    "minus",
    "comma",
    "period",
    "delete",
    "backspace",
    "home",
    "end",
    "space",
    "insert",
    "slash",
    "backslash",
    "semicolon",
    "quote",
    "backquote",
    "bracketleft",
    "bracketright",
];

/// Canonical key name for an alias, or `None` if the key is unknown.
pub fn normalize_key(k: &str) -> Option<String> {
    let k = k.trim().to_lowercase();
    if k.is_empty() {
        return None;
    }
    let canon = match k.as_str() {
        "pgup" | "page_up" | "page-up" | "prior" => "pageup",
        "pgdn" | "pgdown" | "page_down" | "page-down" | "next" => "pagedown",
        "esc" => "escape",
        "return" | "ret" => "enter",
        "=" | "+" | "equal" | "equals" | "add" => "plus",
        "-" | "subtract" => "minus",
        "," => "comma",
        "." => "period",
        "del" => "delete",
        "ins" => "insert",
        "bksp" | "bs" => "backspace",
        "spc" | "spacebar" => "space",
        "arrowleft" | "arrow_left" | "←" => "left",
        "arrowright" | "arrow_right" | "→" => "right",
        "arrowup" | "arrow_up" | "↑" => "up",
        "arrowdown" | "arrow_down" | "↓" => "down",
        "/" => "slash",
        "\\" => "backslash",
        ";" => "semicolon",
        "'" => "quote",
        "`" | "grave" => "backquote",
        "[" => "bracketleft",
        "]" => "bracketright",
        other => other,
    };
    let valid = NAMED_KEYS.contains(&canon)
        || (canon.len() == 1 && canon.chars().all(|c| c.is_ascii_alphanumeric()))
        || canon
            .strip_prefix('f')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=24).contains(&n) && !canon[1..].starts_with('0'));
    valid.then(|| canon.to_string())
}

impl Accel {
    /// Shorthand constructor; `mods` like `"ctrl+shift"` (may be empty).
    fn of(mods: &str, key: &str) -> Accel {
        let mut a = Accel {
            key: key.into(),
            ..Default::default()
        };
        for m in mods.split('+') {
            match m {
                "ctrl" => a.ctrl = true,
                "shift" => a.shift = true,
                "alt" => a.alt = true,
                "meta" => a.meta = true,
                _ => {}
            }
        }
        a
    }

    /// Parses `ctrl+shift+t`-style accelerators, case-insensitive, with aliases
    /// (`control`, `cmd`/`super`, `pgup`, `esc`, `return`, `=`, `-`, …). `ctrl++` means Ctrl+Plus.
    pub fn parse(s: &str) -> Option<Accel> {
        let s = s.trim().to_lowercase();
        let (mods, key) = if s == "+" {
            ("", "+")
        } else if let Some(m) = s.strip_suffix("++") {
            (m, "+")
        } else {
            s.rsplit_once('+').unwrap_or(("", s.as_str()))
        };
        let mut a = Accel {
            key: normalize_key(key)?,
            ..Default::default()
        };
        for m in mods.split('+').map(str::trim) {
            match m {
                "" if mods.is_empty() => {}
                "ctrl" | "control" | "ctl" => a.ctrl = true,
                "shift" => a.shift = true,
                "alt" | "option" | "opt" => a.alt = true,
                "meta" | "cmd" | "command" | "super" | "win" | "logo" => a.meta = true,
                _ => return None,
            }
        }
        Some(a)
    }

    /// Human-readable form, e.g. `Ctrl+Shift+T`, `Ctrl+PgDn`, `Alt+←`.
    pub fn label(&self) -> String {
        let mut out = String::new();
        for (on, name) in [
            (self.ctrl, "Ctrl+"),
            (self.shift, "Shift+"),
            (self.alt, "Alt+"),
            (self.meta, "Super+"),
        ] {
            if on {
                out.push_str(name);
            }
        }
        let key = match self.key.as_str() {
            "pageup" => "PgUp",
            "pagedown" => "PgDn",
            "left" => "←",
            "right" => "→",
            "up" => "↑",
            "down" => "↓",
            "escape" => "Esc",
            "plus" => "+",
            "minus" => "-",
            "comma" => ",",
            "period" => ".",
            "delete" => "Del",
            "insert" => "Ins",
            "slash" => "/",
            "backslash" => "\\",
            "semicolon" => ";",
            "quote" => "'",
            "backquote" => "`",
            "bracketleft" => "[",
            "bracketright" => "]",
            k => {
                let mut c = k.chars();
                out.extend(c.next().into_iter().flat_map(char::to_uppercase).chain(c));
                return out;
            }
        };
        out.push_str(key);
        out
    }
}

/// Canonical config syntax: `ctrl+shift+alt+meta+key` (round-trips through [`Accel::parse`]).
impl fmt::Display for Accel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (on, name) in [
            (self.ctrl, "ctrl+"),
            (self.shift, "shift+"),
            (self.alt, "alt+"),
            (self.meta, "meta+"),
        ] {
            if on {
                f.write_str(name)?;
            }
        }
        f.write_str(&self.key)
    }
}

impl serde::Serialize for Accel {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> serde::Deserialize<'de> for Accel {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Accel::parse(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("invalid accelerator `{s}`")))
    }
}

/// Every action id with a short English label, in display order.
pub const ACTIONS: &[(&str, &str)] = &[
    ("new-tab", "New tab"),
    ("close-tab", "Close tab"),
    ("reopen-closed-tab", "Reopen closed tab"),
    ("next-tab", "Next tab"),
    ("prev-tab", "Previous tab"),
    ("select-tab-1", "Go to tab 1"),
    ("select-tab-2", "Go to tab 2"),
    ("select-tab-3", "Go to tab 3"),
    ("select-tab-4", "Go to tab 4"),
    ("select-tab-5", "Go to tab 5"),
    ("select-tab-6", "Go to tab 6"),
    ("select-tab-7", "Go to tab 7"),
    ("select-tab-8", "Go to tab 8"),
    ("select-last-tab", "Go to last tab"),
    ("move-tab-left", "Move tab left"),
    ("move-tab-right", "Move tab right"),
    ("pin-tab", "Pin / unpin tab"),
    ("mute-tab", "Mute / unmute tab"),
    ("duplicate-tab", "Duplicate tab"),
    ("search-tabs", "Search open tabs"),
    ("focus-urlbar", "Focus address bar"),
    ("open-palette", "Open palette"),
    ("command-palette", "Command palette"),
    ("reload", "Reload"),
    ("hard-reload", "Hard reload (bypass cache)"),
    ("stop", "Stop loading"),
    ("back", "Back"),
    ("forward", "Forward"),
    ("find", "Find in page"),
    ("find-next", "Find next"),
    ("find-prev", "Find previous"),
    ("zoom-in", "Zoom in"),
    ("zoom-out", "Zoom out"),
    ("zoom-reset", "Reset zoom"),
    ("fullscreen", "Toggle fullscreen"),
    ("toggle-compact", "Toggle compact mode"),
    ("split-vertical", "Split view vertically"),
    ("split-horizontal", "Split view horizontally"),
    ("unsplit", "Close split view"),
    ("copy-url", "Copy URL"),
    ("copy-url-markdown", "Copy URL as Markdown"),
    ("bookmark", "Bookmark page"),
    ("history", "History"),
    ("downloads", "Downloads"),
    ("settings", "Settings"),
    ("devtools", "Developer tools"),
    ("view-source", "View page source"),
    ("print", "Print"),
    ("reload-theme", "Reload theme and user.css"),
    ("new-window", "New window"),
    ("close-window", "Close window"),
    ("quit", "Quit Samo"),
    ("escape", "Close popup / cancel"),
];

/// Actions the core forwards to the chrome UI as a `command` event (all others run natively).
pub const UI_ACTIONS: &[&str] = &[
    "focus-urlbar",
    "open-palette",
    "command-palette",
    "search-tabs",
    "find",
    "find-next",
    "find-prev",
    "toggle-compact",
    "copy-url",
    "copy-url-markdown",
    "escape",
];

/// Label of an action id, if it is known.
pub fn action_label(action: &str) -> Option<&'static str> {
    ACTIONS.iter().find(|(a, _)| *a == action).map(|(_, l)| *l)
}

/// True if `action` is handled by the UI (see [`UI_ACTIONS`]).
pub fn is_ui_action(action: &str) -> bool {
    UI_ACTIONS.contains(&action)
}

/// Default bindings for every action in [`ACTIONS`] order (unbound actions have an empty list).
pub fn default_bindings() -> Vec<(String, Vec<Accel>)> {
    let defaults: &[(&str, &[(&str, &str)])] = &[
        ("new-tab", &[("ctrl", "t")]),
        ("close-tab", &[("ctrl", "w"), ("ctrl", "f4")]),
        ("reopen-closed-tab", &[("ctrl+shift", "t")]),
        ("next-tab", &[("ctrl", "tab"), ("ctrl", "pagedown")]),
        ("prev-tab", &[("ctrl+shift", "tab"), ("ctrl", "pageup")]),
        ("select-tab-1", &[("ctrl", "1")]),
        ("select-tab-2", &[("ctrl", "2")]),
        ("select-tab-3", &[("ctrl", "3")]),
        ("select-tab-4", &[("ctrl", "4")]),
        ("select-tab-5", &[("ctrl", "5")]),
        ("select-tab-6", &[("ctrl", "6")]),
        ("select-tab-7", &[("ctrl", "7")]),
        ("select-tab-8", &[("ctrl", "8")]),
        ("select-last-tab", &[("ctrl", "9")]),
        ("move-tab-left", &[("ctrl+shift", "pageup")]),
        ("move-tab-right", &[("ctrl+shift", "pagedown")]),
        ("focus-urlbar", &[("ctrl", "l"), ("alt", "d"), ("", "f6")]),
        ("command-palette", &[("ctrl", "k"), ("ctrl+shift", "p")]),
        ("search-tabs", &[("ctrl+shift", "a")]),
        ("reload", &[("ctrl", "r"), ("", "f5")]),
        ("hard-reload", &[("ctrl+shift", "r"), ("shift", "f5")]),
        ("back", &[("alt", "left")]),
        ("forward", &[("alt", "right")]),
        ("find", &[("ctrl", "f")]),
        ("find-next", &[("ctrl", "g"), ("", "f3")]),
        ("find-prev", &[("ctrl+shift", "g"), ("shift", "f3")]),
        ("zoom-in", &[("ctrl", "plus"), ("ctrl+shift", "plus")]),
        ("zoom-out", &[("ctrl", "minus")]),
        ("zoom-reset", &[("ctrl", "0")]),
        ("fullscreen", &[("", "f11")]),
        ("devtools", &[("", "f12"), ("ctrl+shift", "i")]),
        ("view-source", &[("ctrl", "u")]),
        ("print", &[("ctrl", "p")]),
        ("bookmark", &[("ctrl", "d")]),
        ("history", &[("ctrl", "h")]),
        ("downloads", &[("ctrl", "j")]),
        ("settings", &[("ctrl", "comma")]),
        ("copy-url", &[("ctrl+shift", "c")]),
        ("copy-url-markdown", &[("ctrl+alt+shift", "c")]),
        ("toggle-compact", &[("ctrl+alt", "c")]),
        ("pin-tab", &[("ctrl+shift", "d")]),
        ("mute-tab", &[("ctrl", "m")]),
        ("duplicate-tab", &[("ctrl+shift", "x")]),
        ("new-window", &[("ctrl", "n")]),
        ("close-window", &[("ctrl+shift", "w")]),
        ("reload-theme", &[("ctrl+alt", "r")]),
        ("quit", &[("ctrl", "q")]),
        ("split-vertical", &[("ctrl+alt", "v")]),
        ("split-horizontal", &[("ctrl+alt", "h")]),
        ("unsplit", &[("ctrl+alt", "u")]),
        ("escape", &[("", "escape")]),
    ];
    ACTIONS
        .iter()
        .map(|(action, _)| {
            let accels = defaults
                .iter()
                .find(|(a, _)| a == action)
                .map(|(_, list)| list.iter().map(|(m, k)| Accel::of(m, k)).collect())
                .unwrap_or_default();
            (action.to_string(), accels)
        })
        .collect()
}

/// Effective key bindings (defaults + `[keys]` overrides).
#[derive(Debug, Clone, Default)]
pub struct Keymap {
    entries: Vec<(String, Vec<Accel>)>,
    map: HashMap<Accel, usize>,
    warnings: Vec<String>,
}

/// Builds the keymap from defaults and `cfg.keys`. A user entry replaces all default accels of
/// that action; an accel claimed by a user entry is removed from other actions.
pub fn bindings(cfg: &Config) -> Keymap {
    let mut entries = default_bindings();
    let mut warnings = Vec::new();
    let mut overridden = Vec::new();
    for (action, kb) in &cfg.keys {
        let Some(idx) = entries.iter().position(|(a, _)| a == action) else {
            warnings.push(format!("[keys]: unknown action `{action}`"));
            continue;
        };
        let accels: Vec<Accel> = kb
            .accels()
            .into_iter()
            .filter_map(|s| {
                let a = Accel::parse(s);
                if a.is_none() {
                    warnings.push(format!("[keys] {action}: invalid accelerator `{s}`"));
                }
                a
            })
            .collect();
        entries[idx].1 = accels;
        overridden.push(idx);
    }
    let mut map = HashMap::new();
    for (i, (_, accels)) in entries
        .iter()
        .enumerate()
        .filter(|(i, _)| !overridden.contains(i))
    {
        for a in accels {
            map.entry(a.clone()).or_insert(i);
        }
    }
    for &i in &overridden {
        for a in &entries[i].1 {
            if let Some(prev) = map.insert(a.clone(), i)
                && prev != i
                && overridden.contains(&prev)
            {
                warnings.push(format!(
                    "[keys]: `{a}` is bound to both `{}` and `{}`",
                    entries[prev].0, entries[i].0
                ));
            }
        }
    }
    for (i, (_, accels)) in entries.iter_mut().enumerate() {
        accels.retain(|a| map.get(a) == Some(&i));
    }
    Keymap {
        entries,
        map,
        warnings,
    }
}

impl Keymap {
    /// The action bound to `a`, if any.
    pub fn lookup(&self, a: &Accel) -> Option<&str> {
        self.map.get(a).map(|&i| self.entries[i].0.as_str())
    }

    /// Every action with its accels and label, in [`ACTIONS`] order.
    pub fn list(&self) -> Vec<(String, Vec<Accel>, String)> {
        self.entries
            .iter()
            .map(|(a, accels)| {
                (
                    a.clone(),
                    accels.clone(),
                    action_label(a).unwrap_or(a).to_string(),
                )
            })
            .collect()
    }

    /// Accels bound to `action` (empty if none / unknown).
    pub fn accels(&self, action: &str) -> &[Accel] {
        self.entries
            .iter()
            .find(|(a, _)| a == action)
            .map(|(_, v)| v.as_slice())
            .unwrap_or(&[])
    }

    /// Problems found in `[keys]` (unknown actions, bad accels, conflicts) for a toast.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::KeyBinding;

    fn a(s: &str) -> Accel {
        Accel::parse(s).unwrap_or_else(|| panic!("parse {s}"))
    }

    #[test]
    fn parse_and_format() {
        assert_eq!(
            a("Ctrl+Shift+T"),
            Accel {
                ctrl: true,
                shift: true,
                key: "t".into(),
                ..Default::default()
            }
        );
        assert_eq!(a("control+pgup").to_string(), "ctrl+pageup");
        assert_eq!(a("CMD+esc").to_string(), "meta+escape");
        assert_eq!(a("super+Return").to_string(), "meta+enter");
        assert_eq!(a("ctrl+="), a("ctrl+plus"));
        assert_eq!(a("ctrl++"), a("ctrl+plus"));
        assert_eq!(a("ctrl+-").key, "minus");
        assert_eq!(a(" alt + left ").to_string(), "alt+left");
        assert_eq!(a("F12").to_string(), "f12");
        assert_eq!(
            a("shift+alt+ctrl+meta+x").to_string(),
            "ctrl+shift+alt+meta+x"
        );
        for bad in [
            "",
            "ctrl+",
            "ctrl+foo",
            "hyper+a",
            "f0",
            "f25",
            "ctrl+shift",
        ] {
            assert!(Accel::parse(bad).is_none(), "{bad}");
        }
        for (_, accels) in default_bindings() {
            for x in accels {
                assert_eq!(Accel::parse(&x.to_string()), Some(x));
            }
        }
        assert_eq!(a("ctrl+shift+pagedown").label(), "Ctrl+Shift+PgDn");
        assert_eq!(a("ctrl+t").label(), "Ctrl+T");
        assert_eq!(a("f5").label(), "F5");
        assert_eq!(serde_json::to_value(a("ctrl+t")).unwrap(), "ctrl+t");
    }

    #[test]
    fn defaults() {
        let km = bindings(&Config::default());
        assert!(km.warnings().is_empty());
        let cases = [
            ("ctrl+t", "new-tab"),
            ("ctrl+f4", "close-tab"),
            ("ctrl+9", "select-last-tab"),
            ("ctrl+shift+pageup", "move-tab-left"),
            ("f6", "focus-urlbar"),
            ("ctrl+shift+p", "command-palette"),
            ("ctrl+shift+plus", "zoom-in"),
            ("shift+f3", "find-prev"),
            ("ctrl+comma", "settings"),
            ("ctrl+alt+shift+c", "copy-url-markdown"),
            ("escape", "escape"),
        ];
        for (k, action) in cases {
            assert_eq!(km.lookup(&a(k)), Some(action), "{k}");
        }
        assert_eq!(km.lookup(&a("ctrl+shift+alt+z")), None);
        // No accel is bound twice in the defaults.
        let all: Vec<Accel> = default_bindings()
            .into_iter()
            .flat_map(|(_, v)| v)
            .collect();
        let uniq: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(all.len(), uniq.len());
        assert!(
            default_bindings()
                .iter()
                .all(|(a, _)| action_label(a).is_some())
        );
    }

    #[test]
    fn overrides() {
        let mut cfg = Config::default();
        cfg.keys
            .insert("reload".into(), KeyBinding::One("ctrl+t".into()));
        cfg.keys.insert(
            "toggle-compact".into(),
            KeyBinding::Many(vec!["ctrl+alt+x".into(), "f9".into()]),
        );
        cfg.keys
            .insert("quit".into(), KeyBinding::One(String::new()));
        cfg.keys
            .insert("bogus".into(), KeyBinding::One("ctrl+b".into()));
        cfg.keys
            .insert("print".into(), KeyBinding::One("ctrl+nope".into()));
        let km = bindings(&cfg);
        assert_eq!(km.lookup(&a("ctrl+t")), Some("reload"));
        assert_eq!(km.lookup(&a("ctrl+r")), None); // reload defaults replaced
        assert!(km.accels("new-tab").is_empty()); // its accel was taken
        assert_eq!(km.lookup(&a("f9")), Some("toggle-compact"));
        assert_eq!(km.lookup(&a("ctrl+alt+c")), None);
        assert_eq!(km.lookup(&a("ctrl+q")), None);
        assert_eq!(km.warnings().len(), 2);
        let list = km.list();
        let tc = list.iter().find(|(a, _, _)| a == "toggle-compact").unwrap();
        assert_eq!(tc.1.len(), 2);
        assert_eq!(tc.2, "Toggle compact mode");
    }
}
