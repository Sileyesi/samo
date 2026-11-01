//! `samo://api/<cmd>` dispatch (ARCHITECTURE §4.2) and config/theme live reload.

use crate::{
    actions, downloads, events,
    keys::Source,
    permissions,
    state::{AppState, Orientation},
    tab_ops,
    tabs::Tab,
    util::*,
    window,
};
use cef::*;
use serde_json::{Value, json};
use samo_services::{Config, omnibox, paths, themes, watch::Change};

pub struct ApiError(pub u16, pub String);

type Res = Result<Value, ApiError>;

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(400, msg.into())
}

fn ok() -> Res {
    Ok(json!({}))
}

fn opt_u32(a: &Value, k: &str) -> Option<u32> {
    a.get(k).and_then(Value::as_u64).map(|v| v as u32)
}

fn opt_bool(a: &Value, k: &str) -> Option<bool> {
    a.get(k).and_then(Value::as_bool)
}

fn opt_str<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str)
}

fn req_str<'a>(a: &'a Value, k: &str) -> Result<&'a str, ApiError> {
    opt_str(a, k).ok_or_else(|| bad(format!("missing `{k}`")))
}

fn opt_i32(a: &Value, k: &str) -> Option<i32> {
    a.get(k).and_then(Value::as_f64).map(|v| v.round() as i32)
}

/// Target tab: `args.id` or the active tab.
fn tab_id(s: &AppState, a: &Value) -> Result<u32, ApiError> {
    tab_ops::target(s, opt_u32(a, "id")).ok_or_else(|| ApiError(404, "no such tab".into()))
}

fn browser_of(s: &AppState, id: u32) -> Option<Browser> {
    s.tabs.get(id).and_then(Tab::browser)
}

pub fn state_json(s: &AppState) -> Value {
    let tabs: Vec<Value> = s.tabs.tabs.iter().map(Tab::to_json).collect();
    json!({
        "tabs": tabs,
        "activeId": s.tabs.active,
        "window": window::window_state_json(&s.win_state),
        "config": s.cfg.to_json(),
        "compact": s.cfg.compact.enabled,
        "split": window::split_json(s),
        "layout": { "reserve": s.layout.reserve, "overlay": s.layout.overlay },
        "platform": { "os": std::env::consts::OS },
    })
}

pub fn dispatch(s: &mut AppState, cmd: &str, a: Value, frame_url: &str) -> Res {
    vlog!(debug, "api {cmd} {a} (from {frame_url})");
    match cmd {
        "state.get" => Ok(state_json(s)),

        // ---- tabs
        "tab.new" => {
            let url = opt_str(&a, "url").map(str::to_string);
            let active = opt_bool(&a, "active").unwrap_or(true);
            let index = opt_u32(&a, "index").map(|i| i as usize);
            Ok(json!({ "id": tab_ops::new_tab(s, url, active, index) }))
        }
        "tab.close" => {
            let id = tab_id(s, &a)?;
            tab_ops::close(s, id);
            ok()
        }
        "tab.activate" => {
            let id = opt_u32(&a, "id").filter(|id| s.tabs.get(*id).is_some()).ok_or_else(|| bad("bad `id`"))?;
            tab_ops::activate(s, id);
            ok()
        }
        "tab.move" => {
            let id = tab_id(s, &a)?;
            let index = opt_u32(&a, "index").ok_or_else(|| bad("missing `index`"))?;
            tab_ops::move_tab(s, id, index as usize);
            ok()
        }
        "tab.pin" => {
            let id = tab_id(s, &a)?;
            let pinned = opt_bool(&a, "pinned").unwrap_or_else(|| !s.tabs.get(id).is_some_and(|t| t.pinned));
            tab_ops::pin(s, id, pinned);
            ok()
        }
        "tab.mute" => {
            let id = tab_id(s, &a)?;
            let muted = opt_bool(&a, "muted").unwrap_or_else(|| !s.tabs.get(id).is_some_and(|t| t.muted));
            tab_ops::mute(s, id, muted);
            ok()
        }
        "tab.duplicate" => {
            let id = tab_id(s, &a)?;
            Ok(json!({ "id": tab_ops::duplicate(s, id) }))
        }
        "tab.reopenClosed" => Ok(match tab_ops::reopen_closed(s) {
            Some(id) => json!({ "id": id }),
            None => json!({}),
        }),

        // ---- navigation
        "nav.go" => {
            let input = req_str(&a, "input")?.trim().to_string();
            if input.is_empty() {
                return Err(bad("empty input"));
            }
            let url = omnibox::fixup(&input, &s.cfg);
            if opt_bool(&a, "newTab").unwrap_or(false) {
                tab_ops::new_tab(s, Some(url.clone()), true, None);
            } else {
                let id = tab_id(s, &a)?;
                tab_ops::navigate(s, id, &url);
                if s.tabs.active != Some(id) {
                    tab_ops::activate(s, id);
                }
            }
            window::popup_hide(s, false);
            window::focus_active(s);
            Ok(json!({ "url": url }))
        }
        "nav.back" | "nav.forward" | "nav.reload" | "nav.reloadHard" | "nav.stop" => {
            let id = tab_id(s, &a)?;
            if let Some(b) = browser_of(s, id) {
                match cmd {
                    "nav.back" => b.go_back(),
                    "nav.forward" => b.go_forward(),
                    "nav.reload" => b.reload(),
                    "nav.reloadHard" => b.reload_ignore_cache(),
                    _ => b.stop_load(),
                }
            }
            ok()
        }
        "zoom.change" => {
            let id = tab_id(s, &a)?;
            let reset = opt_bool(&a, "reset").unwrap_or(false);
            let delta = opt_i32(&a, "delta").unwrap_or(0).signum();
            Ok(json!({ "zoom": tab_ops::zoom(s, id, delta, reset) }))
        }
        "find.start" => {
            let text = req_str(&a, "text")?;
            let id = tab_id(s, &a)?;
            if let Some(h) = s.tabs.get(id).and_then(Tab::host) {
                if text.is_empty() {
                    h.stop_finding(1);
                    events::to_chrome(s, "find:result", json!({ "count": 0, "active": 0, "final": true }));
                } else {
                    h.find(
                        Some(&cs(text)),
                        opt_bool(&a, "forward").unwrap_or(true) as i32,
                        opt_bool(&a, "matchCase").unwrap_or(false) as i32,
                        opt_bool(&a, "findNext").unwrap_or(false) as i32,
                    );
                }
            }
            ok()
        }
        "find.stop" => {
            let id = tab_id(s, &a)?;
            if let Some(h) = s.tabs.get(id).and_then(Tab::host) {
                h.stop_finding(opt_bool(&a, "clear").unwrap_or(true) as i32);
            }
            ok()
        }

        // ---- chrome layout + popup
        "ui.layout" => {
            let reserve = opt_i32(&a, "reserve").ok_or_else(|| bad("missing `reserve`"))?;
            let overlay = opt_i32(&a, "overlay").unwrap_or(reserve);
            window::set_layout(s, reserve, overlay);
            ok()
        }
        "ui.ready" => {
            s.ui_ready = true;
            if let Some(win) = &s.win {
                win.window.show();
            }
            ok()
        }
        "popup.show" => {
            let kind = opt_str(&a, "kind").unwrap_or("").to_string();
            let r = a.get("rect").ok_or_else(|| bad("missing `rect`"))?;
            let rect = Rect {
                x: opt_i32(r, "x").unwrap_or(0),
                y: opt_i32(r, "y").unwrap_or(0),
                width: opt_i32(r, "w").or_else(|| opt_i32(r, "width")).unwrap_or(300),
                height: opt_i32(r, "h").or_else(|| opt_i32(r, "height")).unwrap_or(200),
            };
            let data = a.get("data").cloned().unwrap_or(Value::Null);
            window::popup_show(s, kind, rect, data, opt_bool(&a, "focus").unwrap_or(false));
            ok()
        }
        "popup.update" => {
            window::popup_update(s, a.get("data").cloned().unwrap_or(Value::Null));
            ok()
        }
        "popup.hide" => {
            window::popup_hide(s, false);
            ok()
        }
        "popup.pick" => {
            events::to_chrome(s, "popup:pick", json!({ "payload": a.get("payload").cloned().unwrap_or(Value::Null) }));
            ok()
        }
        "popup.resize" => {
            let h = opt_i32(&a, "h").ok_or_else(|| bad("missing `h`"))?;
            window::popup_resize(s, h);
            ok()
        }

        // ---- window
        "window.minimize" | "window.toggleMaximize" | "window.close" | "window.toggleFullscreen" => {
            match cmd {
                "window.close" => window::close_window(s),
                "window.toggleFullscreen" => window::toggle_fullscreen(s),
                "window.minimize" => {
                    if let Some(win) = &s.win {
                        win.window.minimize();
                    }
                }
                _ => window::toggle_maximize(s),
            }
            ok()
        }
        "window.new" => {
            actions::run(s, "new-window", Source::Api);
            ok()
        }

        // ---- omnibox, history, bookmarks
        "suggest" => {
            let q = opt_str(&a, "query").unwrap_or("");
            let limit = opt_u32(&a, "limit").map(|l| l as usize).unwrap_or(s.cfg.urlbar.max_suggestions);
            let open: Vec<omnibox::OpenTab> = s
                .tabs
                .tabs
                .iter()
                .map(|t| omnibox::OpenTab { id: t.id, url: t.url.clone(), title: t.display_title().to_string() })
                .collect();
            let items = match &s.store {
                Some(store) => omnibox::suggest(q, &open, store, &s.cfg, limit),
                None => Vec::new(),
            };
            Ok(json!({ "items": items }))
        }
        "history.list" => {
            let store = s.store.as_ref().ok_or_else(|| ApiError(503, "history unavailable".into()))?;
            let q = opt_str(&a, "query").filter(|q| !q.is_empty());
            let limit = opt_u32(&a, "limit").unwrap_or(100) as usize;
            let offset = opt_u32(&a, "offset").unwrap_or(0) as usize;
            Ok(json!({ "items": store.history(q, limit, offset) }))
        }
        "history.delete" => {
            let url = req_str(&a, "url")?;
            if let Some(store) = &s.store {
                store.delete_history(url).map_err(|e| ApiError(500, format!("{e:#}")))?;
            }
            ok()
        }
        "history.clear" => {
            if let Some(store) = &s.store {
                store.clear_history().map_err(|e| ApiError(500, format!("{e:#}")))?;
            }
            ok()
        }
        "bookmarks.toggle" => {
            let url = req_str(&a, "url")?;
            let title = opt_str(&a, "title").unwrap_or(url);
            let store = s.store.as_ref().ok_or_else(|| ApiError(503, "store unavailable".into()))?;
            let on = store.toggle_bookmark(url, title);
            events::to_chrome(s, "bookmarks:changed", json!({ "url": url, "bookmarked": on }));
            Ok(json!({ "bookmarked": on }))
        }
        "bookmarks.list" => {
            let items = s.store.as_ref().map(|st| st.bookmarks()).unwrap_or_default();
            Ok(json!({ "items": items }))
        }
        "bookmarks.isBookmarked" => {
            let url = req_str(&a, "url")?;
            Ok(json!({ "bookmarked": s.store.as_ref().is_some_and(|st| st.is_bookmarked(url)) }))
        }

        // ---- config, themes, keys
        "config.get" => Ok(json!({
            "config": s.cfg.to_json(),
            "path": paths::config_file().to_string_lossy(),
            "defaults": Config::default_json(),
        })),
        "config.set" => {
            let key = req_str(&a, "key")?.to_string();
            let value = a.get("value").cloned().unwrap_or(Value::Null);
            s.cfg.set_key(&key, value).map_err(|e| bad(format!("{e:#}")))?;
            apply_config(s, Some(&key));
            Ok(json!({ "config": s.cfg.to_json() }))
        }
        "config.openFile" => {
            open_external(&paths::config_file().to_string_lossy());
            ok()
        }
        "theme.list" => Ok(json!({ "items": themes::list() })),
        "theme.reload" => {
            events::broadcast(s, "theme:changed", json!({}));
            ok()
        }
        "clipboard.write" => {
            let text = req_str(&a, "text")?;
            actions::copy_text(s, text);
            ok()
        }
        "keys.suspend" => {
            s.keys_suspended = ["suspended", "suspend"]
                .iter()
                .find_map(|k| opt_bool(&a, k))
                .unwrap_or(true);
            ok()
        }
        "keys.list" => {
            let items: Vec<Value> = s
                .keymap
                .list()
                .into_iter()
                .map(|(action, accels, label)| {
                    let accels_lbl: Vec<String> = accels.iter().map(|a| a.label()).collect();
                    let accels: Vec<String> = accels.iter().map(|a| a.to_string()).collect();
                    json!({
                        "action": action,
                        "accel": accels.first().cloned().unwrap_or_default(),
                        "accelLabels": accels_lbl,
                        "accels": accels,
                        "label": label,
                    })
                })
                .collect();
            Ok(json!({ "items": items }))
        }

        // ---- downloads, permissions, devtools
        "downloads.list" => Ok(downloads::list(s)),
        "downloads.open" | "downloads.showInFolder" | "downloads.cancel" => {
            let id = opt_u32(&a, "id").ok_or_else(|| bad("missing `id`"))?;
            let found = match cmd {
                "downloads.open" => downloads::open(s, id),
                "downloads.showInFolder" => downloads::show_in_folder(s, id),
                _ => downloads::cancel(s, id),
            };
            if found { ok() } else { Err(ApiError(404, "no such download".into())) }
        }
        "permission.respond" => {
            let req = a.get("reqId").and_then(Value::as_u64).ok_or_else(|| bad("missing `reqId`"))?;
            let allow = opt_bool(&a, "allow").unwrap_or(false);
            if permissions::respond(s, req, allow) { ok() } else { Err(ApiError(404, "no such request".into())) }
        }
        "devtools.open" => {
            let id = tab_id(s, &a)?;
            if let Some(b) = browser_of(s, id) {
                window::show_devtools(&b, None);
            }
            ok()
        }

        // ---- app
        "app.quit" => {
            window::close_window(s);
            ok()
        }
        "app.action" => {
            let action = req_str(&a, "action")?;
            if actions::run(s, action, Source::Api) { ok() } else { Err(bad(format!("unknown action `{action}`"))) }
        }
        "compact.set" => {
            let enabled = opt_bool(&a, "enabled").ok_or_else(|| bad("missing `enabled`"))?;
            if s.cfg.compact.enabled != enabled {
                s.cfg.set_key("compact.enabled", json!(enabled)).map_err(|e| ApiError(500, format!("{e:#}")))?;
                apply_config(s, Some("compact.enabled"));
            }
            ok()
        }
        "split.set" => {
            let ids = match a.get("ids") {
                Some(Value::Array(v)) if v.len() == 2 => {
                    let id = |i: usize| v[i].as_u64().map(|x| x as u32).ok_or_else(|| bad("bad `ids`"));
                    Some([id(0)?, id(1)?])
                }
                None | Some(Value::Null) => None,
                _ => return Err(bad("`ids` must be [a, b] or null")),
            };
            let orientation = match opt_str(&a, "orientation") {
                Some("horizontal") => Orientation::Horizontal,
                _ => Orientation::Vertical,
            };
            window::set_split(s, ids, orientation);
            ok()
        }
        _ => Err(ApiError(404, format!("unknown command `{cmd}`"))),
    }
}

/// Applies a changed config at runtime and tells every UI document.
pub fn apply_config(s: &mut AppState, key: Option<&str>) {
    s.keymap = samo_services::keys::bindings(&s.cfg);
    if let Some(w) = s.keymap.warnings().first().cloned() {
        events::toast(s, &w, "error");
    }
    crate::scheme::set_theme(&s.cfg.ui.theme);
    window::apply_visibility(s);
    let cfg = s.cfg.to_json();
    events::broadcast(s, "config:changed", json!({ "config": cfg }));
    if key == Some("ui.frameless") {
        events::toast(s, "Restart Samo to apply the window frame setting", "info");
    }
}

/// File watcher callback (already on the UI thread).
pub fn on_file_change(s: &mut AppState, change: Change) {
    match change {
        Change::Config => match Config::load_or_create() {
            Ok(cfg) => {
                if cfg.to_json() != s.cfg.to_json() {
                    let frameless_changed = cfg.ui.frameless != s.cfg.ui.frameless;
                    s.cfg = cfg;
                    apply_config(s, frameless_changed.then_some("ui.frameless"));
                }
            }
            Err(e) => {
                vlog!(warn, "config reload failed: {e:#}");
                events::toast(s, &format!("Config error: {e:#}"), "error");
            }
        },
        Change::Theme | Change::UserCss => events::broadcast(s, "theme:changed", json!({})),
    }
}
