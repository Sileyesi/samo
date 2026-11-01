//! Small helpers: logging, CEF string conversion, UI-thread tasks.

use cef::*;
use std::sync::{Arc, Mutex, OnceLock};

/// Log level from `SAMO_LOG` (error < warn < info < debug). Default: info.
pub fn log_level() -> u8 {
    static LEVEL: OnceLock<u8> = OnceLock::new();
    *LEVEL.get_or_init(|| match std::env::var("SAMO_LOG").as_deref() {
        Ok("debug") | Ok("trace") => 3,
        Ok("warn") => 1,
        Ok("error") => 0,
        _ => 2,
    })
}

macro_rules! vlog {
    (error, $($t:tt)*) => { eprintln!("[samo:error] {}", format!($($t)*)) };
    (warn, $($t:tt)*) => { if $crate::util::log_level() >= 1 { eprintln!("[samo:warn] {}", format!($($t)*)) } };
    (info, $($t:tt)*) => { if $crate::util::log_level() >= 2 { eprintln!("[samo] {}", format!($($t)*)) } };
    (debug, $($t:tt)*) => { if $crate::util::log_level() >= 3 { eprintln!("[samo:debug] {}", format!($($t)*)) } };
}

pub fn cs(s: &str) -> CefString {
    CefString::from(s)
}

/// A string whose buffer ownership passes to CEF when stored into a CEF out-param struct
/// (the crate's by-value conversion drops owned strings).
pub fn cs_transfer(s: &str) -> CefString {
    // SAFETY: zeroed is a valid empty cef_string; the conversion allocates and sets `dtor`.
    let mut raw: sys::_cef_string_utf16_t = unsafe { std::mem::zeroed() };
    unsafe { sys::cef_string_utf8_to_utf16(s.as_ptr().cast(), s.len(), &mut raw) };
    CefString::from(raw)
}

pub fn opt_str(s: Option<&CefString>) -> String {
    s.map(|s| s.to_string()).unwrap_or_default()
}

pub fn uf(s: &CefStringUserfree) -> String {
    CefString::from(s).to_string()
}

pub fn string_list(list: Option<&mut CefStringList>) -> Vec<String> {
    list.map(|l| std::mem::take(l).into_iter().collect()).unwrap_or_default()
}

pub fn browser_url(b: &Browser) -> String {
    b.main_frame().map(|f| uf(&f.url())).unwrap_or_default()
}

/// Runs JS in the main frame of `b`.
pub fn exec_js(b: &Browser, code: &str) {
    if let Some(f) = b.main_frame() {
        f.execute_java_script(Some(&cs(code)), Some(&cs("")), 0);
    }
}

/// JSON-encodes a string for safe embedding in JS source.
pub fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

type BoxedFn = Box<dyn FnOnce() + Send>;

wrap_task! {
    struct FnTask {
        f: Arc<Mutex<Option<BoxedFn>>>,
    }

    impl Task {
        fn execute(&self) {
            let f = self.f.lock().ok().and_then(|mut g| g.take());
            if let Some(f) = f {
                f();
            }
        }
    }
}

fn task(f: impl FnOnce() + Send + 'static) -> Task {
    FnTask::new(Arc::new(Mutex::new(Some(Box::new(f)))))
}

/// Posts `f` to the CEF UI thread.
pub fn post_ui(f: impl FnOnce() + Send + 'static) {
    post_task(ThreadId::UI, Some(&mut task(f)));
}

/// Posts `f` to the CEF UI thread after `ms` milliseconds.
pub fn post_ui_delayed(ms: i64, f: impl FnOnce() + Send + 'static) {
    post_delayed_task(ThreadId::UI, Some(&mut task(f)), ms);
}

/// URL scheme classification used for the tab `secure` field.
pub fn security_of(url: &str) -> &'static str {
    let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
    match scheme.as_str() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        "file" => "file",
        _ => "internal",
    }
}

/// Whether a URL should be recorded in history.
pub fn is_recordable(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file://")
}

/// Opens a path/URL with the desktop default handler (`xdg-open` / Explorer).
pub fn open_external(target: &str) {
    let opener = if cfg!(windows) { "explorer" } else { "xdg-open" };
    if let Err(e) = std::process::Command::new(opener)
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        vlog!(warn, "{opener} {target}: {e}");
    }
}
