//! Themes: built-in CSS files (embedded from `themes/*.css`, or read from disk during development)
//! plus user themes in [`paths::themes_dir`], which override built-ins with the same id.
//!
//! A theme may start with a header comment: `/* @name Samo Dark  @scheme dark */`.

use crate::paths;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/builtin_themes.rs"));
}

/// The theme used when the configured one does not exist.
pub const FALLBACK: &str = "samo-dark";

/// Theme metadata for `theme.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemeInfo {
    /// File stem.
    pub id: String,
    pub name: String,
    /// `dark` | `light`
    pub scheme: String,
    /// False for user themes (including ones overriding a built-in).
    pub builtin: bool,
}

/// Directory of built-in themes on disk, for live editing during development:
/// `$SAMO_THEMES_DIR`, else `<crate>/../../themes` if it exists.
pub fn builtin_dir() -> Option<PathBuf> {
    std::env::var_os("SAMO_THEMES_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| {
            Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../themes")).filter(|p| p.is_dir())
        })
}

/// Theme ids are plain file stems: `[A-Za-z0-9._-]`, not starting with a dot.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn read_dir_css(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "css"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_str()?.to_string();
            let css = std::fs::read_to_string(&p).ok()?;
            valid_id(&id).then_some((id, css))
        })
        .collect()
}

/// All built-in themes: embedded ones, overlaid by the on-disk dev dir if present.
fn builtins() -> BTreeMap<String, String> {
    let mut map: BTreeMap<String, String> = embedded::BUILTIN
        .iter()
        .map(|(id, css)| (id.to_string(), css.to_string()))
        .collect();
    if let Some(dir) = builtin_dir() {
        map.extend(read_dir_css(&dir));
    }
    map
}

fn builtin_css(id: &str) -> Option<String> {
    if let Some(dir) = builtin_dir()
        && let Ok(css) = std::fs::read_to_string(dir.join(format!("{id}.css")))
    {
        return Some(css);
    }
    embedded::BUILTIN
        .iter()
        .find(|(i, _)| *i == id)
        .map(|(_, css)| css.to_string())
}

/// Parses `@name` / `@scheme` from the leading comment. Defaults: name from id, scheme by id
/// (`light` if the id contains "light", else `dark`).
pub fn parse_header(id: &str, css: &str) -> (String, String) {
    let header = css
        .trim_start()
        .strip_prefix("/*")
        .and_then(|rest| rest.split_once("*/"))
        .map(|(h, _)| h)
        .unwrap_or("");
    let tag = |name: &str| -> Option<String> {
        let start = header.find(name)? + name.len();
        let rest = &header[start..];
        let end = rest.find(['@', '\n']).unwrap_or(rest.len());
        Some(rest[..end].trim().to_string()).filter(|s| !s.is_empty())
    };
    let name = tag("@name").unwrap_or_else(|| {
        id.split(['-', '_'])
            .map(|w| {
                let mut c = w.chars();
                c.next()
                    .map(|f| f.to_uppercase().chain(c).collect::<String>())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ")
    });
    let scheme = match tag("@scheme").as_deref().map(str::to_ascii_lowercase) {
        Some(s) if s.starts_with("light") => "light",
        Some(s) if s.starts_with("dark") => "dark",
        _ if id.contains("light") => "light",
        _ => "dark",
    };
    (name, scheme.to_string())
}

/// Built-in and user themes (user ones from [`paths::themes_dir`]), sorted by name.
pub fn list() -> Vec<ThemeInfo> {
    list_in(&paths::themes_dir())
}

/// [`list`] with an explicit user theme dir.
pub fn list_in(user_dir: &Path) -> Vec<ThemeInfo> {
    let mut all: BTreeMap<String, (String, bool)> = builtins()
        .into_iter()
        .map(|(id, css)| (id, (css, true)))
        .collect();
    all.extend(
        read_dir_css(user_dir)
            .into_iter()
            .map(|(id, css)| (id, (css, false))),
    );
    let mut out: Vec<ThemeInfo> = all
        .into_iter()
        .map(|(id, (css, builtin))| {
            let (name, scheme) = parse_header(&id, &css);
            ThemeInfo {
                id,
                name,
                scheme,
                builtin,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// CSS of theme `id` (user theme first, then built-in); unknown ids fall back to
/// [`FALLBACK`]; `None` if even that is missing.
pub fn css(id: &str) -> Option<String> {
    css_in(&paths::themes_dir(), id)
}

/// [`css`] with an explicit user theme dir.
pub fn css_in(user_dir: &Path, id: &str) -> Option<String> {
    let find = |id: &str| {
        if !valid_id(id) {
            return None;
        }
        std::fs::read_to_string(user_dir.join(format!("{id}.css")))
            .ok()
            .or_else(|| builtin_css(id))
    };
    find(id).or_else(|| find(FALLBACK))
}

/// Contents of [`paths::user_css`], or an empty string.
pub fn user_css() -> String {
    std::fs::read_to_string(paths::user_css()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header() {
        assert_eq!(
            parse_header("x", "/* @name Samo Dark  @scheme dark */\n:root{}"),
            ("Samo Dark".into(), "dark".into())
        );
        assert_eq!(
            parse_header("x", "\n/*\n * @name  Paper\n * @scheme Light\n */"),
            ("Paper".into(), "light".into())
        );
        assert_eq!(
            parse_header("my-light_theme", ":root{}"),
            ("My Light Theme".into(), "light".into())
        );
        assert_eq!(
            parse_header("a", "/* @name A */ /* @scheme light */").1,
            "dark"
        );
    }

    #[test]
    fn user_overrides_and_fallback() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join("mine.css"),
            "/* @name Mine @scheme light */ :root{--x:1}",
        )
        .unwrap();
        std::fs::write(
            d.path().join("samo-dark.css"),
            "/* @name Custom Dark */ :root{--y:1}",
        )
        .unwrap();
        std::fs::write(d.path().join("notes.txt"), "x").unwrap();
        let list = list_in(d.path());
        let mine = list.iter().find(|t| t.id == "mine").unwrap();
        assert_eq!(
            (mine.name.as_str(), mine.scheme.as_str(), mine.builtin),
            ("Mine", "light", false)
        );
        let vd = list.iter().find(|t| t.id == "samo-dark").unwrap();
        assert!(!vd.builtin && vd.name == "Custom Dark");
        assert_eq!(list.iter().filter(|t| t.id == "samo-dark").count(), 1);
        assert!(css_in(d.path(), "mine").unwrap().contains("--x"));
        assert!(css_in(d.path(), "nope").unwrap().contains("--y"));
        assert!(css_in(d.path(), "../etc/passwd").unwrap().contains("--y"));
        let empty = tempfile::tempdir().unwrap();
        // Built-in samo-dark exists (embedded or dev dir) once the themes agent has written it.
        if builtins().contains_key("samo-dark") {
            assert_eq!(css_in(empty.path(), "zzz"), builtin_css("samo-dark"));
            assert!(
                list_in(empty.path())
                    .iter()
                    .any(|t| t.id == "samo-dark" && t.builtin)
            );
        }
    }

    #[test]
    fn ids() {
        assert!(valid_id("samo-dark") && valid_id("a.b_c"));
        assert!(!valid_id("") && !valid_id("..") && !valid_id("a/b") && !valid_id(".hidden"));
    }
}
