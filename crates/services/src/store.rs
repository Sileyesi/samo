//! SQLite store (WAL) for history and bookmarks, with Firefox-style frecency search.
//!
//! Read methods return empty results on database errors (they are logged to stderr);
//! write methods return `Result`.

use anyhow::Context;
use rusqlite::{
    Connection, OptionalExtension, functions::FunctionFlags, params, params_from_iter, types::Value,
};
use serde::Serialize;
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// A history row. Times are unix milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visits: u32,
    pub last_visit: i64,
    pub typed_count: u32,
    /// Frecency-based relevance (only set by [`Store::frecency_search`], else 0).
    pub score: f64,
}

/// A bookmark. `added` is unix milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bookmark {
    pub url: String,
    pub title: String,
    pub added: i64,
}

/// History + bookmarks database. Not `Sync`; use from one thread (the CEF UI thread).
pub struct Store {
    conn: Connection,
}

const DAY_MS: i64 = 86_400_000;
/// Repeated visits to the same URL within this window count once.
const REVISIT_WINDOW_MS: i64 = 2_000;
/// Visits sampled per URL for frecency.
const SAMPLE: usize = 10;

/// Current time in unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// URLs that never enter history (internal pages, data:, etc.).
pub fn is_ignored_url(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.is_empty()
        || [
            "samo:",
            "about:",
            "chrome:",
            "chrome-error:",
            "devtools:",
            "view-source:",
            "data:",
            "javascript:",
            "blob:",
        ]
        .iter()
        .any(|p| u.starts_with(p))
}

/// Host of a URL without `www.` (lowercase), or `""`.
pub(crate) fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    let host = host.to_lowercase();
    host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
}

/// Firefox-like recency bucket weight for a visit `age_ms` old.
fn bucket_weight(age_ms: i64) -> f64 {
    match age_ms / DAY_MS {
        ..4 => 100.0,
        4..14 => 70.0,
        14..31 => 50.0,
        31..90 => 30.0,
        _ => 10.0,
    }
}

fn log_err<T: Default>(what: &str, r: rusqlite::Result<T>) -> T {
    r.unwrap_or_else(|e| {
        eprintln!("samo-services store: {what}: {e}");
        T::default()
    })
}

/// SQL condition + params matching every token against url/title, case-insensitively.
fn token_filter(tokens: &[String]) -> (String, Vec<Value>) {
    let mut sql = Vec::new();
    let mut args = Vec::new();
    for t in tokens {
        if t.is_ascii() {
            let esc = t
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            sql.push("(url || ' ' || title) LIKE ? ESCAPE '\\'".to_string());
            args.push(Value::Text(format!("%{esc}%")));
        } else {
            sql.push("instr(samo_lower(url || ' ' || title), ?) > 0".to_string());
            args.push(Value::Text(t.clone()));
        }
    }
    let cond = if sql.is_empty() {
        "1".into()
    } else {
        sql.join(" AND ")
    };
    (cond, args)
}

fn tokens(q: &str) -> Vec<String> {
    q.to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn row_entry(r: &rusqlite::Row) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        url: r.get(0)?,
        title: r.get(1)?,
        visits: r.get(2)?,
        last_visit: r.get(3)?,
        typed_count: r.get(4)?,
        score: 0.0,
    })
}

impl Store {
    /// Opens (creating if needed) the database at `path`, enabling WAL.
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Store> {
        let path = path.as_ref();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        Self::init(conn)
    }

    /// In-memory store (tests, private windows).
    pub fn open_in_memory() -> anyhow::Result<Store> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> anyhow::Result<Store> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        conn.create_scalar_function(
            "samo_lower",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| Ok(ctx.get::<String>(0)?.to_lowercase()),
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS history(
                url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
                visits INTEGER NOT NULL DEFAULT 0, last_visit INTEGER NOT NULL DEFAULT 0,
                typed_count INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS history_last_visit ON history(last_visit DESC);
             CREATE TABLE IF NOT EXISTS visits(
                id INTEGER PRIMARY KEY, url TEXT NOT NULL, at INTEGER NOT NULL, typed INTEGER NOT NULL DEFAULT 0);
             CREATE INDEX IF NOT EXISTS visits_url_at ON visits(url, at DESC);
             CREATE TABLE IF NOT EXISTS bookmarks(
                url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', added INTEGER NOT NULL);",
        )?;
        Ok(Store { conn })
    }

    /// Records a visit now (ignored for internal URLs). An empty title keeps the old one.
    pub fn record_visit(&self, url: &str, title: &str) -> anyhow::Result<()> {
        self.record_visit_at(url, title, now_ms(), false)
    }

    /// Marks that the user typed/picked `url` in the address bar (frecency bonus); call before the
    /// navigation's [`Store::record_visit`].
    pub fn record_typed(&self, url: &str) -> anyhow::Result<()> {
        if is_ignored_url(url) {
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO history(url, typed_count) VALUES(?1, 1)
             ON CONFLICT(url) DO UPDATE SET typed_count = typed_count + 1",
            [url],
        )?;
        Ok(())
    }

    /// Records a visit at an explicit time (imports, tests). `typed` gives the visit a bonus.
    pub fn record_visit_at(
        &self,
        url: &str,
        title: &str,
        at: i64,
        typed: bool,
    ) -> anyhow::Result<()> {
        if is_ignored_url(url) {
            return Ok(());
        }
        let last: Option<i64> = self
            .conn
            .query_row("SELECT max(at) FROM visits WHERE url = ?1", [url], |r| {
                r.get(0)
            })
            .optional()?
            .flatten();
        let revisit = last.is_some_and(|l| (at - l).abs() < REVISIT_WINDOW_MS);
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO history(url, title, visits, last_visit) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(url) DO UPDATE SET
               title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
               visits = visits + excluded.visits,
               last_visit = max(last_visit, excluded.last_visit)",
            params![url, title, if revisit { 0 } else { 1 }, at],
        )?;
        if !revisit {
            tx.execute(
                "INSERT INTO visits(url, at, typed) VALUES(?1, ?2, ?3)",
                params![url, at, typed],
            )?;
            tx.execute(
                "DELETE FROM visits WHERE url = ?1 AND id NOT IN
                   (SELECT id FROM visits WHERE url = ?1 ORDER BY at DESC LIMIT ?2)",
                params![url, SAMPLE as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Updates the title of an existing history entry (and bookmark title if it was empty).
    pub fn set_title(&self, url: &str, title: &str) -> anyhow::Result<()> {
        if title.is_empty() {
            return Ok(());
        }
        self.conn
            .execute("UPDATE history SET title = ?2 WHERE url = ?1", [url, title])?;
        self.conn.execute(
            "UPDATE bookmarks SET title = ?2 WHERE url = ?1 AND title = ''",
            [url, title],
        )?;
        Ok(())
    }

    /// History, most recent first, optionally filtered by query tokens (url/title, case-insensitive).
    pub fn history(&self, query: Option<&str>, limit: usize, offset: usize) -> Vec<HistoryEntry> {
        let (cond, mut args) = token_filter(&tokens(query.unwrap_or("")));
        args.push(Value::Integer(limit.min(i64::MAX as usize) as i64));
        args.push(Value::Integer(offset.min(i64::MAX as usize) as i64));
        let sql = format!(
            "SELECT url, title, visits, last_visit, typed_count FROM history
             WHERE visits > 0 AND {cond} ORDER BY last_visit DESC LIMIT ? OFFSET ?"
        );
        log_err("history", self.query(&sql, args))
    }

    fn query(&self, sql: &str, args: Vec<Value>) -> rusqlite::Result<Vec<HistoryEntry>> {
        let mut stmt = self.conn.prepare_cached(sql)?;
        stmt.query_map(params_from_iter(args), row_entry)?.collect()
    }

    /// Removes one URL from history.
    pub fn delete_history(&self, url: &str) -> anyhow::Result<()> {
        self.conn
            .execute("DELETE FROM history WHERE url = ?1", [url])?;
        self.conn
            .execute("DELETE FROM visits WHERE url = ?1", [url])?;
        Ok(())
    }

    /// Removes all history (bookmarks stay).
    pub fn clear_history(&self) -> anyhow::Result<()> {
        self.conn
            .execute_batch("DELETE FROM history; DELETE FROM visits;")?;
        Ok(())
    }

    /// Best history matches for `q`, by frecency × match quality (host-prefix matches boosted).
    /// An empty query returns the most frecent entries ("top sites").
    pub fn frecency_search(&self, q: &str, limit: usize) -> Vec<HistoryEntry> {
        log_err(
            "frecency_search",
            self.frecency_search_at(q, limit, now_ms()),
        )
    }

    fn frecency_search_at(
        &self,
        q: &str,
        limit: usize,
        now: i64,
    ) -> rusqlite::Result<Vec<HistoryEntry>> {
        let toks = tokens(q);
        let (cond, args) = token_filter(&toks);
        let order = if toks.is_empty() {
            "visits DESC, last_visit DESC"
        } else {
            "last_visit DESC"
        };
        let sql = format!(
            "SELECT url, title, visits, last_visit, typed_count FROM history
             WHERE visits > 0 AND {cond} ORDER BY {order} LIMIT 2000"
        );
        let mut rows = self.query(&sql, args)?;
        let mut sample = self.conn.prepare_cached(
            "SELECT at, typed FROM visits WHERE url = ?1 ORDER BY at DESC LIMIT ?2",
        )?;
        for e in &mut rows {
            let visits: Vec<(i64, bool)> = sample
                .query_map(params![e.url, SAMPLE as i64], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?
                .collect::<Result<_, _>>()?;
            let points: f64 = if visits.is_empty() {
                bucket_weight(now - e.last_visit)
            } else {
                visits
                    .iter()
                    .map(|&(at, typed)| bucket_weight(now - at) * if typed { 2.0 } else { 1.0 })
                    .sum::<f64>()
                    / visits.len() as f64
            };
            let typed_bonus = if e.typed_count > 0 { 1.5 } else { 1.0 };
            e.score = e.visits.max(1) as f64
                * points
                * typed_bonus
                * match_boost(&toks, &e.url, &e.title);
        }
        rows.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(b.last_visit.cmp(&a.last_visit))
        });
        rows.truncate(limit);
        Ok(rows)
    }

    /// Toggles a bookmark; returns the new state (true = bookmarked).
    pub fn toggle_bookmark(&self, url: &str, title: &str) -> bool {
        let r = (|| -> rusqlite::Result<bool> {
            if self
                .conn
                .execute("DELETE FROM bookmarks WHERE url = ?1", [url])?
                > 0
            {
                return Ok(false);
            }
            self.conn.execute(
                "INSERT INTO bookmarks(url, title, added) VALUES(?1, ?2, ?3)",
                params![url, title, now_ms()],
            )?;
            Ok(true)
        })();
        log_err("toggle_bookmark", r)
    }

    /// Whether `url` is bookmarked.
    pub fn is_bookmarked(&self, url: &str) -> bool {
        log_err(
            "is_bookmarked",
            self.conn
                .query_row("SELECT 1 FROM bookmarks WHERE url = ?1", [url], |_| Ok(()))
                .optional()
                .map(|o| o.is_some()),
        )
    }

    /// All bookmarks, newest first.
    pub fn bookmarks(&self) -> Vec<Bookmark> {
        self.bookmarks_matching("", usize::MAX)
    }

    /// Bookmarks whose url/title contain every token of `q` (case-insensitive), newest first.
    pub fn search_bookmarks(&self, q: &str, limit: usize) -> Vec<Bookmark> {
        self.bookmarks_matching(q, limit)
    }

    fn bookmarks_matching(&self, q: &str, limit: usize) -> Vec<Bookmark> {
        let (cond, mut args) = token_filter(&tokens(q));
        args.push(Value::Integer(limit.min(i64::MAX as usize) as i64));
        let r = (|| {
            let sql = format!(
                "SELECT url, title, added FROM bookmarks WHERE {cond} ORDER BY added DESC LIMIT ?"
            );
            let mut stmt = self.conn.prepare_cached(&sql)?;
            stmt.query_map(params_from_iter(args), |r| {
                Ok(Bookmark {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    added: r.get(2)?,
                })
            })?
            .collect()
        })();
        log_err("bookmarks", r)
    }
}

/// Match quality multiplier: host prefix ≫ word start in title/url ≫ plain substring.
pub(crate) fn match_boost(toks: &[String], url: &str, title: &str) -> f64 {
    if toks.is_empty() {
        return 1.0;
    }
    let host = host_of(url);
    let title = title.to_lowercase();
    let url_l = url.to_lowercase();
    let word_start = |hay: &str, t: &str| {
        hay.match_indices(t).any(|(i, _)| {
            i == 0
                || !hay[..i]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_alphanumeric)
        })
    };
    let mut boost = 1.0;
    if host.starts_with(toks[0].as_str()) {
        boost *= 4.0;
        if host == toks[0] || host.split('.').next() == Some(toks[0].as_str()) {
            boost *= 1.5;
        }
    }
    for t in toks {
        if word_start(&title, t) || word_start(&url_l, t) {
            boost *= 1.3;
        }
    }
    boost
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_basics() {
        let s = Store::open_in_memory().unwrap();
        s.record_visit("https://example.com/", "Example").unwrap();
        s.record_visit("https://example.com/", "").unwrap(); // dedup within window, keeps title
        s.record_visit("samo://newtab/", "New tab").unwrap();
        s.record_visit("about:blank", "").unwrap();
        s.record_visit_at(
            "https://rust-lang.org/",
            "Rust Программирование",
            now_ms() - 10_000,
            false,
        )
        .unwrap();
        let h = s.history(None, 100, 0);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].url, "https://example.com/");
        assert_eq!((h[0].title.as_str(), h[0].visits), ("Example", 1));
        assert_eq!(s.history(Some("RUST"), 100, 0).len(), 1);
        assert_eq!(s.history(Some("программирование"), 100, 0).len(), 1);
        assert_eq!(s.history(Some("rust example"), 100, 0).len(), 0);
        assert_eq!(s.history(Some("%"), 100, 0).len(), 0);
        assert_eq!(s.history(None, 1, 1)[0].url, "https://rust-lang.org/");
        s.set_title("https://example.com/", "Renamed").unwrap();
        assert_eq!(s.history(Some("renamed"), 10, 0).len(), 1);
        s.delete_history("https://example.com/").unwrap();
        assert_eq!(s.history(None, 100, 0).len(), 1);
        s.clear_history().unwrap();
        assert!(s.history(None, 100, 0).is_empty());
    }

    #[test]
    fn frecency_ordering() {
        let s = Store::open_in_memory().unwrap();
        let now = now_ms();
        // Old but frequently visited.
        for i in 0..20 {
            s.record_visit_at(
                "https://old.example/github",
                "Old",
                now - 200 * DAY_MS - i * 10_000,
                false,
            )
            .unwrap();
        }
        // Recent, several visits, host-prefix match.
        for i in 0..5 {
            s.record_visit_at(
                "https://github.com/",
                "GitHub",
                now - DAY_MS - i * 10_000,
                false,
            )
            .unwrap();
        }
        // Recent single visit, title match only.
        s.record_visit_at(
            "https://news.site/a",
            "Something about github",
            now - 1000,
            false,
        )
        .unwrap();
        let r = s.frecency_search_at("git", 10, now).unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].url, "https://github.com/");
        assert!(r.windows(2).all(|w| w[0].score >= w[1].score));
        // Recency beats frequency for equal match quality.
        s.record_visit_at("https://a.test/x", "x", now - 1000, false)
            .unwrap();
        s.record_visit_at("https://b.test/x", "x", now - 100 * DAY_MS, false)
            .unwrap();
        let r = s.frecency_search_at("x", 10, now).unwrap();
        let pos = |u: &str| r.iter().position(|e| e.url == u).unwrap();
        assert!(pos("https://a.test/x") < pos("https://b.test/x"));
        // Typed bonus.
        s.record_typed("https://b.test/x").unwrap();
        s.record_visit_at("https://b.test/x", "x", now - 1000, true)
            .unwrap();
        let r = s.frecency_search_at("x", 10, now).unwrap();
        assert!(pos_of(&r, "https://b.test/x") < pos_of(&r, "https://a.test/x"));
        assert!(!s.frecency_search_at("", 10, now).unwrap().is_empty());
    }

    fn pos_of(r: &[HistoryEntry], u: &str) -> usize {
        r.iter().position(|e| e.url == u).unwrap()
    }

    #[test]
    fn bookmarks() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path().join("db/samo.db")).unwrap();
        assert!(!s.is_bookmarked("https://a.com/"));
        assert!(s.toggle_bookmark("https://a.com/", "A"));
        assert!(s.is_bookmarked("https://a.com/"));
        assert_eq!(s.bookmarks().len(), 1);
        assert_eq!(s.search_bookmarks("a", 5)[0].title, "A");
        assert!(!s.toggle_bookmark("https://a.com/", "A"));
        assert!(s.bookmarks().is_empty());
        let mode: String = s
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://www.GitHub.com/x?y"), "github.com");
        assert_eq!(host_of("http://user@host:80/"), "host:80");
        assert!(
            is_ignored_url("SAMO://settings")
                && is_ignored_url("about:blank")
                && !is_ignored_url("https://x")
        );
    }
}
