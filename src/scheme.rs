//! `samo://` scheme: UI files, internal pages, theme CSS and the JSON API (ARCHITECTURE §3).
//!
//! Resource handlers run off the UI thread; API calls are posted to the UI thread and the
//! request is continued asynchronously via the CEF callback.

use crate::{api, state, util::*};
use cef::*;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

static UI_DIR: OnceLock<PathBuf> = OnceLock::new();
static THEME: Mutex<String> = Mutex::new(String::new());
const DEFAULT_THEME: &str = "samo-dark";

pub fn set_theme(id: &str) {
    if let Ok(mut t) = THEME.lock() {
        *t = id.to_string();
    }
}

fn current_theme() -> String {
    THEME.lock().map(|t| t.clone()).unwrap_or_default()
}

/// `$SAMO_UI_DIR` → `<exe_dir>/ui` → `CARGO_MANIFEST_DIR/ui`.
pub fn ui_dir() -> &'static Path {
    UI_DIR.get_or_init(|| {
        if let Some(d) = std::env::var_os("SAMO_UI_DIR").map(PathBuf::from).filter(|d| d.is_dir()) {
            return d;
        }
        if let Some(d) = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join("ui")))
            && d.is_dir()
        {
            return d;
        }
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/ui"))
    })
}

pub fn register() {
    vlog!(info, "UI dir: {}", ui_dir().display());
    let mut factory = SamoSchemeFactory::new();
    register_scheme_handler_factory(Some(&cs("samo")), None, Some(&mut factory));
}

#[derive(Default)]
struct Resp {
    status: i32,
    mime: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    offset: usize,
}

impl Resp {
    fn new(status: i32, mime: &str, body: Vec<u8>) -> Self {
        Self { status, mime: mime.into(), body, ..Default::default() }
    }

    fn text(status: i32, msg: &str) -> Self {
        Self::new(status, "text/plain", msg.as_bytes().to_vec())
    }
}

wrap_scheme_handler_factory! {
    struct SamoSchemeFactory {}

    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            let frame_url = frame.map(|f| uf(&f.url())).unwrap_or_default();
            Some(SamoResourceHandler::new(frame_url, Arc::new(Mutex::new(Resp::default()))))
        }
    }
}

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" | "toml" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Joins a URL path under `root`, rejecting traversal.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = percent_decode(rel);
    let mut p = root.to_path_buf();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s if s.contains('\\') || s.contains('\0') => return None,
            s => p.push(s),
        }
    }
    Some(p)
}

fn serve_file(path: Option<PathBuf>) -> Resp {
    let Some(path) = path else { return Resp::text(400, "bad path") };
    match std::fs::read(&path) {
        Ok(body) => Resp::new(200, mime_for(&path.to_string_lossy()), body),
        Err(_) => Resp::text(404, &format!("not found: {}", path.display())),
    }
}

fn serve(host: &str, path: &str) -> Resp {
    let ui = ui_dir();
    match host {
        "ui" => serve_file(safe_join(ui, path)),
        "theme" => match path.trim_start_matches('/') {
            "current.css" => {
                let css = samo_services::themes::css(&current_theme())
                    .or_else(|| samo_services::themes::css(DEFAULT_THEME))
                    .unwrap_or_default();
                Resp::new(200, "text/css", css.into_bytes())
            }
            "user.css" => Resp::new(200, "text/css", samo_services::themes::user_css().into_bytes()),
            other => match other.strip_suffix(".css").map(percent_decode) {
                Some(id) => match samo_services::themes::css(&id) {
                    Some(css) => Resp::new(200, "text/css", css.into_bytes()),
                    None => Resp::text(404, "unknown theme"),
                },
                None => Resp::text(404, "unknown theme resource"),
            },
        },
        h if !h.is_empty() && h.chars().all(|c| c.is_ascii_lowercase() || c == '-') => {
            let pages = ui.join("pages");
            let page = pages.join(format!("{h}.html"));
            let rel = path.trim_start_matches('/');
            // Extension-less paths are client-side routes of the page itself.
            if rel.is_empty() || !rel.rsplit('/').next().unwrap_or("").contains('.') {
                serve_file(Some(page))
            } else {
                serve_file(safe_join(&pages, rel))
            }
        }
        _ => Resp::text(404, "unknown host"),
    }
}

fn request_body(request: &Request) -> Vec<u8> {
    let Some(pd) = request.post_data() else { return Vec::new() };
    let mut elems = vec![None; pd.element_count()];
    pd.elements(Some(&mut elems));
    let mut out = Vec::new();
    for e in elems.into_iter().flatten() {
        let n = e.bytes_count();
        if n == 0 {
            continue;
        }
        let start = out.len();
        out.resize(start + n, 0);
        let got = e.bytes(n, out[start..].as_mut_ptr());
        out.truncate(start + got);
    }
    out
}

/// Splits `samo://host/path?query#frag` into (host, path).
fn split_url(url: &str) -> (String, String) {
    let rest = url.strip_prefix("samo://").unwrap_or(url);
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    match rest.split_once('/') {
        Some((h, p)) => (h.to_ascii_lowercase(), p.to_string()),
        None => (rest.to_ascii_lowercase(), String::new()),
    }
}

wrap_resource_handler! {
    struct SamoResourceHandler {
        frame_url: String,
        resp: Arc<Mutex<Resp>>,
    }

    impl ResourceHandler {
        fn open(
            &self,
            request: Option<&mut Request>,
            handle_request: Option<&mut i32>,
            callback: Option<&mut Callback>,
        ) -> i32 {
            let (Some(request), Some(handle)) = (request, handle_request) else { return 0 };
            let url = uf(&request.url());
            let method = uf(&request.method()).to_ascii_uppercase();
            let origin = uf(&request.header_by_name(Some(&cs("Origin"))));
            let (host, path) = split_url(&url);
            // UI assets and themes are public (module imports, fonts, theme previews); pages and
            // the API only answer samo:// origins.
            let public = host == "ui" || host == "theme";
            let cors: Vec<(String, String)> = if public && origin.is_empty() {
                vec![("Access-Control-Allow-Origin".into(), "*".into())]
            } else if origin.starts_with("samo://") || public {
                vec![
                    ("Access-Control-Allow-Origin".into(), origin.clone()),
                    ("Vary".into(), "Origin".into()),
                ]
            } else {
                Vec::new()
            };
            let set = |mut r: Resp| {
                r.headers.push(("Cache-Control".into(), "no-store".into()));
                r.headers.extend(cors.iter().cloned());
                if let Ok(mut g) = self.resp.lock() {
                    *g = r;
                }
            };

            if host != "api" {
                set(serve(&host, &path));
                *handle = 1;
                return 1;
            }
            if method == "OPTIONS" {
                let mut r = Resp::text(204, "");
                r.headers.push(("Access-Control-Allow-Methods".into(), "POST".into()));
                r.headers.push(("Access-Control-Allow-Headers".into(), "Content-Type".into()));
                set(r);
                *handle = 1;
                return 1;
            }
            if !self.frame_url.starts_with("samo://") {
                vlog!(warn, "rejected API call {path} from {:?}", self.frame_url);
                set(Resp::text(403, "forbidden"));
                *handle = 1;
                return 1;
            }
            if method != "POST" {
                set(Resp::text(405, "POST only"));
                *handle = 1;
                return 1;
            }
            let body = request_body(request);
            let args: Value = if body.iter().all(|b| b.is_ascii_whitespace()) {
                Value::Object(Default::default())
            } else {
                match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        set(Resp::text(400, &format!("bad JSON: {e}")));
                        *handle = 1;
                        return 1;
                    }
                }
            };
            let Some(cb) = callback.cloned() else { return 0 };
            let resp = self.resp.clone();
            let frame_url = self.frame_url.clone();
            let cmd = path.trim_matches('/').to_string();
            post_ui(move || {
                state::run(move |s| {
                    let mut r = match api::dispatch(s, &cmd, args, &frame_url) {
                        Ok(v) => Resp::new(200, "application/json", v.to_string().into_bytes()),
                        Err(e) => {
                            vlog!(debug, "api {cmd} -> {} {}", e.0, e.1);
                            Resp::text(e.0 as i32, &e.1)
                        }
                    };
                    r.headers.push(("Cache-Control".into(), "no-store".into()));
                    r.headers.extend(cors);
                    if let Ok(mut g) = resp.lock() {
                        *g = r;
                    }
                    cb.cont();
                });
            });
            *handle = 0;
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            let Some(response) = response else { return };
            let Ok(r) = self.resp.lock() else { return };
            response.set_status(r.status);
            response.set_status_text(Some(&cs(status_text(r.status))));
            response.set_mime_type(Some(&cs(&r.mime)));
            if r.mime.starts_with("text/") || r.mime.ends_with("json") || r.mime.ends_with("svg+xml") {
                response.set_charset(Some(&cs("utf-8")));
            }
            let mut map = CefStringMultimap::new();
            for (k, v) in &r.headers {
                map.append(k, v);
            }
            response.set_header_map(Some(&mut map));
            if let Some(len) = response_length {
                *len = r.body.len() as i64;
            }
        }

        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: i32,
            bytes_read: Option<&mut i32>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> i32 {
            let Some(bytes_read) = bytes_read else { return 0 };
            *bytes_read = 0;
            let Ok(mut r) = self.resp.lock() else { return 0 };
            let left = r.body.len().saturating_sub(r.offset);
            if left == 0 || bytes_to_read <= 0 || data_out.is_null() {
                return 0;
            }
            let n = left.min(bytes_to_read as usize);
            // SAFETY: CEF guarantees `data_out` has room for `bytes_to_read` bytes.
            unsafe { std::ptr::copy_nonoverlapping(r.body.as_ptr().add(r.offset), data_out, n) };
            r.offset += n;
            *bytes_read = n as i32;
            1
        }
    }
}

fn status_text(code: i32) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    }
}
