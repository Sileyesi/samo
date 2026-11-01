//! XDG-style locations of Samo's files.
//!
//! Directories are created on demand (best effort) when requested.
//! `$SAMO_HOME` overrides everything (config in `$SAMO_HOME/config`, data in `$SAMO_HOME/data`),
//! which is handy for tests and portable setups; otherwise `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME`
//! are honored, falling back to `~/.config` / `~/.local/share`.

use std::{
    env,
    path::{Path, PathBuf},
};

const APP: &str = "samo";

fn env_dir(var: &str) -> Option<PathBuf> {
    env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(env::temp_dir)
}

fn ensure_dir(p: PathBuf) -> PathBuf {
    let _ = std::fs::create_dir_all(&p);
    p
}

fn in_dir(dir: PathBuf, name: &str) -> PathBuf {
    ensure_dir(dir).join(name)
}

/// Config base without creating it.
fn config_base() -> PathBuf {
    if let Some(h) = env_dir("SAMO_HOME") {
        return h.join("config");
    }
    env_dir("XDG_CONFIG_HOME")
        .unwrap_or_else(|| home().join(".config"))
        .join(APP)
}

fn data_base() -> PathBuf {
    if let Some(h) = env_dir("SAMO_HOME") {
        return h.join("data");
    }
    env_dir("XDG_DATA_HOME")
        .unwrap_or_else(|| home().join(".local/share"))
        .join(APP)
}

/// `~/.config/samo` (created on demand).
pub fn config_dir() -> PathBuf {
    ensure_dir(config_base())
}

/// `~/.local/share/samo` (created on demand).
pub fn data_dir() -> PathBuf {
    ensure_dir(data_base())
}

/// CEF profile / cache directory: `data_dir()/profile` (created on demand).
pub fn profile_dir() -> PathBuf {
    ensure_dir(data_base().join("profile"))
}

/// User themes: `config_dir()/themes` (created on demand).
pub fn themes_dir() -> PathBuf {
    ensure_dir(config_base().join("themes"))
}

/// `config_dir()/user.css` (the file itself may not exist).
pub fn user_css() -> PathBuf {
    in_dir(config_base(), "user.css")
}

/// `config_dir()/config.toml`.
pub fn config_file() -> PathBuf {
    in_dir(config_base(), "config.toml")
}

/// `data_dir()/session.json`.
pub fn session_file() -> PathBuf {
    in_dir(data_base(), "session.json")
}

/// `data_dir()/samo.db` (SQLite history + bookmarks).
pub fn db_file() -> PathBuf {
    in_dir(data_base(), "samo.db")
}

/// Expands a leading `~` / `~/` to the home directory.
pub fn expand_tilde(p: &str) -> PathBuf {
    match p.strip_prefix('~') {
        Some("") => home(),
        Some(rest) if rest.starts_with('/') => home().join(&rest[1..]),
        _ => PathBuf::from(p),
    }
}

/// Writes `data` to `path` atomically (temp file in the same dir + rename), creating parent dirs.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}-{seq}.tmp", std::process::id()));
    let res = (|| {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde() {
        assert_eq!(expand_tilde("~/Downloads"), home().join("Downloads"));
        assert_eq!(expand_tilde("/abs"), PathBuf::from("/abs"));
        assert_eq!(expand_tilde("~"), home());
    }

    #[test]
    fn atomic_write() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("sub/x.json");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "two");
        assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);
    }
}
