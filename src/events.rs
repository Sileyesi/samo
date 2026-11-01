//! Rust → JS events (`window.__samoDispatch(event, payload)`).

use crate::{state::{self, AppState}, util::*};
use cef::*;
use serde_json::{Map, Value, json};

/// Max delay before coalesced tab updates are flushed (~30 flushes/s).
const FLUSH_MS: i64 = 33;

pub fn dispatch_to(b: &Browser, event: &str, payload: &Value) {
    let code = format!(
        "window.__samoDispatch && window.__samoDispatch({}, {});",
        js_str(event),
        payload
    );
    exec_js(b, &code);
}

pub fn to_chrome(s: &AppState, event: &str, payload: Value) {
    if let Some(b) = &s.chrome {
        dispatch_to(b, event, &payload);
    }
}

pub fn to_popup(s: &AppState, event: &str, payload: Value) {
    if let Some(b) = &s.popup_browser {
        dispatch_to(b, event, &payload);
    }
}

/// Sends to every tab whose URL starts with `prefix` (e.g. `samo://`).
pub fn to_tabs(s: &AppState, prefix: &str, event: &str, payload: &Value) {
    for t in &s.tabs.tabs {
        if t.url.starts_with(prefix)
            && let Some(b) = t.browser()
        {
            dispatch_to(&b, event, payload);
        }
    }
}

/// Chrome + popup + internal pages.
pub fn broadcast(s: &AppState, event: &str, payload: Value) {
    to_tabs(s, "samo://", event, &payload);
    to_popup(s, event, payload.clone());
    to_chrome(s, event, payload);
}

pub fn toast(s: &AppState, text: &str, kind: &str) {
    to_chrome(s, "toast", json!({ "text": text, "kind": kind }));
}

pub fn command(s: &AppState, action: &str, args: Option<Value>) {
    let mut p = json!({ "action": action });
    if let Some(a) = args {
        p["args"] = a;
    }
    to_chrome(s, "command", p);
}

/// Queues changed tab fields; flushed as one `tabs:updated` per tab shortly after.
pub fn tab_update(s: &mut AppState, id: u32, fields: Value) {
    let Value::Object(fields) = fields else { return };
    s.pending_updates.entry(id).or_insert_with(Map::new).extend(fields);
    if !s.flush_scheduled {
        s.flush_scheduled = true;
        post_ui_delayed(FLUSH_MS, || state::run(flush));
    }
}

pub fn flush(s: &mut AppState) {
    s.flush_scheduled = false;
    let pending = std::mem::take(&mut s.pending_updates);
    for (id, mut fields) in pending {
        if s.tabs.get(id).is_none() {
            continue;
        }
        fields.insert("id".into(), json!(id));
        to_chrome(s, "tabs:updated", Value::Object(fields));
    }
}

/// Drops queued updates (after a full `tabs:sync`).
pub fn sync_tabs(s: &mut AppState) {
    s.pending_updates.clear();
    let tabs: Vec<Value> = s.tabs.tabs.iter().map(|t| t.to_json()).collect();
    to_chrome(s, "tabs:sync", json!({ "tabs": tabs, "activeId": s.tabs.active }));
}
