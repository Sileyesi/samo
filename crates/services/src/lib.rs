//! Samo services: config, themes, history/bookmarks store, session, omnibox, keys. No CEF here.

pub mod config;
pub mod keys;
pub mod omnibox;
pub mod paths;
pub mod session;
pub mod store;
pub mod themes;
pub mod watch;

pub use config::Config;
