//! Permission prompts forwarded to the chrome UI (`permission:request` / `permission.respond`).

use crate::{events, state::{self, AppState}, util::*};
use cef::*;
use serde_json::json;
use std::collections::HashMap;

const TIMEOUT_MS: i64 = 60_000;

pub enum Callback {
    Prompt(PermissionPromptCallback),
    /// getUserMedia-style request with the permission mask to grant.
    Media(MediaAccessCallback, u32),
}

struct Pending {
    callback: Callback,
    prompt_id: Option<u64>,
}

#[derive(Default)]
pub struct Permissions {
    next: u64,
    pending: HashMap<u64, Pending>,
}

pub fn prompt_kinds(mask: u32) -> Vec<&'static str> {
    use sys::cef_permission_request_types_t as P;
    let table: &[(P, &str)] = &[
        (P::CEF_PERMISSION_TYPE_CAMERA_STREAM, "camera"),
        (P::CEF_PERMISSION_TYPE_MIC_STREAM, "microphone"),
        (P::CEF_PERMISSION_TYPE_CAMERA_PAN_TILT_ZOOM, "camera-ptz"),
        (P::CEF_PERMISSION_TYPE_GEOLOCATION, "geolocation"),
        (P::CEF_PERMISSION_TYPE_NOTIFICATIONS, "notifications"),
        (P::CEF_PERMISSION_TYPE_CLIPBOARD, "clipboard"),
        (P::CEF_PERMISSION_TYPE_MIDI_SYSEX, "midi"),
        (P::CEF_PERMISSION_TYPE_MULTIPLE_DOWNLOADS, "multiple-downloads"),
        (P::CEF_PERMISSION_TYPE_LOCAL_FONTS, "local-fonts"),
        (P::CEF_PERMISSION_TYPE_IDLE_DETECTION, "idle-detection"),
        (P::CEF_PERMISSION_TYPE_STORAGE_ACCESS, "storage-access"),
        (P::CEF_PERMISSION_TYPE_TOP_LEVEL_STORAGE_ACCESS, "storage-access"),
        (P::CEF_PERMISSION_TYPE_WINDOW_MANAGEMENT, "window-management"),
        (P::CEF_PERMISSION_TYPE_FILE_SYSTEM_ACCESS, "file-system"),
        (P::CEF_PERMISSION_TYPE_KEYBOARD_LOCK, "keyboard-lock"),
        (P::CEF_PERMISSION_TYPE_POINTER_LOCK, "pointer-lock"),
        (P::CEF_PERMISSION_TYPE_PROTECTED_MEDIA_IDENTIFIER, "protected-media"),
        (P::CEF_PERMISSION_TYPE_REGISTER_PROTOCOL_HANDLER, "protocol-handler"),
        (P::CEF_PERMISSION_TYPE_LOCAL_NETWORK, "local-network"),
        (P::CEF_PERMISSION_TYPE_LOOPBACK_NETWORK, "local-network"),
        (P::CEF_PERMISSION_TYPE_SENSORS, "sensors"),
        (P::CEF_PERMISSION_TYPE_VR_SESSION, "vr"),
        (P::CEF_PERMISSION_TYPE_AR_SESSION, "ar"),
        (P::CEF_PERMISSION_TYPE_HAND_TRACKING, "hand-tracking"),
        (P::CEF_PERMISSION_TYPE_WEB_APP_INSTALLATION, "web-app-installation"),
        (P::CEF_PERMISSION_TYPE_IDENTITY_PROVIDER, "identity-provider"),
        (P::CEF_PERMISSION_TYPE_CAPTURED_SURFACE_CONTROL, "captured-surface-control"),
        (P::CEF_PERMISSION_TYPE_DISK_QUOTA, "storage"),
    ];
    let mut kinds: Vec<&str> = table
        .iter()
        .filter(|(p, _)| mask & (*p as u32) != 0)
        .map(|(_, n)| *n)
        .collect();
    kinds.dedup();
    if kinds.is_empty() {
        kinds.push("unknown");
    }
    kinds
}

pub fn media_kinds(mask: u32) -> Vec<&'static str> {
    use sys::cef_media_access_permission_types_t as M;
    let mut k = Vec::new();
    if mask & M::CEF_MEDIA_PERMISSION_DEVICE_VIDEO_CAPTURE as u32 != 0 {
        k.push("camera");
    }
    if mask & M::CEF_MEDIA_PERMISSION_DEVICE_AUDIO_CAPTURE as u32 != 0 {
        k.push("microphone");
    }
    if mask
        & (M::CEF_MEDIA_PERMISSION_DESKTOP_VIDEO_CAPTURE as u32
            | M::CEF_MEDIA_PERMISSION_DESKTOP_AUDIO_CAPTURE as u32)
        != 0
    {
        k.push("screen");
    }
    k
}

/// Registers a request and asks the chrome UI. Internal (samo://) origins are granted directly.
pub fn request(
    s: &mut AppState,
    tab_id: Option<u32>,
    origin: String,
    kinds: Vec<&'static str>,
    callback: Callback,
    prompt_id: Option<u64>,
) {
    if origin.starts_with("samo://") {
        finish(callback, true);
        return;
    }
    s.perms.next += 1;
    let req_id = s.perms.next;
    s.perms.pending.insert(req_id, Pending { callback, prompt_id });
    events::to_chrome(
        s,
        "permission:request",
        json!({ "reqId": req_id, "origin": origin, "kinds": kinds, "tabId": tab_id }),
    );
    post_ui_delayed(TIMEOUT_MS, move || state::run(move |s| {
        respond(s, req_id, false);
    }));
}

pub fn respond(s: &mut AppState, req_id: u64, allow: bool) -> bool {
    match s.perms.pending.remove(&req_id) {
        Some(p) => {
            finish(p.callback, allow);
            true
        }
        None => false,
    }
}

/// CEF dismissed a prompt by itself (navigation, tab closed…).
pub fn dismissed(s: &mut AppState, prompt_id: u64) {
    s.perms.pending.retain(|_, p| p.prompt_id != Some(prompt_id));
}

fn finish(callback: Callback, allow: bool) {
    match callback {
        Callback::Prompt(cb) => cb.cont(if allow {
            PermissionRequestResult::ACCEPT
        } else {
            PermissionRequestResult::DENY
        }),
        Callback::Media(cb, mask) => {
            if allow {
                cb.cont(mask)
            } else {
                cb.cancel()
            }
        }
    }
}
