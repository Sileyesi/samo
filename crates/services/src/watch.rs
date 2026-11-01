//! Live-reload file watching: `config.toml`, the user themes dir and `user.css`.
//!
//! Parent directories are watched (not the files), so editors that save by writing a temp file
//! and renaming it over the original are handled. Events are debounced (100 ms of quiet) on a
//! dedicated thread, which then calls the callback once per distinct [`Change`].

use crate::paths;
use notify::{EventKind, RecursiveMode, Watcher as _};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};

/// Debounce window.
pub const DEBOUNCE: Duration = Duration::from_millis(100);

/// What changed on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Change {
    Config,
    Theme,
    UserCss,
}

/// Keeps watching while alive; dropping it stops the watcher and its thread.
pub struct Watcher {
    _inner: notify::RecommendedWatcher,
}

/// Watches the real Samo paths ([`paths::config_file`], [`paths::themes_dir`], [`paths::user_css`]),
/// plus the on-disk built-in themes dir during development ([`crate::themes::builtin_dir`]).
/// `f` runs on the watcher thread.
pub fn watch(f: impl Fn(Change) + Send + 'static) -> anyhow::Result<Watcher> {
    let mut theme_dirs = vec![paths::themes_dir()];
    theme_dirs.extend(crate::themes::builtin_dir());
    watch_paths(&paths::config_file(), &theme_dirs, &paths::user_css(), f)
}

/// Matching rules: exact file paths and css-files-in-dir, each in literal and canonical form.
struct Targets {
    files: Vec<(PathBuf, Change)>,
    themes: Vec<PathBuf>,
}

impl Targets {
    fn classify(&self, p: &Path) -> Option<Change> {
        if let Some((_, c)) = self.files.iter().find(|(f, _)| f == p) {
            return Some(*c);
        }
        let in_themes = |d: &PathBuf| {
            p == d || (p.parent() == Some(d) && p.extension().is_some_and(|e| e == "css"))
        };
        self.themes.iter().any(in_themes).then_some(Change::Theme)
    }
}

fn with_canonical(p: &Path) -> Vec<PathBuf> {
    let mut v = vec![p.to_path_buf()];
    if let Ok(c) = std::fs::canonicalize(p)
        && c != p
    {
        v.push(c);
    }
    v
}

/// [`watch`] with explicit paths (tests, custom layouts). Theme dirs are created if missing.
pub fn watch_paths(
    config_file: &Path,
    theme_dirs: &[PathBuf],
    user_css: &Path,
    f: impl Fn(Change) + Send + 'static,
) -> anyhow::Result<Watcher> {
    for d in theme_dirs {
        let _ = std::fs::create_dir_all(d);
    }
    let mut targets = Targets {
        files: Vec::new(),
        themes: theme_dirs.iter().flat_map(|d| with_canonical(d)).collect(),
    };
    for (file, change) in [(config_file, Change::Config), (user_css, Change::UserCss)] {
        targets
            .files
            .extend(with_canonical(file).into_iter().map(|p| (p, change)));
    }
    let mut dirs: BTreeSet<PathBuf> = targets
        .files
        .iter()
        .filter_map(|(p, _)| p.parent().map(Path::to_path_buf))
        .collect();
    dirs.extend(targets.themes.iter().cloned());

    let (tx, rx) = mpsc::channel::<Change>();
    let mut inner = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        for c in ev
            .paths
            .iter()
            .filter_map(|p| targets.classify(p))
            .collect::<BTreeSet<_>>()
        {
            let _ = tx.send(c);
        }
    })?;
    let mut watched = 0;
    let mut last_err = None;
    for d in &dirs {
        match inner.watch(d, RecursiveMode::NonRecursive) {
            Ok(()) => watched += 1,
            Err(e) => last_err = Some(e),
        }
    }
    if watched == 0
        && let Some(e) = last_err
    {
        return Err(e.into());
    }

    thread::Builder::new()
        .name("samo-watch".into())
        .spawn(move || {
            // Ends when the notify watcher (and thus the sender) is dropped.
            while let Ok(first) = rx.recv() {
                let mut pending = BTreeSet::from([first]);
                let alive = loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(c) => {
                            pending.insert(c);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break true,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break false,
                    }
                };
                pending.into_iter().for_each(&f);
                if !alive {
                    break;
                }
            }
        })?;
    Ok(Watcher { _inner: inner })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn drain(rx: &mpsc::Receiver<Change>, wait: Duration) -> Vec<Change> {
        let end = Instant::now() + wait;
        let mut out = Vec::new();
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(c) => out.push(c),
                Err(_) => break,
            }
        }
        out
    }

    #[test]
    fn detects_changes() {
        let d = tempfile::tempdir().unwrap();
        let cfg = d.path().join("config.toml");
        let themes = d.path().join("themes");
        let css = d.path().join("user.css");
        std::fs::write(&cfg, "").unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = watch_paths(&cfg, std::slice::from_ref(&themes), &css, move |c| {
            let _ = tx.send(c);
        })
        .unwrap();

        // Burst of writes → a single debounced event.
        for i in 0..5 {
            std::fs::write(&cfg, format!("# {i}")).unwrap();
        }
        assert_eq!(drain(&rx, Duration::from_millis(600)), [Change::Config]);

        // Atomic replace (tmp + rename), like many editors.
        paths::write_atomic(&cfg, b"# atomic").unwrap();
        assert_eq!(drain(&rx, Duration::from_millis(600)), [Change::Config]);

        std::fs::write(themes.join("mine.css"), ":root{}").unwrap();
        std::fs::write(themes.join("notes.txt"), "ignored").unwrap();
        std::fs::write(&css, ".samo-tab{}").unwrap();
        std::fs::write(d.path().join("other.toml"), "").unwrap();
        let mut got = drain(&rx, Duration::from_millis(600));
        got.sort();
        assert_eq!(got, [Change::Theme, Change::UserCss]);
    }
}
