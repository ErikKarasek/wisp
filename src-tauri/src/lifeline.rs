//! Wisp keeps the agents going (limit guard, stuck tasks, failing runs), so Wisp itself must not
//! quietly stop. Two ways it could: the process crashes, or the page in the main window (where those
//! watchers run) dies or hangs while the process lives on.
//!
//! - The login item gets `KeepAlive` for unsuccessful exits: launchd starts Wisp again after a crash,
//!   but not after Quit (exit 0). The autostart plugin writes the plist without it and may rewrite it,
//!   so it is added back on every start; launchd reads it at the next load (login, or a bootstrap).
//! - The main page pings every minute. No ping for 15 minutes while the Mac was awake → reload it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const PLIST: &str = "Library/LaunchAgents/Wisp.plist";
const KEEP_ALIVE: &str = "  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key>\n  <integer>30</integer>\n";

/// Adds `KeepAlive` to the login item when it is there and lacks it.
pub fn ensure_keep_alive() {
    let path = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(PLIST);
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    if text.contains("<key>KeepAlive</key>") {
        return;
    }
    // Before the line holding the last </dict>, so the indentation stays as it was.
    let Some(dict) = text.rfind("</dict>") else { return };
    let at = text[..dict].rfind('\n').map_or(0, |n| n + 1);
    let patched = format!("{}{KEEP_ALIVE}{}", &text[..at], &text[at..]);
    let tmp = path.with_extension("plist.tmp");
    if std::fs::write(&tmp, patched).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

static LAST_PING: AtomicU64 = AtomicU64::new(0);
const TICK: u64 = 60;
const SILENCE: u64 = 15 * 60;

/// The main page is alive.
pub fn ping() {
    LAST_PING.store(now(), Ordering::Relaxed);
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last_tick = now();
        loop {
            std::thread::sleep(Duration::from_secs(TICK));
            let t = now();
            // The Mac slept: the page had no chance to ping, so its silence means nothing yet.
            if t.saturating_sub(last_tick) > 3 * TICK {
                LAST_PING.store(t, Ordering::Relaxed);
            }
            last_tick = t;
            let last = LAST_PING.load(Ordering::Relaxed);
            // Not pinged yet: the page is still loading after start.
            if last == 0 || t.saturating_sub(last) < SILENCE {
                continue;
            }
            // Counted from now, so a page that stays dead is reloaded every 15 minutes, not every tick.
            LAST_PING.store(t, Ordering::Relaxed);
            if let Some(w) = app.get_webview_window("main") {
                eprintln!("lifeline: main page silent for {} s, reloading", t - last);
                let _ = w.reload();
            }
        }
    });
}
