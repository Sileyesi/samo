//! Downloads: saved automatically into `general.downloads_dir` with unique names.

use crate::{events, state::AppState, util::*};
use cef::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub struct Entry {
    pub id: u32,
    pub name: String,
    pub url: String,
    pub path: PathBuf,
    pub received: i64,
    pub total: i64,
    pub speed: i64,
    pub state: &'static str,
    callback: Option<DownloadItemCallback>,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "url": self.url,
            "path": self.path.to_string_lossy(),
            "received": self.received,
            "total": self.total,
            "speed": self.speed,
            "state": self.state,
        })
    }
}

#[derive(Default)]
pub struct Downloads {
    pub items: BTreeMap<u32, Entry>,
}

/// Snapshot of a `DownloadItem` (the item itself must not outlive the callback).
pub struct ItemInfo {
    pub id: u32,
    pub url: String,
    pub full_path: String,
    pub received: i64,
    pub total: i64,
    pub speed: i64,
    pub state: &'static str,
}

impl ItemInfo {
    pub fn from_item(item: &DownloadItem) -> Self {
        let state = if item.is_complete() != 0 {
            "complete"
        } else if item.is_canceled() != 0 {
            "cancelled"
        } else if item.is_interrupted() != 0 {
            "interrupted"
        } else {
            "progress"
        };
        Self {
            id: item.id(),
            url: uf(&item.url()),
            full_path: uf(&item.full_path()),
            received: item.received_bytes(),
            total: item.total_bytes(),
            speed: item.current_speed(),
            state,
        }
    }
}

fn sanitize_name(name: &str) -> String {
    let n: String = name
        .chars()
        .map(|c| if c == '/' || c == '\0' { '_' } else { c })
        .collect();
    let n = n.trim().trim_start_matches('.').to_string();
    if n.is_empty() { "download".into() } else { n }
}

fn unique_path(dir: &Path, name: &str, taken: &[&Path]) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut candidate = dir.join(name);
    let mut n = 1;
    while candidate.exists() || taken.contains(&candidate.as_path()) {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/// Picks the target path for a new download and registers it.
pub fn start(s: &mut AppState, info: &ItemInfo, suggested: &str) -> PathBuf {
    let dir = s.cfg.downloads_path();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        vlog!(warn, "creating {}: {e}", dir.display());
    }
    let name = sanitize_name(suggested);
    let taken: Vec<&Path> = s
        .downloads
        .items
        .values()
        .filter(|e| e.state == "progress")
        .map(|e| e.path.as_path())
        .collect();
    let path = unique_path(&dir, &name, &taken);
    let entry = Entry {
        id: info.id,
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name),
        url: info.url.clone(),
        path: path.clone(),
        received: 0,
        total: info.total,
        speed: 0,
        state: "progress",
        callback: None,
    };
    let payload = entry.to_json();
    s.downloads.items.insert(info.id, entry);
    emit(s, payload);
    path
}

pub fn updated(s: &mut AppState, info: ItemInfo, callback: Option<DownloadItemCallback>) {
    let Some(e) = s.downloads.items.get_mut(&info.id) else { return };
    let changed = e.received != info.received || e.state != info.state || e.total != info.total;
    e.received = info.received;
    e.total = info.total;
    e.speed = info.speed;
    e.state = info.state;
    if !info.full_path.is_empty() {
        e.path = PathBuf::from(&info.full_path);
    }
    if callback.is_some() {
        e.callback = callback;
    }
    if e.state != "progress" {
        e.callback = None;
    }
    if changed {
        let payload = e.to_json();
        emit(s, payload);
    }
}

fn emit(s: &AppState, payload: Value) {
    events::to_tabs(s, "samo://downloads", "download:updated", &payload);
    events::to_chrome(s, "download:updated", payload);
}

pub fn list(s: &AppState) -> Value {
    let items: Vec<Value> = s.downloads.items.values().rev().map(Entry::to_json).collect();
    json!({ "items": items })
}

pub fn open(s: &AppState, id: u32) -> bool {
    let Some(e) = s.downloads.items.get(&id) else { return false };
    open_external(&e.path.to_string_lossy());
    true
}

pub fn show_in_folder(s: &AppState, id: u32) -> bool {
    let Some(e) = s.downloads.items.get(&id) else { return false };
    // Prefer the FileManager1 D-Bus API (selects the file); fall back to opening the folder.
    let path = e.path.clone();
    std::thread::spawn(move || {
        let uri = format!("file://{}", path.display());
        let ok = std::process::Command::new("gdbus")
            .args([
                "call", "--session", "--dest", "org.freedesktop.FileManager1",
                "--object-path", "/org/freedesktop/FileManager1",
                "--method", "org.freedesktop.FileManager1.ShowItems", &format!("['{uri}']"), "",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok && let Some(dir) = path.parent() {
            open_external(&dir.to_string_lossy());
        }
    });
    true
}

pub fn cancel(s: &mut AppState, id: u32) -> bool {
    let Some(e) = s.downloads.items.get_mut(&id) else { return false };
    if let Some(cb) = e.callback.take() {
        cb.cancel();
    }
    true
}
