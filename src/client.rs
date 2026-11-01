//! CEF client for content tabs: feeds the tab model and the chrome UI.

use crate::{
    actions, downloads, events,
    keys::{self, Source},
    permissions,
    state::{self, AppState},
    tab_ops,
    tabs::Tab,
    util::*,
    window,
};
use cef::*;
use serde_json::json;

const CMD_OPEN_LINK: i32 = 26501;
const CMD_COPY_LINK: i32 = 26502;
const CMD_INSPECT: i32 = 26503;

/// Injected after every main-frame load: reports `<meta name=theme-color>` and media playback
/// through console messages that `on_console_message` swallows.
const PAGE_PROBE_JS: &str = r#"(()=>{if(window.__samoObs)return window.__samoObs();
const send=(k,v)=>{try{console.debug('__samo_'+k+':'+v)}catch(e){}};
let tc=null,au=null,t=0;
const pickTc=()=>{let c='';for(const m of document.querySelectorAll('meta[name="theme-color"]')){const md=m.getAttribute('media');if(!md||matchMedia(md).matches){c=(m.getAttribute('content')||'').trim();break;}}if(c!==tc){tc=c;send('tc',c);}};
const pickAu=()=>{const a=[...document.querySelectorAll('video,audio')].some(m=>!m.paused&&!m.ended&&!m.muted&&m.volume>0);if(a!==au){au=a;send('au',a?1:0);}};
const sched=()=>{clearTimeout(t);t=setTimeout(pickTc,150);};
try{new MutationObserver(sched).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['content','media']});}catch(e){}
try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',pickTc);}catch(e){}
['play','playing','pause','ended','volumechange','emptied'].forEach(e=>document.addEventListener(e,pickAu,true));
window.__samoObs=()=>{tc=null;pickTc();pickAu();};window.__samoObs();})()"#;

const SPA_RECHECK_JS: &str = "window.__samoObs&&window.__samoObs()";

pub fn new_client(tab_id: u32) -> Client {
    TabClient::new(tab_id)
}

/// Runs `f` with the tab `id` if it still exists.
fn with_tab(id: u32, f: impl FnOnce(&mut AppState, &mut Tab) + Send + 'static) {
    state::run(move |s| {
        // Temporarily take the tab out to hand out both &mut AppState and &mut Tab.
        let Some(i) = s.tabs.index_of(id) else { return };
        let mut tab = std::mem::replace(&mut s.tabs.tabs[i], Tab::new(id, ""));
        f(s, &mut tab);
        if let Some(i) = s.tabs.index_of(id) {
            s.tabs.tabs[i] = tab;
        }
    });
}

fn is_main(frame: &Option<&mut Frame>) -> bool {
    frame.as_ref().is_some_and(|f| f.is_main() != 0)
}

fn sanitize_color(c: &str) -> Option<String> {
    let c = c.trim();
    let ok = !c.is_empty()
        && c.len() <= 64
        && c.chars().all(|ch| ch.is_ascii_alphanumeric() || " #(),.%/-".contains(ch));
    ok.then(|| c.to_string())
}

wrap_client! {
    struct TabClient {
        tab_id: u32,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> { Some(TabDisplay::new(self.tab_id)) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(TabLoad::new(self.tab_id)) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(TabLifeSpan::new(self.tab_id)) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(TabRequest::new(self.tab_id)) }
        fn keyboard_handler(&self) -> Option<KeyboardHandler> { Some(TabKeys::new(self.tab_id)) }
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> { Some(TabMenu::new(self.tab_id)) }
        fn download_handler(&self) -> Option<DownloadHandler> { Some(TabDownloads::new(self.tab_id)) }
        fn permission_handler(&self) -> Option<PermissionHandler> { Some(TabPermissions::new(self.tab_id)) }
        fn find_handler(&self) -> Option<FindHandler> { Some(TabFind::new(self.tab_id)) }
        fn focus_handler(&self) -> Option<FocusHandler> { Some(TabFocus::new(self.tab_id)) }
    }
}

wrap_display_handler! {
    struct TabDisplay {
        tab_id: u32,
    }

    impl DisplayHandler {
        fn on_address_change(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if !is_main(&frame) {
                return;
            }
            let url = opt_str(url);
            let browser = browser.cloned();
            with_tab(self.tab_id, move |s, t| {
                if t.url == url {
                    return;
                }
                t.url = url.clone();
                t.crashed = false;
                events::tab_update(s, t.id, json!({ "url": url, "secure": security_of(&url), "crashed": false }));
                if is_recordable(&url)
                    && let Some(store) = &s.store
                    && let Err(e) = store.record_visit(&url, &t.title)
                {
                    vlog!(warn, "record_visit: {e:#}");
                }
                if let Some(b) = browser {
                    post_ui_delayed(300, move || exec_js(&b, SPA_RECHECK_JS));
                }
                crate::session::schedule(s);
            });
        }

        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = opt_str(title);
            with_tab(self.tab_id, move |s, t| {
                if t.title == title {
                    return;
                }
                t.title = title.clone();
                events::tab_update(s, t.id, json!({ "title": t.display_title() }));
                if is_recordable(&t.url)
                    && let Some(store) = &s.store
                {
                    let _ = store.set_title(&t.url, &title);
                }
                if s.tabs.active == Some(t.id) {
                    window::set_title(s, t.display_title());
                }
                crate::session::schedule(s);
            });
        }

        fn on_favicon_urlchange(&self, _browser: Option<&mut Browser>, icon_urls: Option<&mut CefStringList>) {
            let icon = string_list(icon_urls).into_iter().next();
            with_tab(self.tab_id, move |s, t| {
                if t.favicon != icon {
                    t.favicon = icon.clone();
                    events::tab_update(s, t.id, json!({ "favicon": icon }));
                }
            });
        }

        fn on_fullscreen_mode_change(&self, _browser: Option<&mut Browser>, fullscreen: i32) {
            let id = self.tab_id;
            state::run(move |s| window::page_fullscreen(s, id, fullscreen != 0));
        }

        fn on_loading_progress_change(&self, _browser: Option<&mut Browser>, progress: f64) {
            with_tab(self.tab_id, move |s, t| {
                t.progress = progress;
                events::tab_update(s, t.id, json!({ "progress": progress }));
            });
        }

        fn on_console_message(
            &self,
            browser: Option<&mut Browser>,
            _level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            let msg = opt_str(message);
            if let Some(color) = msg.strip_prefix("__samo_tc:") {
                let color = sanitize_color(color);
                with_tab(self.tab_id, move |s, t| {
                    if t.theme_color != color {
                        t.theme_color = color.clone();
                        events::tab_update(s, t.id, json!({ "themeColor": color }));
                    }
                });
                return 1;
            }
            if let Some(v) = msg.strip_prefix("__samo_au:") {
                let audible = v == "1";
                with_tab(self.tab_id, move |s, t| {
                    if t.audible != audible {
                        t.audible = audible;
                        events::tab_update(s, t.id, json!({ "audible": audible }));
                    }
                });
                return 1;
            }
            let url = browser.map(|b| browser_url(b)).unwrap_or_default();
            if url.starts_with("samo://") {
                eprintln!("[ui:{}] {msg} ({}:{line})", url, opt_str(source));
            }
            0
        }
    }
}

wrap_load_handler! {
    struct TabLoad {
        tab_id: u32,
    }

    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, is_loading: i32, can_go_back: i32, can_go_forward: i32) {
            with_tab(self.tab_id, move |s, t| {
                t.loading = is_loading != 0;
                t.can_back = can_go_back != 0;
                t.can_forward = can_go_forward != 0;
                if !t.loading {
                    t.progress = 1.0;
                }
                events::tab_update(s, t.id, json!({
                    "loading": t.loading,
                    "canBack": t.can_back,
                    "canForward": t.can_forward,
                    "progress": t.progress,
                }));
            });
        }

        fn on_load_start(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _transition_type: TransitionType) {
            if !is_main(&frame) {
                return;
            }
            with_tab(self.tab_id, |s, t| {
                if t.crashed {
                    t.crashed = false;
                    events::tab_update(s, t.id, json!({ "crashed": false }));
                }
            });
        }

        fn on_load_end(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _http_status_code: i32) {
            if !is_main(&frame) {
                return;
            }
            let Some(b) = browser.cloned() else { return };
            exec_js(&b, PAGE_PROBE_JS);
            let zoom = b.host().map(|h| h.zoom_level()).unwrap_or(0.0);
            with_tab(self.tab_id, move |s, t| {
                if (t.zoom - zoom).abs() > 1e-6 {
                    t.zoom = zoom;
                    events::tab_update(s, t.id, json!({ "zoom": zoom }));
                }
            });
        }

        fn on_load_error(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            if !is_main(&frame) {
                return;
            }
            let code = sys::cef_errorcode_t::from(error_code);
            if code == sys::cef_errorcode_t::ERR_ABORTED {
                return;
            }
            let Some(b) = browser.cloned() else { return };
            let js = error_page_js(code as i32, &opt_str(error_text), &opt_str(failed_url));
            // Let the (empty) error document commit first.
            post_ui_delayed(120, move || exec_js(&b, &js));
        }
    }
}

fn error_page_js(code: i32, text: &str, url: &str) -> String {
    let title = match text {
        "net::ERR_NAME_NOT_RESOLVED" => "This site can’t be reached",
        "net::ERR_INTERNET_DISCONNECTED" => "No internet connection",
        "net::ERR_CONNECTION_REFUSED" => "Connection refused",
        "net::ERR_CONNECTION_TIMED_OUT" | "net::ERR_TIMED_OUT" => "The connection timed out",
        _ => "This page couldn’t load",
    };
    let html = format!(
        "<meta name=color-scheme content='dark light'><title>{t}</title>\
         <style>body{{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;\
         background:Canvas;color:CanvasText}}main{{max-width:560px;padding:24px}}h1{{font-size:22px;font-weight:600}}\
         p{{opacity:.7;word-break:break-all}}code{{opacity:.6}}button{{font:inherit;padding:8px 16px;border-radius:8px;\
         border:1px solid #8884;background:transparent;color:inherit;cursor:pointer}}</style>\
         <main><h1>{t}</h1><p>{u}</p><p><code>{e} ({c})</code></p>\
         <button onclick='location.reload()'>Try again</button></main>",
        t = html_escape(title),
        u = html_escape(url),
        e = html_escape(text),
        c = code
    );
    format!("document.documentElement.innerHTML={};", js_str(&html))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('\'', "&#39;").replace('"', "&quot;")
}

fn opens_tab(d: WindowOpenDisposition) -> Option<bool> {
    // Some(active)
    if d == WindowOpenDisposition::NEW_BACKGROUND_TAB {
        Some(false)
    } else if d == WindowOpenDisposition::NEW_FOREGROUND_TAB
        || d == WindowOpenDisposition::NEW_WINDOW
        || d == WindowOpenDisposition::NEW_POPUP
        || d == WindowOpenDisposition::OFF_THE_RECORD
    {
        Some(true)
    } else {
        None
    }
}

/// Opens `url` in a new tab next to `opener` (used by popups and ctrl/middle clicks).
pub fn open_from(opener: Option<u32>, url: String, active: bool) {
    if url.is_empty() {
        return;
    }
    state::run(move |s| {
        let index = opener.and_then(|o| s.tabs.index_of(o)).map(|i| i + 1);
        tab_ops::new_tab(s, Some(url), active, index);
    });
}

wrap_life_span_handler! {
    struct TabLifeSpan {
        tab_id: u32,
    }

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            let active = opens_tab(target_disposition).unwrap_or(true);
            open_from(Some(self.tab_id), opt_str(target_url), active);
            1
        }

        fn on_after_created(&self, _browser: Option<&mut Browser>) {
            state::browser_created();
        }

        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            // Browsers die with their view (tab close removes it, window close tears all down);
            // returning 0 would make CEF close the whole top-level window.
            1
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            state::browser_closed();
        }
    }
}

wrap_request_handler! {
    struct TabRequest {
        tab_id: u32,
    }

    impl RequestHandler {
        fn on_open_urlfrom_tab(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            target_url: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
        ) -> i32 {
            match opens_tab(target_disposition) {
                Some(active) => {
                    open_from(Some(self.tab_id), opt_str(target_url), active);
                    1
                }
                None => 0,
            }
        }

        fn on_render_process_terminated(
            &self,
            _browser: Option<&mut Browser>,
            _status: TerminationStatus,
            _error_code: i32,
            _error_string: Option<&CefString>,
        ) {
            with_tab(self.tab_id, |s, t| {
                t.crashed = true;
                t.loading = false;
                t.audible = false;
                events::tab_update(s, t.id, json!({ "crashed": true, "loading": false, "audible": false }));
            });
        }
    }
}

wrap_keyboard_handler! {
    struct TabKeys {
        tab_id: u32,
    }

    impl KeyboardHandler {
        fn on_pre_key_event(
            &self,
            _browser: Option<&mut Browser>,
            event: Option<&KeyEvent>,
            _os_event: Option<&mut sys::XEvent>,
            _is_keyboard_shortcut: Option<&mut i32>,
        ) -> i32 {
            keys::on_pre_key_event(Source::Tab(self.tab_id), event)
        }
    }
}

wrap_context_menu_handler! {
    struct TabMenu {
        tab_id: u32,
    }

    impl ContextMenuHandler {
        fn on_before_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
        ) {
            let (Some(params), Some(model)) = (params, model) else { return };
            if !uf(&params.link_url()).is_empty() {
                model.insert_item_at(0, CMD_OPEN_LINK, Some(&cs("Open link in new tab")));
                model.insert_item_at(1, CMD_COPY_LINK, Some(&cs("Copy link address")));
                model.insert_separator_at(2);
            }
            if model.count() > 0 {
                model.add_separator();
            }
            model.add_item(CMD_INSPECT, Some(&cs("Inspect")));
        }

        fn on_context_menu_command(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            command_id: i32,
            _event_flags: EventFlags,
        ) -> i32 {
            let Some(params) = params else { return 0 };
            match command_id {
                CMD_OPEN_LINK => {
                    open_from(Some(self.tab_id), uf(&params.link_url()), false);
                    1
                }
                CMD_COPY_LINK => {
                    let link = uf(&params.link_url());
                    state::run(move |s| actions::copy_text(s, &link));
                    1
                }
                CMD_INSPECT => {
                    if let Some(b) = browser {
                        let at = Point { x: params.xcoord(), y: params.ycoord() };
                        window::show_devtools(b, Some(at));
                    }
                    1
                }
                _ => 0,
            }
        }
    }
}

wrap_download_handler! {
    struct TabDownloads {
        tab_id: u32,
    }

    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _request_method: Option<&CefString>) -> i32 {
            1
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            let (Some(item), Some(cb)) = (download_item, callback.cloned()) else { return 0 };
            let info = downloads::ItemInfo::from_item(item);
            let name = opt_str(suggested_name);
            state::run(move |s| {
                let path = downloads::start(s, &info, &name);
                cb.cont(Some(&cs(&path.to_string_lossy())), 0);
            });
            1
        }

        fn on_download_updated(
            &self,
            _browser: Option<&mut Browser>,
            download_item: Option<&mut DownloadItem>,
            callback: Option<&mut DownloadItemCallback>,
        ) {
            let Some(item) = download_item else { return };
            let info = downloads::ItemInfo::from_item(item);
            let cb = callback.cloned();
            state::run(move |s| downloads::updated(s, info, cb));
        }
    }
}

wrap_permission_handler! {
    struct TabPermissions {
        tab_id: u32,
    }

    impl PermissionHandler {
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            let Some(cb) = callback.cloned() else { return 0 };
            let origin = opt_str(requesting_origin);
            let id = self.tab_id;
            state::run(move |s| {
                let kinds = permissions::media_kinds(requested_permissions);
                let cb = permissions::Callback::Media(cb, requested_permissions);
                permissions::request(s, Some(id), origin, kinds, cb, None);
            });
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            prompt_id: u64,
            requesting_origin: Option<&CefString>,
            requested_permissions: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> i32 {
            let Some(cb) = callback.cloned() else { return 0 };
            let origin = opt_str(requesting_origin);
            let id = self.tab_id;
            state::run(move |s| {
                let kinds = permissions::prompt_kinds(requested_permissions);
                permissions::request(s, Some(id), origin, kinds, permissions::Callback::Prompt(cb), Some(prompt_id));
            });
            1
        }

        fn on_dismiss_permission_prompt(&self, _browser: Option<&mut Browser>, prompt_id: u64, _result: PermissionRequestResult) {
            state::run(move |s| permissions::dismissed(s, prompt_id));
        }
    }
}

wrap_find_handler! {
    struct TabFind {
        tab_id: u32,
    }

    impl FindHandler {
        fn on_find_result(
            &self,
            _browser: Option<&mut Browser>,
            _identifier: i32,
            count: i32,
            _selection_rect: Option<&Rect>,
            active_match_ordinal: i32,
            final_update: i32,
        ) {
            let id = self.tab_id;
            state::run(move |s| {
                if s.tabs.active == Some(id) {
                    events::to_chrome(s, "find:result", json!({
                        "count": count, "active": active_match_ordinal, "final": final_update != 0,
                    }));
                }
            });
        }
    }
}

wrap_focus_handler! {
    struct TabFocus {
        tab_id: u32,
    }

    impl FocusHandler {
        fn on_got_focus(&self, _browser: Option<&mut Browser>) {
            state::run(|s| window::popup_hide(s, true));
        }
    }
}
