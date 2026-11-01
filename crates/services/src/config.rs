//! `config.toml` schema (ARCHITECTURE §5), loading, comment-preserving saving and dotted-key edits.
//!
//! Every field has a serde default, so partial files (or an empty file) are valid. Enumerated
//! values are kept as strings (same spelling as in TOML/JSON) and checked by [`Config::validate`].

use crate::paths;
use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use toml_edit::{DocumentMut, Item, Table, TableLike};

/// `[general]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct General {
    /// `restore` | `newtab` | `homepage`
    pub startup: String,
    pub homepage: String,
    pub newtab_url: String,
    /// Key in `[search.engines]`.
    pub search_engine: String,
    /// May start with `~`; see [`Config::downloads_path`].
    pub downloads_dir: String,
}

impl Default for General {
    fn default() -> Self {
        Self {
            startup: "restore".into(),
            homepage: "samo://newtab/".into(),
            newtab_url: "samo://newtab/".into(),
            search_engine: "duckduckgo".into(),
            downloads_dir: "~/Downloads".into(),
        }
    }
}

/// `[search]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Search {
    /// Engine id -> URL template with `{q}` placeholder.
    pub engines: BTreeMap<String, String>,
}

impl Default for Search {
    fn default() -> Self {
        let engines = [
            ("duckduckgo", "https://duckduckgo.com/?q={q}"),
            ("google", "https://www.google.com/search?q={q}"),
            ("brave", "https://search.brave.com/search?q={q}"),
            ("bing", "https://www.bing.com/search?q={q}"),
            ("yandex", "https://yandex.ru/search/?text={q}"),
        ];
        Self {
            engines: engines
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        }
    }
}

/// `[ui]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Ui {
    /// Theme id (file stem).
    pub theme: String,
    /// `normal` | `compact`
    pub density: String,
    /// `page` | `theme` | `#rrggbb`
    pub accent: String,
    /// 0..1
    pub page_tint_strength: f64,
    pub reduce_motion: bool,
    /// Duration multiplier (0.5 = 2x faster).
    pub animation_speed: f64,
    /// `""` = system-ui.
    pub font_ui: String,
    /// px; "card" look when > 0.
    pub content_inset: u32,
    pub frameless: bool,
    /// `right` | `left` | `none`
    pub window_controls: String,
}

impl Default for Ui {
    fn default() -> Self {
        Self {
            theme: "samo-dark".into(),
            density: "normal".into(),
            accent: "page".into(),
            page_tint_strength: 0.6,
            reduce_motion: false,
            animation_speed: 1.0,
            font_ui: String::new(),
            content_inset: 0,
            frameless: true,
            window_controls: "right".into(),
        }
    }
}

/// `[tabs]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Tabs {
    pub max_width: u32,
    pub min_width: u32,
    /// `always` | `hover` | `active`
    pub close_button: String,
    /// `card` | `underline`
    pub indicator: String,
    pub hide_throbber: bool,
    /// `after-current` | `end`
    pub new_tab_position: String,
    pub close_window_with_last_tab: bool,
}

impl Default for Tabs {
    fn default() -> Self {
        Self {
            max_width: 240,
            min_width: 44,
            close_button: "hover".into(),
            indicator: "card".into(),
            hide_throbber: false,
            new_tab_position: "after-current".into(),
            close_window_with_last_tab: false,
        }
    }
}

/// `[compact]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Compact {
    pub enabled: bool,
    pub hide_delay_ms: u32,
}

impl Default for Compact {
    fn default() -> Self {
        Self {
            enabled: false,
            hide_delay_ms: 1000,
        }
    }
}

/// `[urlbar]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Urlbar {
    /// `palette` | `newtab`
    pub ctrl_t: String,
    pub show_full_url: bool,
    pub max_suggestions: usize,
}

impl Default for Urlbar {
    fn default() -> Self {
        Self {
            ctrl_t: "palette".into(),
            show_full_url: false,
            max_suggestions: 8,
        }
    }
}

/// `[engine]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Engine {
    /// `auto` | `wayland` | `x11`
    pub ozone_platform: String,
    pub smooth_scrolling: bool,
    pub gpu_rasterization: bool,
    /// `""` = CEF default.
    pub user_agent: String,
    /// Extra Chromium command-line switches.
    pub extra_flags: Vec<String>,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            ozone_platform: "auto".into(),
            smooth_scrolling: true,
            gpu_rasterization: true,
            user_agent: String::new(),
            extra_flags: Vec::new(),
        }
    }
}

/// A `[keys]` value: one accelerator or several.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KeyBinding {
    One(String),
    Many(Vec<String>),
}

impl KeyBinding {
    /// The accelerator strings (an empty string / list means "unbound").
    pub fn accels(&self) -> Vec<&str> {
        match self {
            Self::One(s) => vec![s.as_str()]
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .collect(),
            Self::Many(v) => v
                .iter()
                .map(String::as_str)
                .filter(|s| !s.trim().is_empty())
                .collect(),
        }
    }
}

/// Whole config file. `Default` = the built-in defaults.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub general: General,
    pub search: Search,
    pub ui: Ui,
    pub tabs: Tabs,
    pub compact: Compact,
    pub urlbar: Urlbar,
    pub engine: Engine,
    /// Action id -> accelerator(s); replaces that action's default bindings.
    pub keys: BTreeMap<String, KeyBinding>,
}

/// Commented default config written on first run. Must parse to `Config::default()`.
pub const DEFAULT_TOML: &str = r##"# Samo configuration.
# Changes are applied live when this file is saved. Missing keys fall back to defaults,
# so you can delete anything you don't care about. Docs: docs/ARCHITECTURE.md §5.

[general]
startup = "restore"            # restore | newtab | homepage
homepage = "samo://newtab/"
newtab_url = "samo://newtab/"
search_engine = "duckduckgo"   # key in [search.engines]
downloads_dir = "~/Downloads"

# Search engines: id = "URL with {q} placeholder". Add your own, e.g.
# kagi = "https://kagi.com/search?q={q}"
[search.engines]
bing = "https://www.bing.com/search?q={q}"
brave = "https://search.brave.com/search?q={q}"
duckduckgo = "https://duckduckgo.com/?q={q}"
google = "https://www.google.com/search?q={q}"
yandex = "https://yandex.ru/search/?text={q}"

[ui]
theme = "samo-dark"            # theme id = file stem in ~/.config/samo/themes or built-in
density = "normal"             # normal | compact
accent = "page"                # page | theme | "#rrggbb"
page_tint_strength = 0.6       # 0..1, how much the page color tints the chrome
reduce_motion = false
animation_speed = 1.0          # duration multiplier (0.5 = 2x faster)
font_ui = ""                   # "" = system-ui
content_inset = 0              # px, "card" look when > 0
frameless = true               # draw our own title bar
window_controls = "right"      # right | left | none

[tabs]
max_width = 240
min_width = 44
close_button = "hover"         # always | hover | active
indicator = "card"             # card | underline
hide_throbber = false
new_tab_position = "after-current"   # after-current | end
close_window_with_last_tab = false

[compact]
enabled = false                # chrome hides, appears on hover at the top edge
hide_delay_ms = 1000

[urlbar]
ctrl_t = "palette"             # palette | newtab
show_full_url = false
max_suggestions = 8

[engine]                       # changes here need a restart
ozone_platform = "auto"        # auto | wayland | x11
smooth_scrolling = true
gpu_rasterization = true
user_agent = ""                # "" = default
extra_flags = []               # e.g. ["--enable-features=VaapiVideoDecoder"]

# Key bindings: action = "accelerator" or ["accel", "accel"]; replaces the action's defaults.
# Syntax: ctrl+shift+alt+meta+<key>. "" or [] unbinds. Full list: command palette (">").
[keys]
# "toggle-compact" = "ctrl+alt+c"
# "new-tab" = ["ctrl+t", "ctrl+alt+n"]
"##;

/// Dotted paths of tables that are free-form maps (entries may be added/removed).
const MAP_TABLES: &[&str] = &["search.engines", "keys"];

impl Config {
    /// Loads [`paths::config_file`], writing the commented default file first if it doesn't exist.
    /// A parse error is returned (with file:line) so the caller can keep the last good config.
    pub fn load_or_create() -> anyhow::Result<Config> {
        Self::load_or_create_at(&paths::config_file())
    }

    /// [`Config::load_or_create`] for an explicit path.
    pub fn load_or_create_at(path: &Path) -> anyhow::Result<Config> {
        if !path.exists() {
            paths::write_atomic(path, DEFAULT_TOML.as_bytes())
                .with_context(|| format!("writing default config {}", path.display()))?;
            return Ok(Config::default());
        }
        Self::load_from(path)
    }

    /// Parses a config file; invalid enumerated values are reset to defaults (see [`Config::sanitize`]).
    pub fn load_from(path: &Path) -> anyhow::Result<Config> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut cfg = Self::parse(&text).with_context(|| format!("{}", path.display()))?;
        cfg.sanitize();
        Ok(cfg)
    }

    /// Parses TOML text (no sanitizing). Errors carry line/column.
    pub fn parse(text: &str) -> anyhow::Result<Config> {
        Ok(toml::from_str(text)?)
    }

    /// Saves to [`paths::config_file`], preserving comments and unknown keys of the existing file.
    pub fn save(&self) -> anyhow::Result<()> {
        self.save_to(&paths::config_file())
    }

    /// [`Config::save`] for an explicit path. Only values that differ from the file are touched;
    /// keys missing from a partial file are only added when they differ from the default.
    pub fn save_to(&self, path: &Path) -> anyhow::Result<()> {
        let existing = std::fs::read_to_string(path).ok();
        let mut doc: DocumentMut = existing
            .as_deref()
            .and_then(|t| t.parse().ok())
            .unwrap_or_else(|| DEFAULT_TOML.parse().unwrap_or_default());
        let src: DocumentMut = toml::to_string(self)?.parse()?;
        let def: DocumentMut = toml::to_string(&Config::default())?.parse()?;
        merge(doc.as_table_mut(), src.as_table(), Some(def.as_table()), "");
        let out = doc.to_string();
        if existing.as_deref() != Some(out.as_str()) {
            paths::write_atomic(path, out.as_bytes())
                .with_context(|| format!("writing {}", path.display()))?;
        }
        Ok(())
    }

    /// The config as JSON (same keys as TOML).
    pub fn to_json(&self) -> Json {
        serde_json::to_value(self).unwrap_or(Json::Null)
    }

    /// Defaults as JSON.
    pub fn default_json() -> Json {
        Config::default().to_json()
    }

    /// Sets a dotted key (e.g. `ui.density`, `keys.new-tab`, `search.engines.kagi`) and saves
    /// to [`paths::config_file`]. `null` removes a map entry / resets a field to its default.
    /// Type and value are validated; on error nothing changes.
    pub fn set_key(&mut self, dotted: &str, v: Json) -> anyhow::Result<()> {
        self.set_key_at(&paths::config_file(), dotted, v)
    }

    /// [`Config::set_key`] saving to an explicit path.
    pub fn set_key_at(&mut self, path: &Path, dotted: &str, v: Json) -> anyhow::Result<()> {
        let new = self.with_key(dotted, v)?;
        new.save_to(path)?;
        *self = new;
        Ok(())
    }

    /// Returns a copy with the dotted key set (validated), without saving.
    pub fn with_key(&self, dotted: &str, v: Json) -> anyhow::Result<Config> {
        let parts: Vec<&str> = dotted.split('.').collect();
        if parts.iter().any(|p| p.is_empty()) {
            bail!("invalid config key `{dotted}`");
        }
        let mut j = self.to_json();
        let (last, parents) = parts.split_last().context("empty key")?;
        let mut cur = &mut j;
        for p in parents {
            let Json::Object(obj) = cur else {
                bail!("unknown config key `{dotted}`")
            };
            cur = obj
                .entry(p.to_string())
                .or_insert_with(|| Json::Object(Default::default()));
        }
        let Json::Object(obj) = cur else {
            bail!("unknown config key `{dotted}`")
        };
        if v.is_null() {
            obj.remove(*last);
        } else {
            obj.insert(last.to_string(), v.clone());
        }
        let new: Config = serde_json::from_value(j)
            .map_err(|e| anyhow::anyhow!("invalid value for `{dotted}`: {e}"))?;
        if !v.is_null() {
            let pointer = format!(
                "/{}",
                parts
                    .iter()
                    .map(|p| p.replace('~', "~0").replace('/', "~1"))
                    .collect::<Vec<_>>()
                    .join("/")
            );
            let back = new
                .to_json()
                .pointer(&pointer)
                .cloned()
                .unwrap_or(Json::Null);
            if !json_eq(&back, &v) {
                bail!("unknown config key `{dotted}`");
            }
        }
        new.validate()?;
        Ok(new)
    }

    /// Checks enumerated values and ranges.
    pub fn validate(&self) -> anyhow::Result<()> {
        let mut c = self.clone();
        match c.sanitize().into_iter().next() {
            Some(w) => bail!(w),
            None => Ok(()),
        }
    }

    /// Resets invalid values to their defaults, returning a warning per fixed value.
    pub fn sanitize(&mut self) -> Vec<String> {
        let d = Config::default();
        let mut warnings = Vec::new();
        let choices: [(&str, &mut String, &str, &[&str]); 9] = [
            (
                "general.startup",
                &mut self.general.startup,
                &d.general.startup,
                &["restore", "newtab", "homepage"],
            ),
            (
                "ui.density",
                &mut self.ui.density,
                &d.ui.density,
                &["normal", "compact"],
            ),
            (
                "ui.window_controls",
                &mut self.ui.window_controls,
                &d.ui.window_controls,
                &["right", "left", "none"],
            ),
            (
                "tabs.close_button",
                &mut self.tabs.close_button,
                &d.tabs.close_button,
                &["always", "hover", "active"],
            ),
            (
                "tabs.indicator",
                &mut self.tabs.indicator,
                &d.tabs.indicator,
                &["card", "underline"],
            ),
            (
                "tabs.new_tab_position",
                &mut self.tabs.new_tab_position,
                &d.tabs.new_tab_position,
                &["after-current", "end"],
            ),
            (
                "urlbar.ctrl_t",
                &mut self.urlbar.ctrl_t,
                &d.urlbar.ctrl_t,
                &["palette", "newtab"],
            ),
            (
                "engine.ozone_platform",
                &mut self.engine.ozone_platform,
                &d.engine.ozone_platform,
                &["auto", "wayland", "x11"],
            ),
            (
                "ui.accent",
                &mut self.ui.accent,
                &d.ui.accent,
                &["page", "theme"],
            ),
        ];
        for (key, val, def, allowed) in choices {
            let ok = allowed.contains(&val.as_str()) || (key == "ui.accent" && is_hex_color(val));
            if !ok {
                let extra = if key == "ui.accent" { " | #rrggbb" } else { "" };
                warnings.push(format!(
                    "`{key}` = {val:?} is not one of {}{extra}",
                    allowed.join(" | ")
                ));
                *val = def.to_string();
            }
        }
        let ui = &mut self.ui;
        if !(0.0..=1.0).contains(&ui.page_tint_strength) {
            warnings.push(format!(
                "`ui.page_tint_strength` = {} must be within 0..1",
                ui.page_tint_strength
            ));
            ui.page_tint_strength = ui.page_tint_strength.clamp(0.0, 1.0);
            if ui.page_tint_strength.is_nan() {
                ui.page_tint_strength = d.ui.page_tint_strength;
            }
        }
        if !(ui.animation_speed > 0.0 && ui.animation_speed <= 10.0) {
            warnings.push(format!(
                "`ui.animation_speed` = {} must be within (0, 10]",
                ui.animation_speed
            ));
            ui.animation_speed = d.ui.animation_speed;
        }
        if !self
            .search
            .engines
            .contains_key(&self.general.search_engine)
        {
            warnings.push(format!(
                "`general.search_engine` = {:?} is not in [search.engines]",
                self.general.search_engine
            ));
            self.general.search_engine = d.general.search_engine.clone();
            self.search
                .engines
                .entry(d.general.search_engine.clone())
                .or_insert_with(|| d.search.engines[&d.general.search_engine].clone());
        }
        warnings
    }

    /// The search URL for `query` using the configured engine (falls back to DuckDuckGo).
    pub fn search_url(&self, query: &str) -> String {
        let tpl = self
            .search
            .engines
            .get(&self.general.search_engine)
            .map(String::as_str)
            .unwrap_or("https://duckduckgo.com/?q={q}");
        let q = encode_query(query.trim());
        if tpl.contains("{q}") {
            tpl.replace("{q}", &q)
        } else {
            format!("{tpl}{q}")
        }
    }

    /// Human name of the configured search engine (e.g. "DuckDuckGo").
    pub fn search_engine_name(&self) -> String {
        engine_display_name(&self.general.search_engine)
    }

    /// `general.downloads_dir` with `~` expanded.
    pub fn downloads_path(&self) -> PathBuf {
        paths::expand_tilde(&self.general.downloads_dir)
    }
}

/// Pretty name for well-known engine ids; otherwise the id capitalized.
pub fn engine_display_name(id: &str) -> String {
    match id {
        "duckduckgo" => "DuckDuckGo".into(),
        "google" => "Google".into(),
        "brave" => "Brave".into(),
        "bing" => "Bing".into(),
        "yandex" => "Yandex".into(),
        "kagi" => "Kagi".into(),
        "startpage" => "Startpage".into(),
        _ => {
            let mut c = id.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        }
    }
}

/// Percent-encodes a query component (everything except RFC 3986 unreserved characters).
pub fn encode_query(s: &str) -> String {
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    const SET: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    utf8_percent_encode(s, SET).to_string()
}

fn is_hex_color(s: &str) -> bool {
    s.strip_prefix('#').is_some_and(|h| {
        matches!(h.len(), 3 | 4 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit())
    })
}

/// JSON equality treating numbers numerically (1 == 1.0).
fn json_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| json_eq(a, b))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

/// Semantic value of a TOML item (ignores formatting and comments).
fn sem(item: &Item) -> Option<toml::Value> {
    match item {
        Item::Value(v) => {
            let mut v = v.clone();
            v.decor_mut().clear();
            toml::from_str::<toml::Table>(&format!("x = {v}"))
                .ok()?
                .remove("x")
        }
        Item::Table(t) => {
            // Render inside a document so nested sub-tables get their headers.
            let mut doc = DocumentMut::new();
            doc.insert("x", Item::Table(t.clone()));
            toml::from_str::<toml::Table>(&doc.to_string())
                .ok()?
                .remove("x")
        }
        _ => None,
    }
}

/// Decor of `old` for a replacement value, keeping a trailing `# comment` in the same column.
fn realign(old: &toml_edit::Value, new: &toml_edit::Value) -> toml_edit::Decor {
    let mut decor = old.decor().clone();
    let bare_len = |v: &toml_edit::Value| {
        let mut v = v.clone();
        v.decor_mut().clear();
        v.to_string().chars().count()
    };
    let suffix = decor.suffix().and_then(|s| s.as_str()).map(str::to_owned);
    if let Some(suffix) = suffix {
        let trimmed = suffix.trim_start_matches(' ');
        if trimmed.starts_with('#') && !trimmed.contains('\n') {
            let spaces = (suffix.len() - trimmed.len() + bare_len(old))
                .saturating_sub(bare_len(new))
                .max(1);
            decor.set_suffix(format!("{}{trimmed}", " ".repeat(spaces)));
        }
    }
    decor
}

fn join(path: &str, k: &str) -> String {
    if path.is_empty() {
        k.to_string()
    } else {
        format!("{path}.{k}")
    }
}

/// Merges `src` (serialized config) into `dst` (user's document) in place.
/// `def` is the defaults table at the same path, used to avoid writing default values
/// into partial files; `None` inside free-form maps.
fn merge(dst: &mut dyn TableLike, src: &dyn TableLike, def: Option<&dyn TableLike>, path: &str) {
    let is_map = MAP_TABLES.contains(&path);
    let def = if is_map { None } else { def };
    for (k, s) in src.iter() {
        let sub = join(path, k);
        let d = def.and_then(|t| t.get(k));
        if let Some(st) = s.as_table_like() {
            let d_t = d.and_then(Item::as_table_like);
            if let Some(dt) = dst.get_mut(k).and_then(Item::as_table_like_mut) {
                merge(dt, st, d_t, &sub);
                continue;
            }
            if dst.get(k).is_none() && d.is_some_and(|d| sem(d).is_some() && sem(d) == sem(s)) {
                continue; // whole table is default and absent from the file
            }
            let mut t = Table::new();
            t.set_implicit(true);
            merge(&mut t, st, d_t, &sub);
            if !t.is_empty() || MAP_TABLES.contains(&sub.as_str()) {
                dst.insert(k, Item::Table(t));
            }
            continue;
        }
        let Some(sv) = s.as_value() else { continue };
        match dst.get_mut(k) {
            Some(existing) if existing.is_value() => {
                if sem(existing) != sem(s) {
                    let mut nv = sv.clone();
                    if let Some(old) = existing.as_value() {
                        *nv.decor_mut() = realign(old, sv);
                    }
                    *existing = Item::Value(nv);
                }
            }
            None if d.is_some_and(|d| sem(d) == sem(s)) => {}
            _ => {
                let mut nv = sv.clone();
                nv.decor_mut().clear();
                dst.insert(k, Item::Value(nv));
            }
        }
    }
    let stale: Vec<String> = dst
        .iter()
        .map(|(k, _)| k.to_string())
        .filter(|k| src.get(k).is_none())
        .collect();
    for k in stale {
        if is_map {
            dst.remove(&k);
        } else if MAP_TABLES.contains(&join(path, &k).as_str()) {
            // An emptied map is omitted by the serializer: clear it but keep its comments.
            if let Some(t) = dst.get_mut(&k).and_then(Item::as_table_like_mut) {
                t.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn template_parses_to_defaults() {
        assert_eq!(Config::parse(DEFAULT_TOML).unwrap(), Config::default());
        assert_eq!(Config::parse("").unwrap(), Config::default());
        assert!(Config::default().validate().is_ok());
    }

    #[test]
    fn partial_file() {
        let c = Config::parse("[ui]\ndensity = \"compact\"\n[keys]\nreload = \"f5\"\nback = [\"alt+left\", \"backspace\"]").unwrap();
        assert_eq!(c.ui.density, "compact");
        assert_eq!(c.ui.theme, "samo-dark");
        assert_eq!(c.tabs, Tabs::default());
        assert_eq!(c.keys["reload"].accels(), ["f5"]);
        assert_eq!(c.keys["back"].accels(), ["alt+left", "backspace"]);
    }

    #[test]
    fn load_or_create_writes_template() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("samo/config.toml");
        assert_eq!(Config::load_or_create_at(&p).unwrap(), Config::default());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), DEFAULT_TOML);
        assert_eq!(Config::load_or_create_at(&p).unwrap(), Config::default());
        // Saving defaults over the template is a no-op.
        Config::default().save_to(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), DEFAULT_TOML);
    }

    #[test]
    fn parse_error_has_location() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.toml");
        std::fs::write(&p, "[ui]\ndensity = \n").unwrap();
        let e = format!("{:#}", Config::load_or_create_at(&p).unwrap_err());
        assert!(e.contains("config.toml") && e.contains("line 2"), "{e}");
    }

    #[test]
    fn set_key_preserves_comments() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.toml");
        let mut c = Config::load_or_create_at(&p).unwrap();
        c.set_key_at(&p, "ui.density", json!("compact")).unwrap();
        c.set_key_at(&p, "ui.page_tint_strength", json!(0.25))
            .unwrap();
        c.set_key_at(&p, "tabs.max_width", json!(200)).unwrap();
        c.set_key_at(&p, "keys.toggle-compact", json!("ctrl+alt+x"))
            .unwrap();
        c.set_key_at(
            &p,
            "search.engines.kagi",
            json!("https://kagi.com/search?q={q}"),
        )
        .unwrap();
        c.set_key_at(&p, "engine.extra_flags", json!(["--foo"]))
            .unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(
            text.contains("density = \"compact\"            # normal | compact"),
            "{text}"
        );
        assert!(
            text.contains("page_tint_strength = 0.25      # 0..1"),
            "{text}"
        );
        assert!(text.contains("# Samo configuration."));
        assert!(text.contains("toggle-compact = \"ctrl+alt+x\""), "{text}");
        let back = Config::load_from(&p).unwrap();
        assert_eq!(back, c);
        assert_eq!(back.ui.page_tint_strength, 0.25);
        assert_eq!(back.engine.extra_flags, ["--foo"]);
        // Remove the map entries again.
        c.set_key_at(&p, "keys.toggle-compact", Json::Null).unwrap();
        c.set_key_at(&p, "search.engines.kagi", Json::Null).unwrap();
        let back = Config::load_from(&p).unwrap();
        assert!(back.keys.is_empty());
        assert!(!back.search.engines.contains_key("kagi"));
        assert!(
            std::fs::read_to_string(&p)
                .unwrap()
                .contains("# \"toggle-compact\" = \"ctrl+alt+c\"")
        );
    }

    #[test]
    fn set_key_validates() {
        let mut c = Config::default();
        assert!(c.with_key("ui.density", json!(3)).is_err());
        assert!(c.with_key("ui.density", json!("huge")).is_err());
        assert!(c.with_key("ui.nope", json!(1)).is_err());
        assert!(c.with_key("nope.x", json!(1)).is_err());
        assert!(c.with_key("ui", json!(1)).is_err());
        assert!(c.with_key("tabs.max_width", json!(-1)).is_err());
        assert!(c.with_key("ui.page_tint_strength", json!(3.0)).is_err());
        assert!(c.with_key("general.search_engine", json!("nope")).is_err());
        assert!(c.with_key("ui.accent", json!("#1e66f5")).is_ok());
        assert_eq!(
            c.with_key("ui.animation_speed", json!(2))
                .unwrap()
                .ui
                .animation_speed,
            2.0
        );
        assert_eq!(
            c.with_key("keys.reload", json!(["f5", "ctrl+r"]))
                .unwrap()
                .keys["reload"]
                .accels()
                .len(),
            2
        );
        // Resetting a field via null.
        c.ui.density = "compact".into();
        assert_eq!(
            c.with_key("ui.density", Json::Null).unwrap().ui.density,
            "normal"
        );
    }

    #[test]
    fn partial_file_stays_partial() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.toml");
        std::fs::write(&p, "# mine\n[ui]\ntheme = \"nord\" # fav\nfuture_key = 1\n").unwrap();
        let mut c = Config::load_from(&p).unwrap();
        c.set_key_at(&p, "tabs.max_width", json!(300)).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(
            text.starts_with("# mine\n[ui]\ntheme = \"nord\" # fav\nfuture_key = 1\n"),
            "{text}"
        );
        assert!(text.contains("[tabs]\nmax_width = 300\n"), "{text}");
        assert!(!text.contains("min_width"), "{text}");
        assert!(
            !text.contains("engines") && !text.contains("[keys]") && !text.contains("[engine]"),
            "{text}"
        );
        assert_eq!(Config::load_from(&p).unwrap().tabs.max_width, 300);
        // Adding a map entry to a partial file writes the whole map (serde replaces maps wholesale).
        c.set_key_at(
            &p,
            "search.engines.kagi",
            json!("https://kagi.com/search?q={q}"),
        )
        .unwrap();
        let back = Config::load_from(&p).unwrap();
        assert_eq!(back.search.engines.len(), 6);
        assert_eq!(back, c);
    }

    #[test]
    fn sanitize_resets_invalid() {
        let mut c = Config::parse(
            "[ui]\ndensity = \"x\"\nanimation_speed = 0\n[general]\nsearch_engine = \"zz\"",
        )
        .unwrap();
        assert_eq!(c.sanitize().len(), 3);
        assert_eq!(c.ui.density, "normal");
        assert_eq!(c.ui.animation_speed, 1.0);
        assert_eq!(c.general.search_engine, "duckduckgo");
    }

    #[test]
    fn search_url_and_json() {
        let mut c = Config::default();
        assert_eq!(
            c.search_url("rust lang & co"),
            "https://duckduckgo.com/?q=rust%20lang%20%26%20co"
        );
        c.general.search_engine = "yandex".into();
        assert_eq!(
            c.search_url("привет"),
            "https://yandex.ru/search/?text=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82"
        );
        assert_eq!(Config::default_json()["ui"]["theme"], "samo-dark");
        assert_eq!(c.search_engine_name(), "Yandex");
        let back: Config = serde_json::from_value(c.to_json()).unwrap();
        assert_eq!(back, c);
    }
}
