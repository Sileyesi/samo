//! Address bar logic: URL fixup (URL vs search) and suggestions (tabs, history, bookmarks,
//! search, commands).

use crate::{
    config::Config,
    keys,
    store::{Store, host_of, match_boost},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr},
};

/// Kind of a suggestion (`type` in JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionKind {
    Tab,
    History,
    Bookmark,
    Search,
    Url,
    Command,
}

/// One suggestion row (ARCHITECTURE §4.2).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[serde(rename = "type")]
    pub kind: SuggestionKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u32>,
    /// Action id for `command` items.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// Human accelerator label for `command` items (e.g. `Ctrl+T`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accel: Option<String>,
    pub score: f64,
}

impl Suggestion {
    fn new(
        kind: SuggestionKind,
        title: impl Into<String>,
        url: Option<String>,
        score: f64,
    ) -> Self {
        Self {
            kind,
            title: title.into(),
            url,
            tab_id: None,
            action: None,
            accel: None,
            score,
        }
    }
}

/// An open tab, as passed in by the core.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OpenTab {
    pub id: u32,
    pub url: String,
    pub title: String,
}

/// Schemes passed through unchanged.
pub const SCHEMES: &[&str] = &[
    "http",
    "https",
    "file",
    "samo",
    "about",
    "chrome",
    "data",
    "view-source",
    "ftp",
    "mailto",
    "devtools",
    "blob",
];

/// Turns address-bar input into a URL: explicit schemes pass through, host-like input gets
/// `https://` (`http://` for localhost and IPs), absolute paths become `file://`, anything else
/// is searched with the configured engine. A leading `?` forces a search.
pub fn fixup(input: &str, cfg: &Config) -> String {
    let s = input.trim();
    if s.is_empty() {
        return cfg.general.newtab_url.clone();
    }
    if let Some(q) = s.strip_prefix('?') {
        return cfg.search_url(q);
    }
    as_url(s).unwrap_or_else(|| cfg.search_url(s))
}

/// The URL `input` stands for, or `None` if it should be searched.
pub fn as_url(input: &str) -> Option<String> {
    let s = input.trim();
    if s.is_empty() || s.starts_with('?') {
        return None;
    }
    if let Some((scheme, rest)) = s.split_once(':')
        && SCHEMES.contains(&scheme.to_ascii_lowercase().as_str())
        && !rest.is_empty()
        && !s.contains(char::is_whitespace)
    {
        return Some(s.to_string());
    }
    if s.contains(char::is_whitespace) {
        return None;
    }
    if s.starts_with('/') || s.starts_with("~/") {
        let path = crate::paths::expand_tilde(s);
        return Some(format!("file://{}", path.display()));
    }
    let split = s.find(['/', '?', '#']).unwrap_or(s.len());
    let (authority, rest) = s.split_at(split);
    let scheme = host_kind(authority)?;
    Some(format!(
        "{scheme}://{authority}{}",
        if rest.is_empty() { "/" } else { rest }
    ))
}

/// `Some("http")` for localhost / IPs, `Some("https")` for domain names, `None` otherwise.
fn host_kind(authority: &str) -> Option<&'static str> {
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    if let Some(inner) = authority.strip_prefix('[') {
        let (addr, after) = inner.split_once(']')?;
        addr.parse::<Ipv6Addr>().ok()?;
        return (after.is_empty() || valid_port(after.strip_prefix(':')?)).then_some("http");
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if port.is_some_and(|p| !valid_port(p)) {
        return None;
    }
    let host = host.to_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Some("http");
    }
    if host.parse::<Ipv4Addr>().is_ok() {
        return Some("http");
    }
    let host = host.strip_suffix('.').unwrap_or(&host);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return None;
    }
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    };
    let tld = labels[labels.len() - 1];
    let tld_ok = (tld.chars().count() >= 2 && tld.chars().all(char::is_alphabetic))
        || tld.starts_with("xn--");
    (labels.iter().all(label_ok) && tld_ok).then_some("https")
}

fn valid_port(p: &str) -> bool {
    !p.is_empty() && p.len() <= 5 && p.parse::<u16>().is_ok()
}

/// Key used to dedupe suggestions by URL (ignores a trailing slash and `www.`).
fn url_key(url: &str) -> String {
    let u = url.trim_end_matches('/').to_lowercase();
    u.replacen("://www.", "://", 1)
}

fn display_title(title: &str, url: &str) -> String {
    if title.trim().is_empty() {
        url.to_string()
    } else {
        title.to_string()
    }
}

/// Builds suggestions for address-bar input `q`. A leading `>` lists commands instead.
/// Results are deduped by URL, sorted by score (desc), truncated to `limit`, and (in URL mode)
/// always contain a `search` item.
pub fn suggest(
    q: &str,
    tabs: &[OpenTab],
    store: &Store,
    cfg: &Config,
    limit: usize,
) -> Vec<Suggestion> {
    let q = q.trim();
    if let Some(cmd) = q.strip_prefix('>') {
        return commands(cmd.trim(), cfg, limit);
    }
    if q.is_empty() || limit == 0 {
        return Vec::new();
    }
    let (forced_search, query) = match q.strip_prefix('?') {
        Some(rest) => (true, rest.trim()),
        None => (false, q),
    };
    let toks: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let single = toks.len() == 1;
    let host_prefix = |url: &str| single && host_of(url).starts_with(toks[0].as_str());
    let mut items = Vec::new();

    let url = if forced_search { None } else { as_url(query) };
    let search_title = format!(
        "Search {} for \u{201c}{query}\u{201d}",
        cfg.search_engine_name()
    );
    let search_score = if url.is_some() { 100.0 } else { 900.0 };
    items.push(Suggestion::new(
        SuggestionKind::Search,
        search_title,
        Some(cfg.search_url(query)),
        search_score,
    ));
    if let Some(u) = url {
        items.push(Suggestion::new(
            SuggestionKind::Url,
            u.clone(),
            Some(u),
            1200.0,
        ));
    }
    if forced_search || toks.is_empty() {
        return items;
    }

    let matches_all = |url: &str, title: &str| {
        let hay = format!("{} {}", url.to_lowercase(), title.to_lowercase());
        toks.iter().all(|t| hay.contains(t.as_str()))
    };
    for t in tabs.iter().filter(|t| matches_all(&t.url, &t.title)) {
        let boost = match_boost(&toks, &t.url, &t.title).min(10.0);
        let base = if host_prefix(&t.url) { 1150.0 } else { 850.0 };
        let mut s = Suggestion::new(
            SuggestionKind::Tab,
            display_title(&t.title, &t.url),
            Some(t.url.clone()),
            base + boost * 4.0,
        );
        s.tab_id = Some(t.id);
        items.push(s);
    }

    // Only the single best host-prefix match (history or bookmark) outranks the search item,
    // like Chrome's inline autocomplete.
    let mut promoted = false;
    let history = store.frecency_search(query, limit.max(8) * 2);
    let max = history
        .iter()
        .map(|e| e.score)
        .fold(f64::MIN_POSITIVE, f64::max);
    for e in history {
        let rel = e.score / max;
        let score = if !promoted && host_prefix(&e.url) && toks[0].len() >= 2 {
            promoted = true;
            1100.0 + rel * 40.0
        } else {
            600.0 + rel * 190.0
        };
        items.push(Suggestion::new(
            SuggestionKind::History,
            display_title(&e.title, &e.url),
            Some(e.url),
            score,
        ));
    }
    for b in store.search_bookmarks(query, limit.max(8)) {
        let boost = match_boost(&toks, &b.url, &b.title).min(10.0);
        let score = if host_prefix(&b.url) { 780.0 } else { 700.0 } + boost * 2.0;
        items.push(Suggestion::new(
            SuggestionKind::Bookmark,
            display_title(&b.title, &b.url),
            Some(b.url),
            score,
        ));
    }
    finish(items, limit)
}

fn kind_rank(k: SuggestionKind) -> u8 {
    match k {
        SuggestionKind::Tab => 0,
        SuggestionKind::Url => 1,
        SuggestionKind::Bookmark => 2,
        SuggestionKind::History => 3,
        SuggestionKind::Search => 4,
        SuggestionKind::Command => 5,
    }
}

/// Dedupe by URL (keep best score; bookmark/history merge keeps the higher), sort, limit,
/// and make sure the search item survives truncation.
fn finish(items: Vec<Suggestion>, limit: usize) -> Vec<Suggestion> {
    let mut best: HashMap<String, Suggestion> = HashMap::new();
    let mut search = None;
    for it in items {
        if it.kind == SuggestionKind::Search {
            search = Some(it);
            continue;
        }
        let key = url_key(it.url.as_deref().unwrap_or(&it.title));
        match best.get(&key) {
            Some(old)
                if (old.score, std::cmp::Reverse(kind_rank(old.kind)))
                    >= (it.score, std::cmp::Reverse(kind_rank(it.kind))) => {}
            _ => {
                best.insert(key, it);
            }
        }
    }
    let mut out: Vec<Suggestion> = best.into_values().chain(search.clone()).collect();
    out.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(kind_rank(a.kind).cmp(&kind_rank(b.kind)))
            .then(a.title.cmp(&b.title))
    });
    out.truncate(limit);
    if let Some(s) = search
        && !out.iter().any(|i| i.kind == SuggestionKind::Search)
        && let Some(last) = out.last_mut()
    {
        *last = s;
    }
    out
}

/// Actions not offered in the command palette.
const HIDDEN_COMMANDS: &[&str] = &["escape", "open-palette", "command-palette"];

/// Fuzzy score of `q` against `label`/`id` (higher is better), `None` if no match.
pub fn fuzzy_score(q: &str, label: &str, id: &str) -> Option<f64> {
    if q.is_empty() {
        return Some(0.0);
    }
    let q = q.to_lowercase();
    let label = label.to_lowercase();
    let id = id.to_lowercase();
    let word_start = |hay: &str| {
        hay.match_indices(q.as_str()).any(|(i, _)| {
            i == 0
                || !hay[..i]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_alphanumeric)
        })
    };
    if label.starts_with(&q) || id.starts_with(&q) {
        return Some(300.0);
    }
    if word_start(&label) || word_start(&id) {
        return Some(200.0);
    }
    if label.contains(&q) || id.contains(&q) {
        return Some(150.0);
    }
    // Subsequence match; penalize gaps, reward matches at word starts.
    [label.as_str(), id.as_str()]
        .iter()
        .filter_map(|hay| {
            let chars: Vec<char> = hay.chars().collect();
            let mut pos = 0;
            let mut score = 100.0;
            for qc in q.chars().filter(|c| !c.is_whitespace()) {
                let found = chars[pos..].iter().position(|&c| c == qc)?;
                let i = pos + found;
                score -= found as f64 * 2.0;
                if i == 0 || !chars[i - 1].is_alphanumeric() {
                    score += 5.0;
                }
                pos = i + 1;
            }
            Some(score.max(1.0))
        })
        .reduce(f64::max)
}

/// Command-palette items for query `q` (without the leading `>`).
pub fn commands(q: &str, cfg: &Config, limit: usize) -> Vec<Suggestion> {
    let km = keys::bindings(cfg);
    let list = km.list();
    let n = list.len() as f64;
    let mut out: Vec<Suggestion> = list
        .into_iter()
        .enumerate()
        .filter(|(_, (a, _, _))| !HIDDEN_COMMANDS.contains(&a.as_str()))
        .filter_map(|(i, (action, accels, label))| {
            // Keep the catalogue order as a tie-breaker.
            let score = fuzzy_score(q, &label, &action)? + (n - i as f64) / n;
            let mut s = Suggestion::new(SuggestionKind::Command, label, None, score);
            s.accel = accels.first().map(keys::Accel::label);
            s.action = Some(action);
            Some(s)
        })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::now_ms;

    fn fx(s: &str) -> String {
        fixup(s, &Config::default())
    }

    #[test]
    fn fixup_cases() {
        let ddg = |q: &str| format!("https://duckduckgo.com/?q={q}");
        let cases = [
            ("https://example.com", "https://example.com"),
            ("HTTP://Example.com/x", "HTTP://Example.com/x"),
            ("samo://settings/", "samo://settings/"),
            ("about:blank", "about:blank"),
            ("view-source:https://a.com", "view-source:https://a.com"),
            ("data:text/html,<b>hi</b>", "data:text/html,<b>hi</b>"),
            ("file:///etc/hosts", "file:///etc/hosts"),
            ("example.com", "https://example.com/"),
            (
                "  example.com/path?q=1#x ",
                "https://example.com/path?q=1#x",
            ),
            (
                "sub.example.co.uk:8443/a",
                "https://sub.example.co.uk:8443/a",
            ),
            ("пример.рф", "https://пример.рф/"),
            ("localhost", "http://localhost/"),
            ("localhost:3000/api", "http://localhost:3000/api"),
            ("app.localhost:8080", "http://app.localhost:8080/"),
            ("127.0.0.1:8080", "http://127.0.0.1:8080/"),
            ("192.168.1.1", "http://192.168.1.1/"),
            ("[::1]:8080/x", "http://[::1]:8080/x"),
            ("/etc/hosts", "file:///etc/hosts"),
        ];
        for (input, want) in cases {
            assert_eq!(fx(input), want, "{input}");
        }
        let searches = [
            ("rust lang", "rust%20lang"),
            ("hello", "hello"),
            ("1.5", "1.5"),
            ("e.g", "e.g"),
            ("re:zero", "re%3Azero"),
            ("what is example.com", "what%20is%20example.com"),
            ("a@b.com", "a%40b.com"),
            ("localhost:abc", "localhost%3Aabc"),
            ("? example.com", "example.com"),
            ("c++", "c%2B%2B"),
            ("-foo.com", "-foo.com"),
        ];
        for (input, q) in searches {
            assert_eq!(fx(input), ddg(q), "{input}");
        }
        assert_eq!(fx("   "), "samo://newtab/");
    }

    fn store() -> Store {
        let s = Store::open_in_memory().unwrap();
        let now = now_ms();
        for i in 0..6 {
            s.record_visit_at("https://github.com/", "GitHub", now - i * 60_000, false)
                .unwrap();
        }
        s.record_visit_at("https://docs.rs/serde", "serde - Rust", now - 5_000, false)
            .unwrap();
        s.record_visit_at("https://gist.github.com/x", "A gist", now - 9_000, false)
            .unwrap();
        s.toggle_bookmark("https://git-scm.com/book", "Pro Git book");
        s
    }

    #[test]
    fn suggest_ordering() {
        let s = store();
        let cfg = Config::default();
        let tabs = [
            OpenTab {
                id: 1,
                url: "https://news.ycombinator.com/".into(),
                title: "Hacker News".into(),
            },
            OpenTab {
                id: 2,
                url: "https://docs.rs/serde".into(),
                title: "serde - Rust".into(),
            },
        ];
        // Host-prefix history match outranks search.
        let r = suggest("git", &tabs, &s, &cfg, 8);
        assert_eq!(r[0].kind, SuggestionKind::History);
        assert_eq!(r[0].url.as_deref(), Some("https://github.com/"));
        assert_eq!(r[1].kind, SuggestionKind::Search);
        assert!(r[1].title.contains("DuckDuckGo") && r[1].title.contains("git"));
        assert!(r.iter().any(|i| i.kind == SuggestionKind::Bookmark));
        assert!(r.windows(2).all(|w| w[0].score >= w[1].score));
        // Open tab wins over the same URL in history (dedupe), search item first for non-host input.
        let r = suggest("serde", &tabs, &s, &cfg, 8);
        assert_eq!(r[0].kind, SuggestionKind::Search);
        assert_eq!(r[1].kind, SuggestionKind::Tab);
        assert_eq!(r[1].tab_id, Some(2));
        assert_eq!(
            r.iter()
                .filter(|i| i.url.as_deref() == Some("https://docs.rs/serde"))
                .count(),
            1
        );
        // URL input → url item first.
        let r = suggest("github.com/rust-lang", &tabs, &s, &cfg, 8);
        assert_eq!(r[0].kind, SuggestionKind::Url);
        assert_eq!(r[0].url.as_deref(), Some("https://github.com/rust-lang"));
        assert!(r.iter().any(|i| i.kind == SuggestionKind::Search));
        // Search item survives a tiny limit.
        let r = suggest("git", &tabs, &s, &cfg, 1);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, SuggestionKind::Search);
        assert!(suggest("  ", &tabs, &s, &cfg, 8).is_empty());
        let r = suggest("?github.com", &tabs, &s, &cfg, 8);
        assert_eq!((r.len(), r[0].kind), (1, SuggestionKind::Search));
        let j = serde_json::to_value(&r[0]).unwrap();
        assert_eq!(j["type"], "search");
        assert!(j.get("tabId").is_none());
    }

    #[test]
    fn command_mode() {
        let s = store();
        let cfg = Config::default();
        let r = suggest(">compact", &[], &s, &cfg, 5);
        assert_eq!(r[0].action.as_deref(), Some("toggle-compact"));
        assert_eq!(r[0].kind, SuggestionKind::Command);
        assert_eq!(r[0].accel.as_deref(), Some("Ctrl+Alt+C"));
        let r = suggest("> new tab", &[], &s, &cfg, 5);
        assert_eq!(r[0].action.as_deref(), Some("new-tab"));
        let r = suggest(">dpltab", &[], &s, &cfg, 5);
        assert_eq!(r[0].action.as_deref(), Some("duplicate-tab"));
        let all = suggest(">", &[], &s, &cfg, 1000);
        assert!(all.len() > 40 && all.iter().all(|i| i.action.as_deref() != Some("escape")));
        assert_eq!(all[0].action.as_deref(), Some("new-tab"));
        assert!(suggest(">zzzzqqq", &[], &s, &cfg, 5).is_empty());
    }
}
