//! Samo — a Chromium (CEF) browser with an HTML chrome.

#[macro_use]
mod util;

mod actions;
mod api;
mod app;
mod client;
mod downloads;
mod events;
mod keys;
mod permissions;
mod scheme;
mod session;
mod state;
mod tab_ops;
mod tabs;
mod ui_client;
mod window;

use cef::{args::Args, *};

fn main() {
    let args = Args::new();
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let is_browser = !std::env::args().any(|a| a.starts_with("--type="));
    let cfg = if is_browser {
        match samo_services::Config::load_or_create() {
            Ok(c) => Some(c),
            Err(e) => {
                eprintln!("[samo] config error, using defaults: {e:#}");
                Some(samo_services::Config::default())
            }
        }
    } else {
        None
    };

    let mut cef_app = app::SamoApp::new(cfg.as_ref().map(app::EngineFlags::from_config));
    let ret = execute_process(Some(args.as_main_args()), Some(&mut cef_app), std::ptr::null_mut());
    if ret >= 0 {
        std::process::exit(ret);
    }
    let cfg = cfg.unwrap_or_default();

    let settings = app::settings(&cfg);
    state::set_boot_config(cfg);
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), std::ptr::null_mut()) != 1 {
        // Most likely another Samo instance owns the profile; it got our command line.
        vlog!(info, "CEF initialize returned 0 (already running?) — exiting");
        return;
    }
    run_message_loop();
    vlog!(debug, "message loop finished");
    state::teardown();
    shutdown();
}
