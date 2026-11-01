//! Named key actions (ARCHITECTURE §6): native ones run here, UI ones become `command` events.

use crate::{
    events,
    keys::Source,
    state::{AppState, Orientation},
    tab_ops,
    tabs::Tab,
    util::*,
    window,
};
use cef::*;
use serde_json::json;

/// Actions the chrome UI implements; they need keyboard focus in the chrome view.
const UI_FOCUS_ACTIONS: &[&str] = &["focus-urlbar", "open-palette", "command-palette", "search-tabs", "find"];
const UI_ACTIONS: &[&str] = &["find-next", "find-prev", "toggle-compact", "copy-url", "copy-url-markdown"];

pub fn ui_command(s: &mut AppState, action: &str) {
    if UI_FOCUS_ACTIONS.contains(&action) {
        window::popup_hide(s, true);
        window::focus_chrome(s);
    }
    events::command(s, action, None);
}

/// Escape: consumed only while the popup is open (or a page is fullscreen).
pub fn escape(s: &mut AppState, _src: Source) -> bool {
    if s.popup.visible {
        events::command(s, "escape", None);
        return true;
    }
    if s.page_fullscreen {
        if let Some(h) = s.tabs.active_tab().and_then(Tab::host) {
            h.exit_fullscreen(1);
        }
        return true;
    }
    false
}

/// Runs `action`; returns false if it is unknown.
pub fn run(s: &mut AppState, action: &str, src: Source) -> bool {
    if UI_FOCUS_ACTIONS.contains(&action) || UI_ACTIONS.contains(&action) {
        ui_command(s, action);
        return true;
    }
    if action == "escape" {
        return escape(s, src);
    }
    let active = s.tabs.active;
    let host = || active.and_then(|id| s.tabs.get(id)).and_then(Tab::host);
    let browser = || active.and_then(|id| s.tabs.get(id)).and_then(Tab::browser);
    if let Some(n) = action.strip_prefix("select-tab-").and_then(|n| n.parse::<usize>().ok()) {
        tab_ops::select_index(s, n.saturating_sub(1));
        return true;
    }
    match action {
        "new-tab" => {
            if s.cfg.urlbar.ctrl_t == "palette" {
                ui_command(s, "open-palette");
            } else {
                tab_ops::new_tab(s, None, true, None);
            }
        }
        "close-tab" => {
            if let Some(id) = active {
                tab_ops::close(s, id);
            }
        }
        "reopen-closed-tab" => {
            tab_ops::reopen_closed(s);
        }
        "next-tab" => tab_ops::next_tab(s, 1),
        "prev-tab" => tab_ops::next_tab(s, -1),
        "select-last-tab" => {
            let last = s.tabs.len().saturating_sub(1);
            tab_ops::select_index(s, last);
        }
        "move-tab-left" | "move-tab-right" => {
            if let Some(id) = active
                && let Some(i) = s.tabs.index_of(id)
            {
                let to = if action == "move-tab-left" { i.saturating_sub(1) } else { i + 1 };
                tab_ops::move_tab(s, id, to);
            }
        }
        "reload" => {
            if let Some(b) = browser() {
                b.reload();
            }
        }
        "hard-reload" => {
            if let Some(b) = browser() {
                b.reload_ignore_cache();
            }
        }
        "stop" => {
            if let Some(b) = browser() {
                b.stop_load();
            }
        }
        "back" => {
            if let Some(b) = browser() {
                b.go_back();
            }
        }
        "forward" => {
            if let Some(b) = browser() {
                b.go_forward();
            }
        }
        "zoom-in" | "zoom-out" | "zoom-reset" => {
            if let Some(id) = active {
                let delta = match action {
                    "zoom-in" => 1,
                    "zoom-out" => -1,
                    _ => 0,
                };
                tab_ops::zoom(s, id, delta, delta == 0);
            }
        }
        "fullscreen" => window::toggle_fullscreen(s),
        "devtools" => {
            let b = match src {
                Source::Chrome => s.chrome.clone(),
                Source::Popup => s.popup_browser.clone(),
                _ => browser(),
            };
            if let Some(b) = b {
                window::show_devtools(&b, None);
            }
        }
        "view-source" => {
            if let Some(t) = s.tabs.active_tab()
                && !t.url.starts_with("view-source:")
            {
                let url = format!("view-source:{}", t.url);
                tab_ops::new_tab(s, Some(url), true, None);
            }
        }
        "print" => {
            if let Some(h) = host() {
                h.print();
            }
        }
        "bookmark" => toggle_bookmark(s),
        "history" => tab_ops::open_or_switch(s, "samo://history", "samo://history/"),
        "downloads" => tab_ops::open_or_switch(s, "samo://downloads", "samo://downloads/"),
        "settings" => tab_ops::open_or_switch(s, "samo://settings", "samo://settings/"),
        "pin-tab" => {
            if let Some(t) = s.tabs.active_tab() {
                let (id, pinned) = (t.id, t.pinned);
                tab_ops::pin(s, id, !pinned);
            }
        }
        "mute-tab" => {
            if let Some(t) = s.tabs.active_tab() {
                let (id, muted) = (t.id, t.muted);
                tab_ops::mute(s, id, !muted);
            }
        }
        "duplicate-tab" => {
            if let Some(id) = active {
                tab_ops::duplicate(s, id);
            }
        }
        "new-window" => {
            // Single-window build: open a fresh tab instead.
            tab_ops::new_tab(s, None, true, None);
            events::toast(s, "Multiple windows are not supported yet — opened a new tab", "info");
        }
        "close-window" | "quit" => window::close_window(s),
        "reload-theme" => {
            events::broadcast(s, "theme:changed", json!({}));
            events::toast(s, "Theme reloaded", "info");
        }
        "split-vertical" | "split-horizontal" => {
            let orientation =
                if action == "split-vertical" { Orientation::Vertical } else { Orientation::Horizontal };
            split_with_neighbor(s, orientation);
        }
        "unsplit" => window::set_split(s, None, Orientation::Vertical),
        _ => return false,
    }
    true
}

fn split_with_neighbor(s: &mut AppState, orientation: Orientation) {
    let Some(a) = s.tabs.active else { return };
    if let Some(sp) = s.split
        && sp.ids.contains(&a)
    {
        window::set_split(s, Some(sp.ids), orientation);
        return;
    }
    let i = s.tabs.index_of(a).unwrap_or(0);
    let b = match s.tabs.tabs.get(i + 1).or_else(|| i.checked_sub(1).and_then(|j| s.tabs.tabs.get(j))) {
        Some(t) => t.id,
        None => tab_ops::new_tab(s, None, false, None),
    };
    window::set_split(s, Some([a, b]), orientation);
    tab_ops::activate(s, a);
}

fn toggle_bookmark(s: &mut AppState) {
    let Some(t) = s.tabs.active_tab() else { return };
    if !is_recordable(&t.url) {
        return;
    }
    let (url, title) = (t.url.clone(), t.display_title().to_string());
    let Some(store) = &s.store else { return };
    let on = store.toggle_bookmark(&url, &title);
    events::toast(s, if on { "Bookmark added" } else { "Bookmark removed" }, "info");
    events::to_chrome(s, "bookmarks:changed", json!({ "url": url, "bookmarked": on }));
}

/// Copies text to the system clipboard: `wl-copy` (Wayland) / `xclip` / `xsel`, falling back to
/// the chrome document (which has clipboard access) when none is installed.
pub fn copy_text(s: &AppState, text: &str) {
    if copy_with_tool(text) {
        return;
    }
    let Some(b) = &s.chrome else { return };
    let t = js_str(text);
    let code = format!(
        "(async()=>{{const t={t};try{{await navigator.clipboard.writeText(t);}}catch(e){{\
         const a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;opacity:0';\
         document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();}}}})()"
    );
    exec_js(b, &code);
}

fn copy_with_tool(text: &str) -> bool {
    use std::{io::Write, process::{Command, Stdio}};
    // Windows: the chrome document's navigator.clipboard handles Unicode correctly.
    if cfg!(windows) {
        return false;
    }
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let tools: &[(&str, &[&str])] = if wayland {
        &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["-ib"])]
    } else {
        &[("xclip", &["-selection", "clipboard"]), ("xsel", &["-ib"])]
    };
    for (tool, args) in tools {
        let Ok(mut child) = Command::new(tool)
            .args(*args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        // Reap in the background (wl-copy/xclip keep serving the selection).
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        return true;
    }
    false
}
