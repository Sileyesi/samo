//! Session persistence (`data_dir/session.json`), written atomically.

use crate::paths;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// One restorable tab.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionTab {
    pub url: String,
    pub title: String,
    pub pinned: bool,
    pub muted: bool,
}

/// Tabs of the (main) window plus the index of the active tab.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Session {
    pub tabs: Vec<SessionTab>,
    pub active: usize,
}

/// Loads the session from [`paths::session_file`]; `None` if missing, unreadable or empty.
pub fn load() -> Option<Session> {
    load_from(&paths::session_file())
}

/// Saves the session to [`paths::session_file`] atomically.
pub fn save(s: &Session) -> anyhow::Result<()> {
    save_to(&paths::session_file(), s)
}

/// Loads a session from `path`; `None` if missing, invalid, or without tabs.
/// `active` is clamped into range.
pub fn load_from(path: &Path) -> Option<Session> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut s: Session = serde_json::from_str(&text).ok()?;
    if s.tabs.is_empty() {
        return None;
    }
    s.active = s.active.min(s.tabs.len() - 1);
    Some(s)
}

/// Saves a session to `path` atomically (tmp file + rename).
pub fn save_to(path: &Path, s: &Session) -> anyhow::Result<()> {
    let json = serde_json::to_vec_pretty(s)?;
    paths::write_atomic(path, &json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("session.json");
        assert!(load_from(&p).is_none());
        let s = Session {
            tabs: vec![
                SessionTab {
                    url: "https://a.com/".into(),
                    title: "A".into(),
                    pinned: true,
                    muted: false,
                },
                SessionTab {
                    url: "https://b.com/".into(),
                    ..Default::default()
                },
            ],
            active: 7,
        };
        save_to(&p, &s).unwrap();
        let back = load_from(&p).unwrap();
        assert_eq!(back.tabs, s.tabs);
        assert_eq!(back.active, 1); // clamped
        std::fs::write(&p, "{garbage").unwrap();
        assert!(load_from(&p).is_none());
        std::fs::write(&p, r#"{"tabs":[{"url":"x"}]}"#).unwrap();
        assert_eq!(load_from(&p).unwrap().tabs[0].url, "x");
    }
}
