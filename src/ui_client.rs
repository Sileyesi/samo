//! CEF client for the chrome and popup UI documents (and a minimal DevTools client).

use crate::{
    client::open_from,
    keys::{self, Source},
    state,
    util::*,
    window::{self, PopupViewDelegate},
};
use cef::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Chrome,
    Popup,
}

impl Role {
    fn source(self) -> Source {
        match self {
            Role::Chrome => Source::Chrome,
            Role::Popup => Source::Popup,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Role::Chrome => "chrome",
            Role::Popup => "popup",
        }
    }
}

pub fn create_view(role: Role, url: &str) -> Option<BrowserView> {
    let mut client = UiClient::new(role);
    let mut delegate = UiViewDelegate::new(role);
    let settings = window::browser_settings(true);
    browser_view_create(Some(&mut client), Some(&cs(url)), Some(&settings), None, None, Some(&mut delegate))
}

pub fn devtools_client() -> Client {
    DevtoolsClient::new()
}

wrap_browser_view_delegate! {
    struct UiViewDelegate {
        role: Role,
    }

    impl ViewDelegate {}

    impl BrowserViewDelegate {
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
            popup_browser_view.map(|v| window::open_aux_window(v.clone())).unwrap_or(0)
        }

        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

wrap_client! {
    struct UiClient {
        role: Role,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> { Some(UiDisplay::new(self.role)) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(UiLifeSpan::new(self.role)) }
        fn keyboard_handler(&self) -> Option<KeyboardHandler> { Some(UiKeys::new(self.role)) }
        fn drag_handler(&self) -> Option<DragHandler> { Some(UiDrag::new(self.role)) }
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> { Some(UiMenu::new(self.role)) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(UiRequest::new(self.role)) }
    }
}

wrap_display_handler! {
    struct UiDisplay {
        role: Role,
    }

    impl DisplayHandler {
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            let lvl = if level == LogSeverity::ERROR {
                "error"
            } else if level == LogSeverity::WARNING {
                "warn"
            } else {
                "log"
            };
            let src = opt_str(source);
            let src = src.rsplit('/').next().unwrap_or("");
            eprintln!("[ui:{}:{lvl}] {} ({src}:{line})", self.role.name(), opt_str(message));
            1
        }
    }
}

wrap_life_span_handler! {
    struct UiLifeSpan {
        role: Role,
    }

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            open_from(None, opt_str(target_url), true);
            1
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            state::browser_created();
            let Some(b) = browser.cloned() else { return };
            let role = self.role;
            state::run(move |s| match role {
                Role::Chrome => s.chrome = Some(b),
                Role::Popup => s.popup_browser = Some(b),
            });
        }

        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            1
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let role = self.role;
            state::run(move |s| match role {
                Role::Chrome => s.chrome = None,
                Role::Popup => s.popup_browser = None,
            });
            state::browser_closed();
        }
    }
}

wrap_keyboard_handler! {
    struct UiKeys {
        role: Role,
    }

    impl KeyboardHandler {
        fn on_pre_key_event(
            &self,
            _browser: Option<&mut Browser>,
            event: Option<&KeyEvent>,
            _os_event: Option<&mut OsEvent>,
            _is_keyboard_shortcut: Option<&mut i32>,
        ) -> i32 {
            keys::on_pre_key_event(self.role.source(), event)
        }
    }
}

wrap_drag_handler! {
    struct UiDrag {
        role: Role,
    }

    impl DragHandler {
        fn on_draggable_regions_changed(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            regions: Option<&[DraggableRegion]>,
        ) {
            if self.role != Role::Chrome {
                return;
            }
            let regions = regions.map(|r| r.to_vec()).unwrap_or_default();
            state::run(move |s| {
                s.drag_regions = regions;
                window::apply_drag_regions(s);
            });
        }
    }
}

wrap_context_menu_handler! {
    struct UiMenu {
        role: Role,
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
            // Keep cut/copy/paste for text fields; no page menu in the chrome otherwise.
            if params.is_editable() == 0 {
                model.clear();
            }
        }
    }
}

wrap_request_handler! {
    struct UiRequest {
        role: Role,
    }

    impl RequestHandler {
        fn on_render_process_terminated(
            &self,
            browser: Option<&mut Browser>,
            _status: TerminationStatus,
            _error_code: i32,
            _error_string: Option<&CefString>,
        ) {
            vlog!(error, "{} UI renderer terminated — reloading", self.role.name());
            if let Some(b) = browser.cloned() {
                post_ui_delayed(500, move || b.reload());
            }
        }
    }
}

wrap_client! {
    struct DevtoolsClient {}

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(CountingLifeSpan::new()) }
    }
}

wrap_life_span_handler! {
    struct CountingLifeSpan {}

    impl LifeSpanHandler {
        fn on_after_created(&self, _browser: Option<&mut Browser>) {
            state::browser_created();
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            state::browser_closed();
        }
    }
}
