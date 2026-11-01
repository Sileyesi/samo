//! Session restore at startup and debounced session saving.

use crate::{events, state::{self, AppState}, tab_ops, tabs::Tab, util::*};
use cef::*;
use samo_services::{Config, omnibox, session};

const SAVE_DELAY_MS: i64 = 1000;

pub fn schedule(s: &mut AppState) {
    if s.session_scheduled || state::is_closing() {
        return;
    }
    s.session_scheduled = true;
    post_ui_delayed(SAVE_DELAY_MS, || {
        state::run(|s| {
            s.session_scheduled = false;
            save_now(s);
        })
    });
}

pub fn save_now(s: &AppState) {
    let tabs: Vec<session::SessionTab> = s
        .tabs
        .tabs
        .iter()
        .filter(|t| !t.url.is_empty())
        .map(|t| session::SessionTab {
            url: t.url.clone(),
            title: t.title.clone(),
            pinned: t.pinned,
            muted: t.muted,
        })
        .collect();
    let active = s
        .tabs
        .active
        .and_then(|a| s.tabs.tabs.iter().filter(|t| !t.url.is_empty()).position(|t| t.id == a))
        .unwrap_or(0);
    if let Err(e) = session::save(&session::Session { tabs, active }) {
        vlog!(warn, "saving session: {e:#}");
    }
}

/// Turns a command-line argument into a URL (existing paths become file:// URLs).
pub fn fixup_arg(arg: &str, cfg: &Config) -> String {
    let p = std::path::Path::new(arg);
    if p.exists()
        && let Ok(abs) = p.canonicalize()
    {
        return format!("file://{}", abs.display());
    }
    omnibox::fixup(arg, cfg)
}

fn command_line_urls(cfg: &Config) -> Vec<String> {
    let Some(cl) = command_line_get_global() else { return Vec::new() };
    let mut list = CefStringList::new();
    cl.arguments(Some(&mut list));
    list.into_iter()
        .filter(|a| !a.starts_with('-') && !a.trim().is_empty())
        .map(|a| fixup_arg(&a, cfg))
        .collect()
}

/// Creates the initial tabs per `general.startup` (+ URLs from the command line).
pub fn restore_startup(s: &mut AppState) {
    let saved = session::load();
    let mode = s.cfg.general.startup.clone();
    let mut active: Option<u32> = None;
    if let Some(saved) = saved {
        let restore_all = mode == "restore";
        for (i, st) in saved.tabs.iter().enumerate() {
            if !restore_all && !st.pinned {
                continue;
            }
            let id = s.tabs.alloc_id();
            let mut tab = Tab::new(id, &st.url);
            tab.title = st.title.clone();
            tab.pinned = st.pinned;
            tab.muted = st.muted;
            let at = s.tabs.len();
            s.tabs.insert(tab, at);
            if restore_all && i == saved.active {
                active = Some(id);
            }
        }
    }
    let urls = command_line_urls(&s.cfg);
    let need_start_page = mode != "restore" || s.tabs.len() == 0;
    if need_start_page && urls.is_empty() {
        let url = if mode == "homepage" {
            s.cfg.general.homepage.clone()
        } else {
            s.cfg.general.newtab_url.clone()
        };
        let id = s.tabs.alloc_id();
        let at = s.tabs.len();
        s.tabs.insert(Tab::new(id, &url), at);
        active = Some(id);
    }
    for url in urls {
        let id = s.tabs.alloc_id();
        let at = s.tabs.len();
        s.tabs.insert(Tab::new(id, &url), at);
        active = Some(id);
    }
    let active = active.or_else(|| s.tabs.tabs.first().map(|t| t.id));
    if let Some(id) = active {
        tab_ops::activate(s, id);
    }
    events::sync_tabs(s);
}
