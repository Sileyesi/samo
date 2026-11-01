//! CEF App: command line, custom scheme registration, browser-process startup.

use crate::{scheme, state, util::*, window};
use cef::*;
use samo_services::{Config, paths};

/// Window background (dark theme base) used everywhere to avoid white flashes.
pub const BG_COLOR: u32 = 0xFF1E1E22;

/// Engine-related command line switches derived from the config (browser process only).
#[derive(Clone, Default)]
pub struct EngineFlags {
    ozone: Option<String>,
    smooth_scrolling: bool,
    gpu_rasterization: bool,
    extra: Vec<String>,
}

impl EngineFlags {
    pub fn from_config(cfg: &Config) -> Self {
        let e = &cfg.engine;
        let ozone = if !cfg!(target_os = "linux") {
            None
        } else {
            match e.ozone_platform.as_str() {
                "wayland" => Some("wayland".to_string()),
                "x11" => Some("x11".to_string()),
                _ => std::env::var_os("WAYLAND_DISPLAY").map(|_| "wayland".to_string()),
            }
        };
        Self {
            ozone,
            smooth_scrolling: e.smooth_scrolling,
            gpu_rasterization: e.gpu_rasterization,
            extra: e.extra_flags.clone(),
        }
    }
}

pub fn settings(cfg: &Config) -> Settings {
    let profile = paths::profile_dir();
    let profile = profile.to_string_lossy();
    let locale = std::env::var("LC_ALL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("LANG").ok())
        .and_then(|l| {
            let l = l.split(['.', '@']).next()?.replace('_', "-");
            (!l.is_empty() && l != "C" && l != "POSIX").then_some(l)
        })
        .unwrap_or_default();
    Settings {
        no_sandbox: 1,
        root_cache_path: cs(&profile),
        cache_path: cs(&profile),
        persist_session_cookies: 1,
        locale: cs(&locale),
        user_agent: cs(&cfg.engine.user_agent),
        background_color: BG_COLOR,
        log_severity: if log_level() >= 3 { LogSeverity::INFO } else { LogSeverity::ERROR },
        ..Default::default()
    }
}

wrap_app! {
    pub struct SamoApp {
        flags: Option<EngineFlags>,
    }

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let (Some(flags), Some(cl)) = (self.flags.as_ref(), command_line) else { return };
            if !opt_str(process_type).is_empty() {
                return;
            }
            let has = |name: &str| cl.has_switch(Some(&cs(name))) != 0;
            if let Some(ozone) = &flags.ozone
                && !has("ozone-platform")
            {
                cl.append_switch_with_value(Some(&cs("ozone-platform")), Some(&cs(ozone)));
                if ozone == "wayland" {
                    cl.append_switch(Some(&cs("enable-wayland-ime")));
                }
            }
            cl.append_switch(Some(&cs(if flags.smooth_scrolling {
                "enable-smooth-scrolling"
            } else {
                "disable-smooth-scrolling"
            })));
            if flags.gpu_rasterization {
                cl.append_switch(Some(&cs("enable-gpu-rasterization")));
            }
            for f in &flags.extra {
                let f = f.trim().trim_start_matches('-');
                if f.is_empty() {
                    continue;
                }
                match f.split_once('=') {
                    Some((k, v)) => cl.append_switch_with_value(Some(&cs(k)), Some(&cs(v))),
                    None => cl.append_switch(Some(&cs(f))),
                }
            }
        }

        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            use sys::cef_scheme_options_t as O;
            let Some(r) = registrar else { return };
            let opts = O::CEF_SCHEME_OPTION_STANDARD as i32
                | O::CEF_SCHEME_OPTION_SECURE as i32
                | O::CEF_SCHEME_OPTION_CORS_ENABLED as i32
                | O::CEF_SCHEME_OPTION_FETCH_ENABLED as i32;
            r.add_custom_scheme(Some(&cs("samo")), opts);
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(SamoBrowserProcessHandler::new())
        }
    }
}

wrap_browser_process_handler! {
    struct SamoBrowserProcessHandler {}

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            scheme::register();
            state::init();
            window::create_main_window();
        }

        fn on_already_running_app_relaunch(
            &self,
            command_line: Option<&mut CommandLine>,
            _current_directory: Option<&CefString>,
        ) -> i32 {
            let mut urls = Vec::new();
            if let Some(cl) = command_line {
                let mut list = CefStringList::new();
                cl.arguments(Some(&mut list));
                urls = list.into_iter().collect();
            }
            state::run(move |s| window::open_external(s, urls));
            1
        }
    }
}
