//! Global browser state, owned by the CEF UI thread.
//!
//! CEF calls back into us synchronously from many of its functions (adding views, focusing,
//! closing…). To avoid RefCell re-entrancy panics, callbacks use [`run`], which defers the
//! closure to a fresh UI task when the state is already borrowed.

use crate::{
    downloads::Downloads, permissions::Permissions, tabs::TabManager, util::*, window::WinCtx,
};
use cef::*;
use serde_json::{Map, Value};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    sync::Mutex,
};
use samo_services::{Config, keys::Keymap, store::Store, watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    /// Side by side (vertical divider).
    Vertical,
    /// Stacked (horizontal divider).
    Horizontal,
}

impl Orientation {
    pub fn as_str(self) -> &'static str {
        match self {
            Orientation::Vertical => "vertical",
            Orientation::Horizontal => "horizontal",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Split {
    pub ids: [u32; 2],
    pub orientation: Orientation,
}

#[derive(Default)]
pub struct PopupState {
    pub visible: bool,
    /// The chrome (URL bar) had focus when a focused popup opened; give it back on hide.
    pub return_to_chrome: bool,
    pub rect: Rect,
    pub kind: String,
    pub data: Value,
}

pub struct LayoutState {
    pub reserve: i32,
    pub overlay: i32,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub struct WinState {
    pub maximized: bool,
    pub fullscreen: bool,
    pub focused: bool,
    pub width: i32,
    pub height: i32,
}

pub struct AppState {
    pub cfg: Config,
    pub keymap: Keymap,
    pub store: Option<Store>,
    pub win: Option<WinCtx>,
    pub tabs: TabManager,
    pub chrome: Option<Browser>,
    pub popup_browser: Option<Browser>,
    pub popup: PopupState,
    pub layout: LayoutState,
    /// A page requested HTML fullscreen: chrome hidden, nothing reserved.
    pub page_fullscreen: bool,
    /// The window went fullscreen because of the page (restore on exit).
    pub fullscreen_by_page: bool,
    pub split: Option<Split>,
    pub downloads: Downloads,
    pub perms: Permissions,
    pub ui_ready: bool,
    /// Shortcuts disabled while a settings page records a new accelerator (`keys.suspend`).
    pub keys_suspended: bool,
    pub pending_updates: BTreeMap<u32, Map<String, Value>>,
    pub flush_scheduled: bool,
    pub session_scheduled: bool,
    pub drag_regions: Vec<DraggableRegion>,
    pub win_state: WinState,
    pub last_size: (i32, i32),
    /// Maximize state requested by `window.toggleMaximize` (guards against a second, native
    /// double-click toggle on the drag region).
    pub max_target: Option<(bool, std::time::Instant)>,
    /// DevTools windows etc.
    pub extra_windows: Vec<Window>,
    _watcher: Option<watch::Watcher>,
}

thread_local! {
    static STATE: RefCell<Option<AppState>> = const { RefCell::new(None) };
    static CLOSING: Cell<bool> = const { Cell::new(false) };
}

static BOOT_CONFIG: Mutex<Option<Config>> = Mutex::new(None);

pub fn set_boot_config(cfg: Config) {
    if let Ok(mut g) = BOOT_CONFIG.lock() {
        *g = Some(cfg);
    }
}

/// Builds the state on the UI thread (from `on_context_initialized`).
pub fn init() {
    let cfg = BOOT_CONFIG.lock().ok().and_then(|mut g| g.take()).unwrap_or_default();
    crate::scheme::set_theme(&cfg.ui.theme);
    let store = match Store::open(samo_services::paths::db_file()) {
        Ok(s) => Some(s),
        Err(e) => {
            vlog!(error, "opening history store: {e:#}");
            None
        }
    };
    let watcher = match watch::watch(|change| {
        post_ui(move || run(move |s| crate::api::on_file_change(s, change)))
    }) {
        Ok(w) => Some(w),
        Err(e) => {
            vlog!(warn, "file watching disabled: {e:#}");
            None
        }
    };
    let compact = cfg.compact.enabled;
    let state = AppState {
        keymap: samo_services::keys::bindings(&cfg),
        cfg,
        store,
        win: None,
        tabs: TabManager::default(),
        chrome: None,
        popup_browser: None,
        popup: PopupState::default(),
        layout: if compact {
            LayoutState { reserve: 0, overlay: 4 }
        } else {
            LayoutState { reserve: 84, overlay: 84 }
        },
        page_fullscreen: false,
        fullscreen_by_page: false,
        split: None,
        downloads: Downloads::default(),
        perms: Permissions::default(),
        ui_ready: false,
        keys_suspended: false,
        pending_updates: BTreeMap::new(),
        flush_scheduled: false,
        session_scheduled: false,
        drag_regions: Vec::new(),
        win_state: WinState::default(),
        last_size: (0, 0),
        max_target: None,
        extra_windows: Vec::new(),
        _watcher: watcher,
    };
    STATE.with(|s| *s.borrow_mut() = Some(state));
}

/// Drops all state (CEF objects, store, watcher) before `cef::shutdown`.
pub fn teardown() {
    let state = STATE.with(|s| s.try_borrow_mut().ok().and_then(|mut g| g.take()));
    drop(state);
}

/// Runs `f` with the state if it is available right now (not borrowed, initialized).
pub fn with<R>(f: impl FnOnce(&mut AppState) -> R) -> Option<R> {
    STATE.with(|cell| {
        let mut g = cell.try_borrow_mut().ok()?;
        g.as_mut().map(f)
    })
}

/// Runs `f` now, or on a later UI task if the state is currently borrowed.
pub fn run(f: impl FnOnce(&mut AppState) + Send + 'static) {
    let busy = STATE.with(|cell| cell.try_borrow_mut().is_err());
    if busy {
        post_ui(move || run(f));
    } else {
        with(f);
    }
}

thread_local! {
    static LIVE_BROWSERS: Cell<usize> = const { Cell::new(0) };
    static WINDOW_GONE: Cell<bool> = const { Cell::new(false) };
}

/// Every client's `on_after_created`.
pub fn browser_created() {
    LIVE_BROWSERS.with(|c| c.set(c.get() + 1));
}

/// Every client's `on_before_close`; quits once the main window and all browsers are gone.
pub fn browser_closed() {
    vlog!(debug, "browser closed; {} left", LIVE_BROWSERS.with(Cell::get).saturating_sub(1));
    let left = LIVE_BROWSERS.with(|c| {
        c.set(c.get().saturating_sub(1));
        c.get()
    });
    if left == 0 && WINDOW_GONE.with(Cell::get) {
        quit_message_loop();
    }
}

pub fn window_gone() {
    vlog!(debug, "main window destroyed; {} browsers alive", LIVE_BROWSERS.with(Cell::get));
    WINDOW_GONE.with(|c| c.set(true));
    if LIVE_BROWSERS.with(Cell::get) == 0 {
        quit_message_loop();
    } else {
        // Safety net: never hang on exit.
        post_ui_delayed(3000, quit_message_loop);
    }
}

pub fn is_closing() -> bool {
    CLOSING.with(Cell::get)
}

pub fn set_closing(v: bool) {
    CLOSING.with(|c| c.set(v));
}
