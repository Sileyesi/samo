# Samo — architecture & contracts

Chromium (CEF 154.0.34) browser in Rust. Horizontal tabs, Zen-level motion, deep CSS customization.
UX spec with numbers: `docs/ANALYSIS.md` (sections referenced as §N).

## 0. Hard facts learned in the spike (do not re-discover)

- Crate: `cef = "=154.5.0"` (matches CEF 154.0.34). Docs: the crate source is in
  `~/.cargo/registry/src/index.crates.io-*/cef-154.5.0+154.0.34/` (generated bindings in
  `src/bindings/x86_64_unknown_linux_gnu.rs` — grep there for method names/signatures).
  Reference examples (READ ONLY, do not build): `/tmp/claude-1000/-/8ac99ea9-733e-453c-a04a-788fa69624c2/scratchpad/cef-rs/examples/`.
- Build env: `export PATH=$HOME/Projects/samo/.tools/bin:$PATH CEF_PATH=$HOME/.local/share/cef`
  (cmake+ninja live in `.tools`). CEF runtime files: `$CEF_PATH/154.0.34/cef_linux_x86_64/`.
  Run via `scripts/run.sh` (symlinks CEF runtime into target dir, sets LD_LIBRARY_PATH).
- Wrapper macros (`wrap_client!`, `wrap_window_delegate!`, …) need brace structs: `struct X {}` not `struct X;`.
- **Only ONE Chrome-style BrowserView per window.** All BrowserViews (UI + tabs) must be
  `RuntimeStyle::ALLOY` via `BrowserViewDelegate::browser_runtime_style`.
- Overlays: `window.add_overlay_view(view, DockingMode::CUSTOM, can_activate)` then
  `controller.set_bounds(rect)` + `set_visible(1)` AFTER `window.show()`. `TOP_LEFT` docking ignored bounds.
- **No transparency** for windowed BrowserViews (bg alpha 0 → white). Overlays are opaque rectangles.
  Design popups as solid rectangular panels that fill their surface edge-to-edge.
- Screenshot only the Samo window: `scripts/shot.sh out.png` (niri+grim). Never screenshot the whole screen.

## 1. Repository layout & ownership

```
Cargo.toml            workspace + bin `samo`                       (rust-core)
build.rs              rpath etc.                                   (rust-core)
src/                  CEF app: windows, views, tabs, handlers,     (rust-core)
                      scheme handler, API dispatch, key handling
crates/services/      lib `samo-services` — NO CEF dependency:     (rust-services)
                      paths, config, themes, store (history+bookmarks),
                      session, omnibox (fixup+suggest), keys
themes/*.css          built-in themes (embedded via include_str)   (ui-pages)
ui/shared/bridge.js   JS<->Rust bridge — FROZEN contract           (lead)
ui/shared/tokens.css  all --samo-* defaults, density, motion       (ui-pages)
ui/shared/base.css    resets, fonts, focus ring, scrollbars        (ui-pages)
ui/shared/icons.js    inline SVG icon set (lucide-style, 16px)     (ui-pages)
ui/chrome.html|css|js tab strip, toolbar, urlbar, find bar, etc.   (ui-chrome)
ui/popup.html|css|js  popup surface: suggestions, menus, palette   (ui-chrome)
ui/pages/*            samo://newtab, settings, history, downloads   (ui-pages)
docs/                 docs
```

## 2. Window composition (CEF Views)

```
Window (frameless if config ui.frameless)
 ├─ root Panel, BoxLayout vertical
 │   ├─ spacer Panel        height = `reserve` px (from ui.layout)   flex 0
 │   └─ content Panel       BoxLayout horizontal                     flex 1
 │        └─ tab BrowserViews (ALLOY); only the active one (or the 2 split panes) visible
 ├─ overlay "chrome"  BrowserView samo://ui/chrome.html, CUSTOM docking,
 │                    bounds = (0,0,windowWidth, `overlay` px), always visible
 └─ overlay "popup"   BrowserView samo://ui/popup.html, CUSTOM docking, hidden by default,
                      bounds set by popup.show
```
- Normal mode: UI calls `ui.layout {reserve: H, overlay: H}` → page sits below the chrome.
- Compact mode: `ui.layout {reserve: 0, overlay: 4}` → 4px hot strip over the page; on hover the UI
  calls `ui.layout {reserve: 0, overlay: H}` (chrome floats over the page, no reflow), then animates in
  with CSS. To hide: animate out first, then shrink overlay. Find bar open: UI just increases H.
- Rust re-applies chrome overlay bounds on window resize (`on_layout_changed` / `ViewDelegate`), keeps
  popup inside window bounds.
- Frameless drag: chrome client implements `DragHandler::on_draggable_regions_changed` →
  `window.set_draggable_regions(...)` (UI marks drag areas with `-webkit-app-region: drag`, buttons `no-drag`).
- Hidden tabs stay alive; switching = toggling `set_visible` + layout + focus the browser.

## 3. Schemes & pages

Custom scheme `samo` registered (in `App::on_register_custom_schemes`, all processes) with
STANDARD | SECURE | CORS_ENABLED | FETCH_ENABLED.

| URL | Served from |
|---|---|
| `samo://ui/<path>` | `ui/<path>` |
| `samo://newtab/`, `samo://settings/`, `samo://history/`, `samo://downloads/` | `ui/pages/<host>.html` (+ `samo://<host>/<file>` → `ui/pages/<file>`) |
| `samo://theme/current.css` | CSS of the theme selected by `ui.theme` (user theme dir overrides built-in) |
| `samo://theme/user.css` | `~/.config/samo/user.css` (empty if missing) |
| `samo://api/<cmd>` | API (POST, body = JSON text). Response JSON. |

UI dir resolution: `$SAMO_UI_DIR` → `<exe_dir>/ui` → compile-time `CARGO_MANIFEST_DIR/ui`. Files are read
from disk on every request (so editing UI files + reload works) with `Cache-Control: no-store`.

**API security:** accept only if the requesting frame URL starts with `samo://` (chrome, popup, internal
pages). Web pages can *send* simple cross-origin POSTs, so this server-side check is mandatory.
Reply with `Access-Control-Allow-Origin: <origin>` when origin is `samo://…`.

## 4. JS ↔ Rust protocol

JS side lives in `ui/shared/bridge.js` (see file): `samo.call(cmd, args) → Promise<result>`,
`samo.on(event, fn)`. Errors: HTTP 4xx/5xx with text body → Promise rejects.
Rust → JS: `frame.execute_java_script("window.__samoDispatch && window.__samoDispatch(<event json>, <payload json>)")`
on the chrome browser (and popup / internal pages where noted).

### 4.1 Tab object (as sent to UI)
```json
{ "id": 3, "url": "https://…", "title": "…", "favicon": "https://…/favicon.ico" | null,
  "loading": true, "progress": 0.42, "canBack": true, "canForward": false,
  "pinned": false, "muted": false, "audible": false, "themeColor": "#1e66f5" | null,
  "zoom": 0.0, "crashed": false, "secure": "https" | "http" | "internal" | "file" }
```
`id` is a stable u32 assigned by Rust (not the CEF browser id).

### 4.2 Commands (JS → Rust). Default target tab = active tab when `id` omitted.
| cmd | args | result |
|---|---|---|
| `state.get` | – | `{tabs:[Tab], activeId, window:{maximized,fullscreen}, config, compact, split:{ids,orientation}\|null, platform:{os}}` |
| `tab.new` | `{url?, active?=true, index?}` (url omitted → `general.newtab_url`) | `{id}` |
| `tab.close` | `{id?}` | `{}` |
| `tab.activate` | `{id}` | `{}` |
| `tab.move` | `{id, index}` | `{}` |
| `tab.pin` | `{id?, pinned}` | `{}` |
| `tab.mute` | `{id?, muted}` | `{}` |
| `tab.duplicate` | `{id?}` | `{id}` |
| `tab.reopenClosed` | – | `{id}\|{}` |
| `nav.go` | `{id?, input, newTab?}` — Rust fixes up URL vs search | `{url}` |
| `nav.back` / `nav.forward` / `nav.reload` / `nav.reloadHard` / `nav.stop` | `{id?}` | `{}` |
| `zoom.change` | `{id?, delta?: ±1, reset?: bool}` | `{zoom}` |
| `find.start` | `{text, forward=true, matchCase=false, findNext=false}` | `{}` (result via event) |
| `find.stop` | `{clear=true}` | `{}` |
| `ui.layout` | `{reserve, overlay}` px (CSS px of the chrome view) | `{}` |
| `ui.ready` | – (chrome finished init; Rust may now show the window) | `{}` |
| `popup.show` | `{kind, rect:{x,y,w,h}, data, focus?:false}` rect in chrome-view coords | `{}` |
| `popup.update` | `{data}` | `{}` |
| `popup.hide` | – | `{}` |
| `popup.pick` | `{payload}` (sent BY popup) → forwarded to chrome as `popup:pick` | `{}` |
| `popup.resize` | `{h}` (sent by popup to fit content) | `{}` |
| `window.minimize` / `window.toggleMaximize` / `window.close` / `window.toggleFullscreen` | – | `{}` |
| `window.new` | – | `{}` |
| `suggest` | `{query, limit?}` | `{items:[Suggestion]}` |
| `history.list` | `{query?, limit?=100, offset?}` | `{items:[{url,title,lastVisit,visits}]}` |
| `history.delete` | `{url}` / `history.clear` | `{}` |
| `bookmarks.toggle` | `{url, title}` | `{bookmarked}` |
| `bookmarks.list` | – | `{items:[{url,title,added}]}` |
| `bookmarks.isBookmarked` | `{url}` | `{bookmarked}` |
| `config.get` | – | `{config, path, defaults}` |
| `config.set` | `{key:"ui.density", value}` (dotted path) | `{config}` |
| `config.openFile` | – opens config.toml in a tab as file:// or via xdg-open | `{}` |
| `theme.list` | – | `{items:[{id,name,scheme:"dark"\|"light",builtin}]}` |
| `theme.reload` | – | `{}` |
| `keys.list` | – | `{items:[{action, accel, label}]}` |
| `downloads.list` | – | `{items:[Download]}` |
| `downloads.open` / `downloads.showInFolder` / `downloads.cancel` | `{id}` | `{}` |
| `permission.respond` | `{reqId, allow}` | `{}` |
| `devtools.open` | `{id?}` | `{}` |
| `app.quit` | – | `{}` |
| `app.action` | `{action}` — run any key action by name (§6) | `{}` |
| `compact.set` | `{enabled}` | `{}` |
| `split.set` | `{ids:[a,b], orientation:"vertical"\|"horizontal"}` or `{ids:null}` | `{}` |

Suggestion: `{type:"tab"|"history"|"bookmark"|"search"|"url"|"command", title, url?, tabId?, action?, score}`.
Download: `{id, name, url, path, received, total, speed, state:"progress"|"complete"|"cancelled"|"interrupted"}`.

### 4.3 Events (Rust → chrome UI unless noted)
| event | payload |
|---|---|
| `tabs:created` | `{tab, index, active}` |
| `tabs:updated` | `{id, …changed fields}` |
| `tabs:closed` | `{id}` |
| `tabs:activated` | `{id}` |
| `tabs:moved` | `{id, index}` |
| `tabs:sync` | `{tabs, activeId}` (full resync, e.g. after restore) |
| `command` | `{action, args?}` — key actions the UI must handle: `focus-urlbar`, `open-palette`, `command-palette`, `search-tabs`, `find`, `find-next`, `find-prev`, `toggle-compact`, `copy-url`, `copy-url-markdown`, `escape` |
| `window:state` | `{maximized, fullscreen, focused}` |
| `config:changed` | `{config}` (also to popup + internal pages) |
| `theme:changed` | `{}` (also to popup + internal pages) — reload theme `<link>`s |
| `find:result` | `{count, active, final}` |
| `download:updated` | `Download` (also to samo://downloads pages) |
| `permission:request` | `{reqId, origin, kinds:["camera","microphone","geolocation","notifications",…]}` |
| `popup:pick` | `{payload}` |
| `popup:hidden` | `{}` (popup closed by Rust, e.g. click outside / resize / tab switch) |
| `toast` | `{text, kind?:"info"\|"error"}` |
| popup only: `popup:data` | `{kind, data}` (on show and update) |

## 5. Config — `~/.config/samo/config.toml`
Created with defaults on first run (commented). JSON form = same keys. Unknown keys preserved where feasible.
```toml
[general]
startup = "restore"            # restore | newtab | homepage
homepage = "samo://newtab/"
newtab_url = "samo://newtab/"
search_engine = "duckduckgo"   # key in [search.engines]
downloads_dir = "~/Downloads"

[search.engines]
duckduckgo = "https://duckduckgo.com/?q={q}"
google     = "https://www.google.com/search?q={q}"
brave      = "https://search.brave.com/search?q={q}"
bing       = "https://www.bing.com/search?q={q}"
yandex     = "https://yandex.ru/search/?text={q}"

[ui]
theme = "samo-dark"            # theme id (file stem)
density = "normal"             # normal | compact
accent = "page"                # page | theme | "#rrggbb"
page_tint_strength = 0.6       # 0..1
reduce_motion = false
animation_speed = 1.0          # duration multiplier (0.5 = 2x faster)
font_ui = ""                   # "" = system-ui
content_inset = 0              # px, "card" look when > 0
frameless = true
window_controls = "right"      # right | left | none

[tabs]
max_width = 240
min_width = 44
close_button = "hover"         # always | hover | active
indicator = "card"             # card | underline
hide_throbber = false
new_tab_position = "after-current"   # after-current | end
close_window_with_last_tab = false

[compact]
enabled = false
hide_delay_ms = 1000

[urlbar]
ctrl_t = "palette"             # palette | newtab
show_full_url = false
max_suggestions = 8

[engine]
ozone_platform = "auto"        # auto | wayland | x11
smooth_scrolling = true
gpu_rasterization = true
user_agent = ""
extra_flags = []               # e.g. ["--enable-features=VaapiVideoDecoder"]

[keys]                         # action = "accelerator"; overrides defaults (§6)
# "toggle-compact" = "ctrl+alt+c"
```

## 6. Key actions
Accelerator syntax: `ctrl+shift+alt+meta+<key>`; key names: `a`-`z`, `0`-`9`, `f1`-`f12`, `tab`, `pageup`,
`pagedown`, `left`, `right`, `up`, `down`, `escape`, `enter`, `plus`, `minus`, `comma`, `period`, `delete`,
`backspace`, `home`, `end`, `space`. One action may have several accels (TOML value may be a string or array).
Rust intercepts in `KeyboardHandler::on_pre_key_event` for ALL browsers (chrome, popup, tabs).
Actions handled natively in Rust: `new-tab` (→ if urlbar.ctrl_t=palette emits `command open-palette`),
`close-tab`, `reopen-closed-tab`, `next-tab`, `prev-tab`, `select-tab-1`..`select-tab-8`, `select-last-tab`,
`move-tab-left`, `move-tab-right`, `reload`, `hard-reload`, `stop`, `back`, `forward`, `zoom-in`, `zoom-out`,
`zoom-reset`, `fullscreen`, `devtools`, `view-source`, `print`, `bookmark`, `history`, `downloads`, `settings`,
`pin-tab`, `mute-tab`, `duplicate-tab`, `new-window`, `close-window`, `reload-theme`, `quit`,
`split-vertical`, `split-horizontal`, `unsplit`.
Forwarded to UI as `command`: `focus-urlbar`, `open-palette`, `command-palette`, `search-tabs`, `find`,
`find-next`, `find-prev`, `toggle-compact`, `copy-url`, `copy-url-markdown`, `escape` (only when a popup is open).
Defaults per ANALYSIS §5 (Ctrl+T new-tab, Ctrl+L/Alt+D/F6 focus-urlbar, Ctrl+K command-palette, …).

## 7. `samo-services` API (crates/services) — no CEF, unit-tested
```rust
pub mod paths   { config_dir() data_dir() profile_dir() themes_dir() user_css() config_file() session_file() db_file() }
pub mod config  { #[derive(Serialize,Deserialize,Clone,Default)] pub struct Config{…§5…}
                  Config::load_or_create() -> anyhow::Result<Config>
                  Config::save(&self) -> Result<()>
                  Config::to_json(&self) -> serde_json::Value
                  Config::set_key(&mut self, dotted:&str, v:serde_json::Value) -> Result<()>
                  Config::default_json() -> serde_json::Value
                  Config::search_url(&self, query:&str) -> String }
pub mod watch   { pub enum Change{Config, Theme, UserCss}
                  pub fn watch(f: impl Fn(Change)+Send+'static) -> Result<Watcher> }  // debounced 100ms
pub mod themes  { pub struct ThemeInfo{id,name,scheme,builtin}
                  list() -> Vec<ThemeInfo>; css(id:&str) -> Option<String>; user_css() -> String }
pub mod store   { pub struct Store  // sqlite (rusqlite bundled), history + bookmarks
                  Store::open(path) -> Result<Store>
                  record_visit(&self,url,title); set_title(&self,url,title)
                  history(&self, query:Option<&str>, limit, offset) -> Vec<HistoryEntry>
                  delete_history(&self,url); clear_history(&self)
                  frecency_search(&self, q, limit) -> Vec<HistoryEntry>
                  toggle_bookmark(&self,url,title)->bool; is_bookmarked(&self,url)->bool; bookmarks(&self)->Vec<Bookmark> }
pub mod session { #[derive(Serialize,Deserialize)] pub struct Session{tabs:Vec<SessionTab>, active:usize}
                  pub struct SessionTab{url,title,pinned,muted}
                  load() -> Option<Session>; save(&Session) -> Result<()> /* atomic write */ }
pub mod omnibox { pub fn fixup(input:&str, cfg:&Config) -> String   // url or search url
                  pub struct OpenTab{id:u32,url,title}
                  pub fn suggest(q:&str, tabs:&[OpenTab], store:&Store, cfg:&Config, limit) -> Vec<Suggestion> }
pub mod keys    { pub struct Accel{ctrl,shift,alt,meta,key:String}
                  Accel::parse(&str)->Option<Accel>; Accel::to_string
                  pub fn default_bindings() -> Vec<(String /*action*/, Vec<Accel>)>
                  pub fn bindings(cfg:&Config) -> Keymap; Keymap::lookup(&Accel)->Option<&str>
                  Keymap::list() -> Vec<(action, accels, label)> }
```
`Store` is used from the CEF UI thread only (no Send requirement beyond that).

## 8. UI conventions
- Every UI document includes, in order: `samo://ui/shared/tokens.css`, `samo://ui/shared/base.css`,
  `<link id="samo-theme" href="samo://theme/current.css">`, own CSS, `<link id="samo-user" href="samo://theme/user.css">`,
  and `<script type="module">` importing `samo://ui/shared/bridge.js`. `bridge.js` handles theme hot-reload and
  writes config-driven attributes on `<html>`: `data-density`, `data-reduce-motion`, `data-indicator`,
  `data-close-button`, `data-compact`, and CSS vars `--samo-anim-speed`.
- Only animate transform/opacity (plus `width` of tabs via FLIP when unavoidable). Respect
  `[data-reduce-motion="true"]` and `prefers-reduced-motion`.
- Stable selectors for user.css: `.samo-tab`, `[active]`, `[pinned]`, `[loading]`, `[audible]`, `[muted]`,
  `.samo-tabstrip`, `.samo-toolbar`, `.samo-urlbar`, `.samo-btn`, `.samo-popup`, `.samo-palette`.
- No external network resources (fonts/icons) — everything local. System font stack:
  `system-ui, "Inter", "Segoe UI", Roboto, sans-serif`.
