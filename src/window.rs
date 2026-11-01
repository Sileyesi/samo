//! The browser window: root layout (spacer + content panel), chrome/popup overlays,
//! popup surface, split view, page fullscreen, window state, close sequence.

use crate::{
    app::BG_COLOR,
    events, session,
    state::{self, AppState, Orientation, WinState},
    tab_ops,
    ui_client::{self, Role},
    util::*,
};
use cef::*;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    sync::{
        Arc,
        atomic::{AtomicI32, Ordering},
    },
};

pub const CHROME_URL: &str = "samo://ui/chrome.html";
pub const POPUP_URL: &str = "samo://ui/popup.html";
const SPLIT_GAP: i32 = 6;

pub struct WinCtx {
    pub window: Window,
    pub spacer: Panel,
    spacer_h: Arc<AtomicI32>,
    pub content: Panel,
    content_mode: Cell<(Orientation, i32)>,
    pub chrome_view: BrowserView,
    pub chrome_ov: OverlayController,
    pub popup_view: BrowserView,
    pub popup_ov: OverlayController,
}

impl WinCtx {
    pub fn size(&self) -> (i32, i32) {
        let r = self.window.client_area_bounds_in_screen();
        if r.width > 0 && r.height > 0 {
            (r.width, r.height)
        } else {
            let s = self.window.size();
            (s.width, s.height)
        }
    }
}

pub fn browser_settings(clipboard: bool) -> BrowserSettings {
    BrowserSettings {
        background_color: BG_COLOR,
        javascript_access_clipboard: if clipboard { State::ENABLED } else { State::DEFAULT },
        ..Default::default()
    }
}

fn linux_props(props: Option<&mut LinuxWindowProperties>) -> i32 {
    let Some(p) = props else { return 0 };
    p.wayland_app_id = cs_transfer("samo");
    p.wm_class_class = cs_transfer("samo");
    p.wm_class_name = cs_transfer("samo");
    1
}

// ---------------------------------------------------------------------------------------------
// Main window

pub fn create_main_window() {
    let frameless = state::with(|s| s.cfg.ui.frameless).unwrap_or(true);
    let mut delegate = SamoWindowDelegate::new(frameless);
    window_create_top_level(Some(&mut delegate));
}

wrap_window_delegate! {
    struct SamoWindowDelegate {
        frameless: bool,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1280, height: 820 }
        }

        fn minimum_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 600, height: 400 }
        }

        fn on_layout_changed(&self, _view: Option<&mut View>, _new_bounds: Option<&Rect>) {
            state::run(relayout);
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            if let Some(window) = window {
                build_window(window);
            }
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            state::run(|s| {
                s.win = None;
                s.chrome = None;
                s.popup_browser = None;
                for t in &mut s.tabs.tabs {
                    t.view = None;
                }
            });
            state::window_gone();
        }

        fn can_close(&self, window: Option<&mut Window>) -> i32 {
            match window {
                Some(w) => can_close(w),
                None => 1,
            }
        }

        fn is_frameless(&self, _window: Option<&mut Window>) -> i32 {
            self.frameless as i32
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 1 }

        fn on_window_bounds_changed(&self, _window: Option<&mut Window>, _new_bounds: Option<&Rect>) {
            state::run(|s| {
                relayout(s);
                emit_window_state(s);
            });
        }

        fn on_window_fullscreen_transition(&self, _window: Option<&mut Window>, _is_completed: i32) {
            state::run(|s| {
                relayout(s);
                emit_window_state(s);
            });
        }

        fn on_window_activation_changed(&self, _window: Option<&mut Window>, active: i32) {
            state::run(move |s| {
                if active == 0 {
                    popup_hide(s, true);
                }
                emit_window_state(s);
            });
        }

        fn linux_window_properties(
            &self,
            _window: Option<&mut Window>,
            properties: Option<&mut LinuxWindowProperties>,
        ) -> i32 {
            linux_props(properties)
        }
    }
}

wrap_panel_delegate! {
    struct SpacerDelegate {
        height: Arc<AtomicI32>,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            // CEF treats a size with a zero side as "use default", so width is 1 (stretched anyway).
            Size { width: 1, height: self.height.load(Ordering::Relaxed).max(0) }
        }
    }

    impl PanelDelegate {}
}

fn content_layout(orientation: Orientation, inset: i32) -> BoxLayoutSettings {
    BoxLayoutSettings {
        horizontal: (orientation == Orientation::Vertical) as i32,
        inside_border_insets: Insets { top: inset, left: inset, bottom: inset, right: inset },
        between_child_spacing: SPLIT_GAP,
        cross_axis_alignment: AxisAlignment::STRETCH,
        ..Default::default()
    }
}

fn build_window(window: &mut Window) {
    let Some((reserve, overlay, inset)) =
        state::with(|s| (s.layout.reserve, s.layout.overlay, s.cfg.ui.content_inset as i32))
    else {
        return;
    };
    window.set_background_color(BG_COLOR);
    window.set_title(Some(&cs("Samo")));

    let root = window.set_to_box_layout(Some(&BoxLayoutSettings {
        cross_axis_alignment: AxisAlignment::STRETCH,
        ..Default::default()
    }));
    let spacer_h = Arc::new(AtomicI32::new(reserve));
    let mut sd = SpacerDelegate::new(spacer_h.clone());
    let (Some(spacer), Some(content)) = (panel_create(Some(&mut sd)), panel_create(None)) else {
        vlog!(error, "failed to create panels");
        return;
    };
    spacer.set_background_color(BG_COLOR);
    spacer.set_visible((reserve > 0) as i32);
    content.set_background_color(BG_COLOR);
    window.add_child_view(Some(&mut View::from(&spacer)));
    window.add_child_view(Some(&mut View::from(&content)));
    if let Some(root) = root {
        root.set_flex_for_view(Some(&mut View::from(&content)), 1);
    }
    content.set_to_box_layout(Some(&content_layout(Orientation::Vertical, inset)));

    let chrome_view = ui_client::create_view(Role::Chrome, CHROME_URL);
    let popup_view = ui_client::create_view(Role::Popup, POPUP_URL);
    let (Some(chrome_view), Some(popup_view)) = (chrome_view, popup_view) else {
        vlog!(error, "failed to create UI browser views");
        return;
    };

    window.show();

    let chrome_ov = window.add_overlay_view(Some(&mut View::from(&chrome_view)), DockingMode::CUSTOM, 1);
    let popup_ov = window.add_overlay_view(Some(&mut View::from(&popup_view)), DockingMode::CUSTOM, 1);
    let (Some(chrome_ov), Some(popup_ov)) = (chrome_ov, popup_ov) else {
        vlog!(error, "failed to add overlays");
        return;
    };
    let w = window.size().width;
    chrome_ov.set_bounds(Some(&Rect { x: 0, y: 0, width: w, height: overlay }));
    chrome_ov.set_visible(1);
    popup_ov.set_bounds(Some(&Rect { x: 0, y: 0, width: 10, height: 10 }));
    popup_ov.set_visible(0);

    let ctx = WinCtx {
        window: window.clone(),
        spacer,
        spacer_h,
        content,
        content_mode: Cell::new((Orientation::Vertical, inset)),
        chrome_view,
        chrome_ov,
        popup_view,
        popup_ov,
    };
    state::run(move |s| {
        s.win = Some(ctx);
        session::restore_startup(s);
        relayout(s);
        emit_window_state(s);
    });
}

/// Re-applies spacer height and overlay bounds (window resize, ui.layout, fullscreen).
pub fn relayout(s: &mut AppState) {
    let Some(win) = &s.win else { return };
    let (w, h) = win.size();
    let reserve = if s.page_fullscreen { 0 } else { s.layout.reserve.clamp(0, h.max(0)) };
    if win.spacer_h.swap(reserve, Ordering::Relaxed) != reserve {
        // A zero-height preferred size reads as "default" to CEF, so hide the spacer instead.
        win.spacer.set_visible((reserve > 0) as i32);
        win.spacer.invalidate_layout();
        win.window.layout();
    }
    let overlay_h = s.layout.overlay.clamp(1, h.max(1));
    win.chrome_ov.set_bounds(Some(&Rect { x: 0, y: 0, width: w, height: overlay_h }));
    win.chrome_ov.set_visible(!s.page_fullscreen as i32);
    let resized = s.last_size != (w, h);
    s.last_size = (w, h);
    apply_drag_regions(s);
    if resized {
        popup_hide(s, true);
    }
}

pub fn set_layout(s: &mut AppState, reserve: i32, overlay: i32) {
    s.layout.reserve = reserve.max(0);
    s.layout.overlay = overlay.max(1);
    relayout(s);
}

pub fn apply_drag_regions(s: &AppState) {
    let Some(win) = &s.win else { return };
    if s.page_fullscreen || s.win_state.fullscreen {
        win.window.set_draggable_regions(None);
        return;
    }
    let max_y = s.layout.overlay;
    let clipped: Vec<DraggableRegion> = s
        .drag_regions
        .iter()
        .filter_map(|r| {
            let b = &r.bounds;
            let bottom = (b.y + b.height).min(max_y);
            (bottom > b.y).then(|| DraggableRegion {
                bounds: Rect { x: b.x, y: b.y, width: b.width, height: bottom - b.y },
                draggable: r.draggable,
            })
        })
        .collect();
    win.window.set_draggable_regions(Some(&clipped));
}

pub fn emit_window_state(s: &mut AppState) {
    let Some(win) = &s.win else { return };
    let (width, height) = win.size();
    let ws = WinState {
        maximized: win.window.is_maximized() != 0,
        fullscreen: win.window.is_fullscreen() != 0,
        focused: win.window.is_active() != 0,
        width,
        height,
    };
    if ws.maximized != s.win_state.maximized
        && let Some((want, at)) = s.max_target
    {
        // A native double-click toggle raced our `window.toggleMaximize`: restore the target.
        if at.elapsed().as_millis() < 700 && ws.maximized != want {
            s.max_target = None;
            if want { win.window.maximize() } else { win.window.restore() }
        }
    }
    if ws != s.win_state {
        s.win_state = ws;
        events::to_chrome(s, "window:state", window_state_json(&ws));
        apply_drag_regions(s);
    }
}

pub fn window_state_json(ws: &WinState) -> Value {
    json!({
        "maximized": ws.maximized,
        "fullscreen": ws.fullscreen,
        "focused": ws.focused,
        "width": ws.width,
        "height": ws.height,
    })
}

pub fn set_title(s: &AppState, title: &str) {
    if let Some(win) = &s.win {
        let t = if title.is_empty() { "Samo".to_string() } else { format!("{title} — Samo") };
        win.window.set_title(Some(&cs(&t)));
    }
}

// ---------------------------------------------------------------------------------------------
// Focus

pub fn focus_chrome(s: &AppState) {
    if let Some(win) = &s.win {
        win.chrome_view.request_focus();
    }
    if let Some(h) = s.chrome.as_ref().and_then(|b| b.host()) {
        h.set_focus(1);
    }
}

pub fn focus_active(s: &AppState) {
    let Some(t) = s.tabs.active_tab() else { return };
    if let Some(v) = &t.view {
        v.request_focus();
    }
    if let Some(h) = t.host() {
        h.set_focus(1);
    }
}

/// `window.toggleMaximize`; ignores a request right after a native (double-click) toggle.
pub fn toggle_maximize(s: &mut AppState) {
    let Some(win) = &s.win else { return };
    let max = win.window.is_maximized() != 0;
    if let Some((want, at)) = s.max_target
        && at.elapsed().as_millis() < 700
        && want == max
    {
        return;
    }
    s.max_target = Some((!max, std::time::Instant::now()));
    if max { win.window.restore() } else { win.window.maximize() }
}

// ---------------------------------------------------------------------------------------------
// Popup overlay

pub fn popup_show(s: &mut AppState, kind: String, rect: Rect, data: Value, focus: bool) {
    let Some(win) = &s.win else { return };
    let r = clamp_rect(rect, win.size());
    win.popup_ov.set_bounds(Some(&r));
    win.popup_ov.set_visible(1);
    let return_to_chrome = if focus {
        let chrome_focused = win.chrome_view.has_focus() != 0;
        win.popup_view.request_focus();
        if let Some(h) = s.popup_browser.as_ref().and_then(|b| b.host()) {
            h.set_focus(1);
        }
        chrome_focused
    } else {
        s.popup.visible && s.popup.return_to_chrome
    };
    s.popup = state::PopupState {
        visible: true,
        return_to_chrome,
        rect: r,
        kind: kind.clone(),
        data: data.clone(),
    };
    events::to_popup(s, "popup:data", json!({ "kind": kind, "data": data }));
}

pub fn popup_update(s: &mut AppState, data: Value) {
    s.popup.data = data.clone();
    let kind = s.popup.kind.clone();
    events::to_popup(s, "popup:data", json!({ "kind": kind, "data": data }));
}

pub fn popup_resize(s: &mut AppState, h: i32) {
    let Some(win) = &s.win else { return };
    let mut r = s.popup.rect.clone();
    r.height = h.max(1);
    let r = clamp_rect(r, win.size());
    if s.popup.visible {
        win.popup_ov.set_bounds(Some(&r));
    }
    s.popup.rect = r;
}

/// Hides the popup. `notify`: Rust-initiated (tell the chrome via `popup:hidden`).
pub fn popup_hide(s: &mut AppState, notify: bool) {
    if !s.popup.visible {
        return;
    }
    s.popup.visible = false;
    let Some(win) = &s.win else { return };
    let had_focus = win.popup_view.has_focus() != 0;
    win.popup_ov.set_visible(0);
    if had_focus {
        if s.popup.return_to_chrome {
            focus_chrome(s);
        } else {
            focus_active(s);
        }
    }
    if notify {
        events::to_chrome(s, "popup:hidden", json!({}));
    }
}

fn clamp_rect(r: Rect, (w, h): (i32, i32)) -> Rect {
    let width = r.width.clamp(1, w.max(1));
    let height = r.height.clamp(1, h.max(1));
    Rect {
        x: r.x.clamp(0, (w - width).max(0)),
        y: r.y.clamp(0, (h - height).max(0)),
        width,
        height,
    }
}

// ---------------------------------------------------------------------------------------------
// Tab views

/// Creates the BrowserView of a tab if it doesn't exist yet (lazy restore).
pub fn ensure_view(s: &mut AppState, id: u32) {
    let Some(win) = &s.win else { return };
    let Some(tab) = s.tabs.get_mut(id) else { return };
    if tab.view.is_some() {
        return;
    }
    let mut client = crate::client::new_client(id);
    let mut delegate = TabViewDelegate::new(id);
    let settings = browser_settings(false);
    let url = if tab.url.is_empty() { "about:blank".to_string() } else { tab.url.clone() };
    let Some(view) = browser_view_create(
        Some(&mut client),
        Some(&cs(&url)),
        Some(&settings),
        None,
        None,
        Some(&mut delegate),
    ) else {
        vlog!(error, "browser_view_create failed for tab {id}");
        return;
    };
    view.set_visible(0);
    let mut v = View::from(&view);
    win.content.add_child_view(Some(&mut v));
    if let Some(l) = win.content.get_layout().and_then(|l| l.as_box_layout()) {
        l.set_flex_for_view(Some(&mut v), 1);
    }
    tab.view = Some(view);
}

pub fn remove_view(s: &AppState, view: &BrowserView) {
    if let Some(win) = &s.win {
        win.content.remove_child_view(Some(&mut View::from(view)));
    }
}

/// Shows the active tab (or both split panes) and hides the rest.
pub fn apply_visibility(s: &mut AppState) {
    let active = s.tabs.active;
    let split = s.split.filter(|sp| active.is_some_and(|a| sp.ids.contains(&a)));
    let Some(win) = &s.win else { return };
    let mode = (split.map_or(Orientation::Vertical, |sp| sp.orientation), s.cfg.ui.content_inset as i32);
    if win.content_mode.get() != mode {
        win.content_mode.set(mode);
        if let Some(l) = win.content.set_to_box_layout(Some(&content_layout(mode.0, mode.1))) {
            for t in s.tabs.tabs.iter().filter_map(|t| t.view.as_ref()) {
                l.set_flex_for_view(Some(&mut View::from(t)), 1);
            }
        }
    }
    if let Some(sp) = split {
        // Keep pane order = split order.
        for (i, id) in sp.ids.iter().enumerate() {
            if let Some(v) = s.tabs.get(*id).and_then(|t| t.view.as_ref()) {
                win.content.reorder_child_view(Some(&mut View::from(v)), i as i32);
            }
        }
    }
    for t in &s.tabs.tabs {
        let Some(v) = &t.view else { continue };
        let visible = match split {
            Some(sp) => sp.ids.contains(&t.id),
            None => Some(t.id) == active,
        };
        if (v.is_visible() != 0) != visible {
            v.set_visible(visible as i32);
        }
    }
    win.content.layout();
}

pub fn set_split(s: &mut AppState, ids: Option<[u32; 2]>, orientation: Orientation) {
    s.split = match ids {
        Some([a, b]) if a != b && s.tabs.get(a).is_some() && s.tabs.get(b).is_some() => {
            ensure_view(s, a);
            ensure_view(s, b);
            Some(state::Split { ids: [a, b], orientation })
        }
        _ => None,
    };
    if let Some(sp) = s.split
        && !s.tabs.active.is_some_and(|a| sp.ids.contains(&a))
    {
        tab_ops::activate(s, sp.ids[0]);
    }
    apply_visibility(s);
    events::to_chrome(s, "split:changed", json!({ "split": split_json(s) }));
}

pub fn split_json(s: &AppState) -> Value {
    match s.split {
        Some(sp) => json!({ "ids": sp.ids, "orientation": sp.orientation.as_str() }),
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------------------------
// Page fullscreen

pub fn page_fullscreen(s: &mut AppState, tab_id: u32, fullscreen: bool) {
    if s.tabs.active != Some(tab_id) && fullscreen {
        return;
    }
    s.page_fullscreen = fullscreen;
    if let Some(win) = &s.win {
        let is_fs = win.window.is_fullscreen() != 0;
        if fullscreen && !is_fs {
            s.fullscreen_by_page = true;
            win.window.set_fullscreen(1);
        } else if !fullscreen && is_fs && s.fullscreen_by_page {
            s.fullscreen_by_page = false;
            win.window.set_fullscreen(0);
        }
    }
    if fullscreen {
        popup_hide(s, true);
    }
    relayout(s);
}

pub fn toggle_fullscreen(s: &mut AppState) {
    if let Some(win) = &s.win {
        let fs = win.window.is_fullscreen() != 0;
        s.fullscreen_by_page = false;
        win.window.set_fullscreen((!fs) as i32);
    }
}

// ---------------------------------------------------------------------------------------------
// Close sequence

/// Saves the session and lets the window close; tearing down the view hierarchy destroys every
/// browser (their `on_before_close` then quits the loop). Browsers are not asked to close one by
/// one: `do_close` returning 0 would re-enter the window close from inside this callback.
fn can_close(window: &mut Window) -> i32 {
    vlog!(debug, "window close requested");
    state::set_closing(true);
    let extra = state::with(|s| {
        session::save_now(s);
        popup_hide(s, false);
        std::mem::take(&mut s.extra_windows)
    });
    let Some(extra) = extra else {
        // State busy (close requested from inside a state borrow): retry shortly.
        let w = window.clone();
        post_ui(move || w.close());
        return 0;
    };
    for w in extra {
        w.close();
    }
    1
}

pub fn close_window(s: &AppState) {
    match &s.win {
        Some(win) => {
            let w = win.window.clone();
            post_ui(move || w.close());
        }
        None => quit_message_loop(),
    }
}

/// Opens URLs passed to a second `samo` invocation.
pub fn open_external(s: &mut AppState, args: Vec<String>) {
    let urls: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if urls.is_empty() {
        let url = s.cfg.general.newtab_url.clone();
        tab_ops::new_tab(s, Some(url), true, None);
    } else {
        for (i, u) in urls.iter().enumerate() {
            let url = session::fixup_arg(u, &s.cfg);
            tab_ops::new_tab(s, Some(url), i == 0, None);
        }
    }
    if let Some(win) = &s.win {
        win.window.activate();
    }
}

// ---------------------------------------------------------------------------------------------
// Tab BrowserView delegate + DevTools windows

wrap_browser_view_delegate! {
    struct TabViewDelegate {
        tab_id: u32,
    }

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn on_browser_created(&self, _browser_view: Option<&mut BrowserView>, browser: Option<&mut Browser>) {
            let id = self.tab_id;
            let Some(browser) = browser.cloned() else { return };
            state::run(move |s| tab_ops::on_browser_created(s, id, browser));
        }

        fn delegate_for_popup_browser_view(
            &self,
            _browser_view: Option<&mut BrowserView>,
            _settings: Option<&BrowserSettings>,
            _client: Option<&mut Client>,
            _is_devtools: i32,
        ) -> Option<BrowserViewDelegate> {
            Some(PopupViewDelegate::new())
        }

        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: i32,
        ) -> i32 {
            popup_browser_view.map(|v| open_aux_window(v.clone())).unwrap_or(0)
        }

        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

wrap_browser_view_delegate! {
    pub struct PopupViewDelegate {}

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: i32,
        ) -> i32 {
            popup_browser_view.map(|v| open_aux_window(v.clone())).unwrap_or(0)
        }

        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

/// Hosts a DevTools (or other non-tab popup) BrowserView in its own top-level window.
pub fn open_aux_window(view: BrowserView) -> i32 {
    let mut d = AuxWindowDelegate::new(RefCell::new(Some(view)));
    match window_create_top_level(Some(&mut d)) {
        Some(w) => {
            state::run(move |s| s.extra_windows.push(w));
            1
        }
        None => 0,
    }
}

wrap_window_delegate! {
    struct AuxWindowDelegate {
        view: RefCell<Option<BrowserView>>,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1100, height: 760 }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let view = self.view.borrow();
            let (Some(window), Some(view)) = (window, view.as_ref()) else { return };
            window.set_background_color(BG_COLOR);
            window.set_title(Some(&cs("DevTools — Samo")));
            window.add_child_view(Some(&mut View::from(view)));
            window.show();
        }

        fn on_window_destroyed(&self, window: Option<&mut Window>) {
            *self.view.borrow_mut() = None;
            if let Some(w) = window.cloned() {
                state::run(move |s| {
                    let mut v = View::from(&w);
                    s.extra_windows.retain(|x| x.is_same(Some(&mut v)) == 0);
                });
            }
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 { 1 }
        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 { 1 }

        fn linux_window_properties(
            &self,
            _window: Option<&mut Window>,
            properties: Option<&mut LinuxWindowProperties>,
        ) -> i32 {
            linux_props(properties)
        }
    }
}

/// Opens DevTools for `browser` (optionally inspecting the element at `at`).
pub fn show_devtools(browser: &Browser, at: Option<Point>) {
    let Some(host) = browser.host() else { return };
    let info = WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() };
    let mut client = ui_client::devtools_client();
    let settings = browser_settings(false);
    host.show_dev_tools(Some(&info), Some(&mut client), Some(&settings), at.as_ref());
}
