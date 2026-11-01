//! Tab operations that combine the model (`tabs.rs`), views (`window.rs`) and events.

use crate::{
    events, session,
    state::AppState,
    tabs::Tab,
    util::*,
    window,
};
use cef::*;
use serde_json::json;

pub fn target(s: &AppState, id: Option<u32>) -> Option<u32> {
    id.or(s.tabs.active).filter(|id| s.tabs.get(*id).is_some())
}

fn default_index(s: &AppState) -> usize {
    if s.cfg.tabs.new_tab_position == "end" {
        return s.tabs.len();
    }
    s.tabs
        .active
        .and_then(|a| s.tabs.index_of(a))
        .map(|i| i + 1)
        .unwrap_or(s.tabs.len())
}

pub fn new_tab(s: &mut AppState, url: Option<String>, active: bool, index: Option<usize>) -> u32 {
    let url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| s.cfg.general.newtab_url.clone());
    let id = s.tabs.alloc_id();
    let index = index.unwrap_or_else(|| default_index(s));
    let index = s.tabs.insert(Tab::new(id, &url), index);
    window::ensure_view(s, id);
    if let Some(t) = s.tabs.get(id) {
        events::to_chrome(s, "tabs:created", json!({ "tab": t.to_json(), "index": index, "active": active }));
    }
    if active {
        activate(s, id);
    }
    session::schedule(s);
    id
}

pub fn activate(s: &mut AppState, id: u32) {
    if s.tabs.get(id).is_none() {
        return;
    }
    let prev = s.tabs.active;
    if s.page_fullscreen
        && let Some(p) = prev.filter(|p| *p != id)
    {
        if let Some(h) = s.tabs.get(p).and_then(Tab::host) {
            h.exit_fullscreen(1);
        }
        window::page_fullscreen(s, p, false);
    }
    s.tabs.active = Some(id);
    window::ensure_view(s, id);
    window::apply_visibility(s);
    window::focus_active(s);
    if prev != Some(id) {
        s.keys_suspended = false;
        window::popup_hide(s, true);
        events::to_chrome(s, "tabs:activated", json!({ "id": id }));
        session::schedule(s);
    }
    if let Some(t) = s.tabs.get(id) {
        let title = t.display_title().to_string();
        window::set_title(s, &title);
    }
}

pub fn close(s: &mut AppState, id: u32) {
    if s.tabs.get(id).is_none() {
        return;
    }
    if s.tabs.len() == 1 {
        if s.cfg.tabs.close_window_with_last_tab {
            window::close_window(s);
            return;
        }
        new_tab(s, None, false, None);
    }
    if s.split.is_some_and(|sp| sp.ids.contains(&id)) {
        window::set_split(s, None, crate::state::Orientation::Vertical);
    }
    let was_active = s.tabs.active == Some(id);
    let Some((index, tab)) = s.tabs.remove(id) else { return };
    if was_active {
        s.tabs.active = None;
        if let Some(next) = s.tabs.successor(index) {
            activate(s, next);
        }
    }
    s.pending_updates.remove(&id);
    s.keys_suspended = false;
    events::to_chrome(s, "tabs:closed", json!({ "id": id }));
    if let Some(view) = tab.view {
        if let Some(h) = view.browser().and_then(|b| b.host()) {
            h.close_browser(1);
        }
        window::remove_view(s, &view);
    }
    session::schedule(s);
}

pub fn move_tab(s: &mut AppState, id: u32, index: usize) {
    if let Some(to) = s.tabs.move_to(id, index) {
        events::to_chrome(s, "tabs:moved", json!({ "id": id, "index": to }));
        session::schedule(s);
    }
}

pub fn pin(s: &mut AppState, id: u32, pinned: bool) {
    let Some(from) = s.tabs.index_of(id) else { return };
    if s.tabs.tabs[from].pinned == pinned {
        return;
    }
    let mut tab = s.tabs.tabs.remove(from);
    tab.pinned = pinned;
    let to = s.tabs.pinned_count();
    s.tabs.tabs.insert(to, tab);
    events::tab_update(s, id, json!({ "pinned": pinned }));
    events::flush(s);
    if to != from {
        events::to_chrome(s, "tabs:moved", json!({ "id": id, "index": to }));
    }
    session::schedule(s);
}

pub fn mute(s: &mut AppState, id: u32, muted: bool) {
    let Some(t) = s.tabs.get_mut(id) else { return };
    t.muted = muted;
    if let Some(h) = t.host() {
        h.set_audio_muted(muted as i32);
    }
    events::tab_update(s, id, json!({ "muted": muted }));
    session::schedule(s);
}

pub fn duplicate(s: &mut AppState, id: u32) -> Option<u32> {
    let i = s.tabs.index_of(id)?;
    let url = s.tabs.get(id)?.url.clone();
    Some(new_tab(s, Some(url), true, Some(i + 1)))
}

pub fn reopen_closed(s: &mut AppState) -> Option<u32> {
    let c = s.tabs.closed.pop()?;
    let id = new_tab(s, Some(c.url), true, Some(c.index));
    if c.pinned {
        pin(s, id, true);
    }
    Some(id)
}

pub fn navigate(s: &mut AppState, id: u32, url: &str) {
    let Some(t) = s.tabs.get_mut(id) else { return };
    match t.browser().and_then(|b| b.main_frame()) {
        Some(f) => f.load_url(Some(&cs(url))),
        None => {
            t.url = url.to_string();
            let u = t.url.clone();
            events::tab_update(s, id, json!({ "url": u, "secure": security_of(&u) }));
        }
    }
}

/// Activates an existing tab whose URL starts with `prefix`, or opens `url`.
pub fn open_or_switch(s: &mut AppState, prefix: &str, url: &str) {
    match s.tabs.tabs.iter().find(|t| t.url.starts_with(prefix)).map(|t| t.id) {
        Some(id) => activate(s, id),
        None => {
            new_tab(s, Some(url.to_string()), true, None);
        }
    }
}

/// Chrome's zoom presets (as factors).
const ZOOM_FACTORS: [f64; 17] =
    [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];

pub fn zoom(s: &mut AppState, id: u32, delta: i32, reset: bool) -> f64 {
    let Some(t) = s.tabs.get_mut(id) else { return 0.0 };
    let Some(h) = t.host() else { return t.zoom };
    let level = if reset || delta == 0 {
        0.0
    } else {
        let cur = 1.2f64.powf(h.zoom_level());
        let next = if delta > 0 {
            ZOOM_FACTORS.iter().copied().find(|f| *f > cur + 0.001).unwrap_or(5.0)
        } else {
            ZOOM_FACTORS.iter().rev().copied().find(|f| *f < cur - 0.001).unwrap_or(0.25)
        };
        next.ln() / 1.2f64.ln()
    };
    h.set_zoom_level(level);
    t.zoom = level;
    events::tab_update(s, id, json!({ "zoom": level }));
    level
}

pub fn on_browser_created(s: &mut AppState, id: u32, browser: Browser) {
    let Some(t) = s.tabs.get(id) else {
        // Closed before its browser came up.
        if let Some(h) = browser.host() {
            h.close_browser(1);
        }
        return;
    };
    if t.muted
        && let Some(h) = browser.host()
    {
        h.set_audio_muted(1);
    }
}

pub fn next_tab(s: &mut AppState, step: isize) {
    let n = s.tabs.len() as isize;
    let Some(i) = s.tabs.active.and_then(|a| s.tabs.index_of(a)) else { return };
    if n < 2 {
        return;
    }
    let j = (i as isize + step).rem_euclid(n) as usize;
    let id = s.tabs.tabs[j].id;
    activate(s, id);
}

pub fn select_index(s: &mut AppState, index: usize) {
    if let Some(id) = s.tabs.tabs.get(index).map(|t| t.id) {
        activate(s, id);
    }
}
