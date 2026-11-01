//! CEF key events → `Accel` → key action (ARCHITECTURE §6).

use crate::{actions, state};
use cef::*;
use samo_services::keys::Accel;

/// Which browser a key event / action came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Tab(u32),
    Chrome,
    Popup,
    Api,
}

const SHIFT: u32 = 1 << 1;
const CONTROL: u32 = 1 << 2;
const ALT: u32 = 1 << 3;
const COMMAND: u32 = 1 << 7;
const ALTGR: u32 = 1 << 12;

fn key_name(vk: i32) -> Option<String> {
    let name = match vk {
        0x41..=0x5A => return Some(((vk as u8) as char).to_ascii_lowercase().to_string()),
        0x30..=0x39 => return Some(((vk as u8) as char).to_string()),
        0x60..=0x69 => return Some(((b'0' + (vk - 0x60) as u8) as char).to_string()),
        0x70..=0x87 => return Some(format!("f{}", vk - 0x6F)),
        0x08 => "backspace",
        0x09 => "tab",
        0x0D => "enter",
        0x1B => "escape",
        0x20 => "space",
        0x21 => "pageup",
        0x22 => "pagedown",
        0x23 => "end",
        0x24 => "home",
        0x25 => "left",
        0x26 => "up",
        0x27 => "right",
        0x28 => "down",
        0x2D => "insert",
        0x2E => "delete",
        0x6A => "multiply",
        0x6B | 0xBB => "plus",
        0x6D | 0xBD => "minus",
        0x6E | 0xBE => "period",
        0x6F | 0xBF => "slash",
        0xBC => "comma",
        0xBA => "semicolon",
        0xC0 => "backquote",
        0xDB => "bracketleft",
        0xDC => "backslash",
        0xDD => "bracketright",
        0xDE => "quote",
        _ => return None,
    };
    Some(name.to_string())
}

pub fn accel_from_event(ev: &KeyEvent) -> Option<Accel> {
    let m = ev.modifiers;
    let altgr = m & ALTGR != 0;
    Some(Accel {
        ctrl: m & CONTROL != 0 && !altgr,
        shift: m & SHIFT != 0,
        alt: m & ALT != 0 && !altgr,
        meta: m & COMMAND != 0,
        key: key_name(ev.windows_key_code)?,
    })
}

fn is_plain(a: &Accel) -> bool {
    !a.ctrl && !a.alt && !a.meta
}

/// `KeyboardHandler::on_pre_key_event` for every browser. Returns 1 when consumed.
pub fn on_pre_key_event(src: Source, event: Option<&KeyEvent>) -> i32 {
    let Some(ev) = event else { return 0 };
    if ev.type_ != KeyEventType::RAWKEYDOWN {
        return 0;
    }
    let Some(accel) = accel_from_event(ev) else { return 0 };
    vlog!(debug, "key {accel} from {src:?}");
    state::with(|s| {
        if s.keys_suspended {
            return 0;
        }
        if accel.key == "escape" && is_plain(&accel) && !accel.shift {
            return actions::escape(s, src) as i32;
        }
        let Some(action) = s.keymap.lookup(&accel).map(str::to_string) else { return 0 };
        // Plain keys (e.g. a bare letter bound by a user) never steal typing in fields.
        if is_plain(&accel) && ev.focus_on_editable_field != 0 && accel.key.len() == 1 {
            return 0;
        }
        actions::run(s, &action, src) as i32
    })
    .unwrap_or(0)
}
