//! Tab model: stable ids, order, pinned block, active tab, closed-tab stack.
//! Pure bookkeeping — view/browser operations live in `window.rs`.

use crate::util::security_of;
use cef::*;
use serde_json::{Value, json};

pub struct Tab {
    pub id: u32,
    /// `None` until the tab is first shown (lazy restore).
    pub view: Option<BrowserView>,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub loading: bool,
    pub progress: f64,
    pub can_back: bool,
    pub can_forward: bool,
    pub pinned: bool,
    pub muted: bool,
    pub audible: bool,
    pub theme_color: Option<String>,
    pub zoom: f64,
    pub crashed: bool,
}

impl Tab {
    pub fn new(id: u32, url: &str) -> Self {
        Self {
            id,
            view: None,
            url: url.to_string(),
            title: String::new(),
            favicon: None,
            loading: false,
            progress: 0.0,
            can_back: false,
            can_forward: false,
            pinned: false,
            muted: false,
            audible: false,
            theme_color: None,
            zoom: 0.0,
            crashed: false,
        }
    }

    pub fn browser(&self) -> Option<Browser> {
        self.view.as_ref()?.browser()
    }

    pub fn host(&self) -> Option<BrowserHost> {
        self.browser()?.host()
    }

    pub fn display_title(&self) -> &str {
        if self.title.is_empty() { &self.url } else { &self.title }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "url": self.url,
            "title": self.display_title(),
            "favicon": self.favicon,
            "loading": self.loading,
            "progress": self.progress,
            "canBack": self.can_back,
            "canForward": self.can_forward,
            "pinned": self.pinned,
            "muted": self.muted,
            "audible": self.audible,
            "themeColor": self.theme_color,
            "zoom": self.zoom,
            "crashed": self.crashed,
            "secure": security_of(&self.url),
        })
    }
}

pub struct ClosedTab {
    pub url: String,
    pub index: usize,
    pub pinned: bool,
}

#[derive(Default)]
pub struct TabManager {
    pub tabs: Vec<Tab>,
    pub active: Option<u32>,
    pub closed: Vec<ClosedTab>,
    next_id: u32,
}

const MAX_CLOSED: usize = 25;

impl TabManager {
    pub fn alloc_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    pub fn len(&self) -> usize {
        self.tabs.len()
    }

    pub fn get(&self, id: u32) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.id == id)
    }

    pub fn index_of(&self, id: u32) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        self.active.and_then(|id| self.get(id))
    }

    pub fn pinned_count(&self) -> usize {
        self.tabs.iter().take_while(|t| t.pinned).count()
    }

    /// Clamps `index` into the range allowed for a tab with the given pinned state.
    pub fn clamp_index(&self, index: usize, pinned: bool, len_without: usize) -> usize {
        let pc = self.tabs.iter().filter(|t| t.pinned).count();
        if pinned { index.min(pc) } else { index.clamp(pc.min(len_without), len_without) }
    }

    /// Inserts `tab` at `index` (clamped to respect the pinned block); returns the final index.
    pub fn insert(&mut self, tab: Tab, index: usize) -> usize {
        let i = self.clamp_index(index, tab.pinned, self.tabs.len());
        self.tabs.insert(i, tab);
        i
    }

    /// Moves a tab; returns the final index if it changed.
    pub fn move_to(&mut self, id: u32, index: usize) -> Option<usize> {
        let from = self.index_of(id)?;
        let tab = self.tabs.remove(from);
        let pinned = tab.pinned;
        let pc = self.tabs.iter().filter(|t| t.pinned).count();
        let to = if pinned { index.min(pc) } else { index.clamp(pc, self.tabs.len()) };
        self.tabs.insert(to, tab);
        (to != from).then_some(to)
    }

    pub fn remove(&mut self, id: u32) -> Option<(usize, Tab)> {
        let i = self.index_of(id)?;
        let tab = self.tabs.remove(i);
        if is_restorable(&tab.url) {
            self.closed.push(ClosedTab { url: tab.url.clone(), index: i, pinned: tab.pinned });
            if self.closed.len() > MAX_CLOSED {
                self.closed.remove(0);
            }
        }
        Some((i, tab))
    }

    /// The tab to activate after closing the tab that was at `index`.
    pub fn successor(&self, index: usize) -> Option<u32> {
        self.tabs.get(index).or_else(|| self.tabs.last()).map(|t| t.id)
    }
}

fn is_restorable(url: &str) -> bool {
    !url.is_empty() && url != "about:blank"
}
