//! The mascot that lives in the MacBook notch.
//!
//! A borderless window sits over the notch, above the menu bar, with the
//! mascot in the black "wing" left of the notch and a status on the right. When
//! the cursor rests on it, it grows downwards into a small overview, and it
//! peeks out on its own when something changes. The page draws all of it; this
//! module only places the window, watches the cursor and says when to grow.
//!
//! The cursor is read with CoreGraphics from a background thread, because the
//! webview doesn't get hover events while another app is in front.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::{NSEdgeInsets, NSRect};
use serde::Serialize;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

pub const LABEL: &str = "notch";
/// Width of each black wing beside the notch, where the mascot and status sit.
/// Wider while an agent works, to show what it is doing (like a live activity).
static WING: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(46);
fn wing() -> f64 {
    WING.load(std::sync::atomic::Ordering::Relaxed) as f64
}
/// The expanded view: wide under the notch, like a shelf. The width is a setting.
static OPEN_W: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(820);
/// How long it stays open after the cursor leaves. A setting.
static CLOSE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1500);
const OPEN_H: f64 = 250.0;
/// Without a notch, a pill this wide sits at the top centre of the menu bar.
const NO_NOTCH_W: f64 = 180.0;

#[derive(Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    /// Top-left of the screen, in the global coordinates Tauri uses.
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
    pub notch_width: f64,
    pub bar_height: f64,
    pub has_notch: bool,
}

impl Geometry {
    fn closed(&self) -> (f64, f64, f64, f64) {
        let w = if self.has_notch { self.notch_width + 2.0 * wing() } else { NO_NOTCH_W.max(2.0 * wing()) };
        (self.screen_x + (self.screen_width - w) / 2.0, self.screen_y, w, self.bar_height)
    }
    fn open(&self) -> (f64, f64, f64, f64) {
        let want = OPEN_W.load(std::sync::atomic::Ordering::Relaxed) as f64;
        let mut w = want.min(self.screen_width - 40.0).round();
        // Whole points on both sides of the notch: a half-point edge leaves a
        // hairline seam in the webview right where the wing meets the notch.
        if (w - self.notch_width) as i64 % 2 != 0 {
            w += 1.0;
        }
        (self.screen_x + (self.screen_width - w) / 2.0, self.screen_y, w, OPEN_H)
    }
}

/// Where the notch is. Must run on the main thread (AppKit).
pub fn geometry() -> Option<Geometry> {
    unsafe {
        let cls = AnyClass::get(c"NSScreen")?;
        let screens: *mut AnyObject = msg_send![cls, screens];
        let count: usize = msg_send![screens, count];
        if count == 0 {
            return None;
        }
        let primary: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        let primary_frame: NSRect = msg_send![primary, frame];
        // The built-in display is the one with a top inset; otherwise the main one.
        let mut screen: *mut AnyObject = msg_send![cls, mainScreen];
        let mut has_notch = false;
        for i in 0..count {
            let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let insets: NSEdgeInsets = msg_send![s, safeAreaInsets];
            if insets.top > 0.0 {
                screen = s;
                has_notch = true;
                break;
            }
        }
        let frame: NSRect = msg_send![screen, frame];
        let visible: NSRect = msg_send![screen, visibleFrame];
        let insets: NSEdgeInsets = msg_send![screen, safeAreaInsets];
        let mut notch_width = 0.0;
        if has_notch {
            let left: NSRect = msg_send![screen, auxiliaryTopLeftArea];
            let right: NSRect = msg_send![screen, auxiliaryTopRightArea];
            notch_width = (frame.size.width - left.size.width - right.size.width).round();
        }
        let top = frame.origin.y + frame.size.height;
        let bar = if has_notch { insets.top } else { (top - (visible.origin.y + visible.size.height)).max(24.0) };
        Some(Geometry {
            screen_x: frame.origin.x,
            screen_y: primary_frame.size.height - top,
            screen_width: frame.size.width,
            screen_height: frame.size.height,
            notch_width,
            bar_height: bar,
            has_notch,
        })
    }
}

/// Float above the menu bar, on every Space and over full-screen apps.
pub(crate) fn float_over_menu_bar(window: &tauri::WebviewWindow) {
    let Ok(ns) = window.ns_window() else { return };
    let ns = ns as *mut AnyObject;
    // NSStatusWindowLevel (25) + 1, above the menu bar itself.
    const LEVEL: isize = 26;
    // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
    const BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
    unsafe {
        let _: () = msg_send![ns, setLevel: LEVEL];
        let _: () = msg_send![ns, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![ns, setHasShadow: false];
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

/// Seconds since the last key press, click or mouse move anywhere.
pub fn idle_secs() -> f64 {
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType
    unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) }
}

/// Whether the left mouse button is held down right now.
pub fn left_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}

/// Away from the Mac this long, the closed notch hides; alerts still show.
const AWAY_SECS: f64 = 180.0;
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// The cursor in global top-left coordinates, from any thread.
pub(crate) fn cursor() -> Option<(f64, f64)> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let p = CGEventGetLocation(event);
        CFRelease(event);
        Some((p.x, p.y))
    }
}

struct State {
    enabled: bool,
    open: bool,
    geometry: Geometry,
    hover_since: Option<Instant>,
    outside_since: Option<Instant>,
    peek_until: Option<Instant>,
    last_look: (f64, f64),
    /// Whether the window currently lets clicks through to what is below it.
    click_through: bool,
    away: bool,
    away_checked: Option<Instant>,
}

static STATE: Mutex<State> = Mutex::new(State {
    enabled: false,
    open: false,
    geometry: Geometry { screen_x: 0.0, screen_y: 0.0, screen_width: 0.0, screen_height: 0.0, notch_width: 0.0, bar_height: 0.0, has_notch: false },
    hover_since: None,
    outside_since: None,
    peek_until: None,
    last_look: (0.0, 0.0),
    click_through: false,
    away: false,
    away_checked: None,
});

pub(crate) fn inside(p: (f64, f64), r: (f64, f64, f64, f64), margin: f64) -> bool {
    p.0 >= r.0 - margin && p.0 <= r.0 + r.2 + margin && p.1 >= r.1 - margin && p.1 <= r.1 + r.3 + margin
}

fn place(app: &AppHandle, rect: (f64, f64, f64, f64)) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.set_size(LogicalSize::new(rect.2, rect.3));
            let _ = w.set_position(LogicalPosition::new(rect.0, rect.1));
        }
    });
}

/// The window always has the open size; the page draws the closed or open
/// shape inside it, so opening never resizes a window (which is what stutters).
fn set_open(app: &AppHandle, open: bool, _geometry: Geometry) {
    let _ = app.emit_to(LABEL, "notch-open", open);
}

/// Let clicks through everywhere except where the notch is actually drawn.
fn set_click_through(app: &AppHandle, through: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.set_ignore_cursor_events(through);
        }
    });
}

/// Create the notch window's behaviour and start watching the cursor.
pub fn setup(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    float_over_menu_bar(&window);
    if let Some(g) = geometry() {
        STATE.lock().unwrap().geometry = g;
        let (x, y, w, h) = g.open();
        let _ = window.set_size(LogicalSize::new(w, h));
        let _ = window.set_position(LogicalPosition::new(x, y));
    }

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(33));
        let Some(p) = cursor() else { continue };
        let mut s = STATE.lock().unwrap();
        if !s.enabled {
            continue;
        }
        let g = s.geometry;
        let now = Instant::now();
        let closed = g.closed();

        // Eyes follow the cursor wherever it is on the screen.
        let cx = closed.0 + closed.2 / 2.0;
        let (dx, dy) = (p.0 - cx, p.1 - g.screen_y);
        // tanh: a quick turn for the cursor close by, easing off towards the
        // screen's edges, so small moves near the notch still read.
        let half = (g.screen_width / 4.0).max(1.0);
        let tall = (g.screen_height / 3.0).max(1.0);
        let look = ((dx / half).tanh(), (dy / tall).tanh());
        if (look.0 - s.last_look.0).abs() > 0.015 || (look.1 - s.last_look.1).abs() > 0.015 {
            s.last_look = look;
            let _ = app.emit_to(LABEL, "notch-look", look);
        }

        // Away from the Mac: the closed notch hides (the page decides, alerts still show).
        if s.away_checked.is_none_or(|t| now.duration_since(t) > Duration::from_secs(1)) {
            s.away_checked = Some(now);
            let away = idle_secs() >= AWAY_SECS;
            if away != s.away {
                s.away = away;
                let _ = app.emit_to(LABEL, "notch-away", away);
            }
        }

        // Only the drawn notch takes clicks; the rest of the window is see-through.
        let wants_clicks = s.open || inside(p, closed, 3.0);
        if wants_clicks == s.click_through {
            s.click_through = !wants_clicks;
            set_click_through(&app, !wants_clicks);
        }

        if !s.open {
            if inside(p, closed, 2.0) {
                let since = *s.hover_since.get_or_insert(now);
                if now.duration_since(since) > Duration::from_millis(100) {
                    s.open = true;
                    s.hover_since = None;
                    s.outside_since = None;
                    drop(s);
                    set_open(&app, true, g);
                }
            } else {
                s.hover_since = None;
            }
        } else {
            let peeking = s.peek_until.is_some_and(|t| now < t);
            if inside(p, g.open(), 10.0) {
                if s.outside_since.is_some() || s.peek_until.is_some() {
                    let _ = app.emit_to(LABEL, "notch-countdown", 0u64);
                }
                s.outside_since = None;
                s.peek_until = None; // the user took over; stay open while they look
            } else if !peeking {
                let wait = CLOSE_MS.load(std::sync::atomic::Ordering::Relaxed);
                if s.outside_since.is_none() {
                    let _ = app.emit_to(LABEL, "notch-countdown", wait);
                }
                let since = *s.outside_since.get_or_insert(now);
                if now.duration_since(since) > Duration::from_millis(wait) {
                    s.open = false;
                    s.outside_since = None;
                    s.peek_until = None;
                    drop(s);
                    set_open(&app, false, g);
                }
            }
        }
    });
}

pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let g = {
        let mut s = STATE.lock().unwrap();
        s.enabled = enabled;
        s.open = false;
        // Screens change (lid, external monitor); read the notch again.
        if let Some(g) = geometry() {
            s.geometry = g;
        }
        s.geometry
    };
    if let Some(w) = app.get_webview_window(LABEL) {
        if enabled {
            place(app, g.open());
            let _ = w.show();
            float_over_menu_bar(&w);
        } else {
            let _ = w.hide();
        }
    }
}

/// Open for a moment on its own, to show what just happened.
pub fn peek(app: &AppHandle, millis: u64) {
    let g = {
        let mut s = STATE.lock().unwrap();
        if !s.enabled {
            return;
        }
        s.peek_until = Some(Instant::now() + Duration::from_millis(millis));
        s.outside_since = None;
        let _ = app.emit_to(LABEL, "notch-countdown", millis);
        if s.open {
            return;
        }
        s.open = true;
        s.geometry
    };
    set_open(app, true, g);
}

/// The glow around the screen's edge while an agent works: a click-through
/// window over the whole main screen, shown or hidden on demand.
pub fn glow_set(app: &AppHandle, on: bool) {
    let Some(w) = app.get_webview_window("glow") else { return };
    if !on {
        let _ = w.hide();
        return;
    }
    let g = geometry().unwrap_or_else(current_geometry);
    let _ = w.set_size(LogicalSize::new(g.screen_width, g.screen_height));
    let _ = w.set_position(LogicalPosition::new(g.screen_x, g.screen_y));
    let _ = w.set_ignore_cursor_events(true);
    float_over_menu_bar(&w);
    let _ = w.show();
}

/// Stop holding the notch open after a peek; it closes once the cursor is away.
pub fn release() {
    if let Ok(mut s) = STATE.lock() {
        s.peek_until = None;
    }
}

/// Where the open notch is drawn, in global top-left coordinates.
pub fn open_rect() -> (f64, f64, f64, f64) {
    current_geometry().open()
}

pub fn current_geometry() -> Geometry {
    STATE.lock().map(|s| s.geometry).unwrap_or_default()
}

/// A new width for the open notch (from the widget's settings).
pub fn set_width(app: &AppHandle, width: f64) {
    OPEN_W.store(width.clamp(520.0, 1100.0) as u32, std::sync::atomic::Ordering::Relaxed);
    let g = STATE.lock().map(|s| s.geometry).unwrap_or_default();
    place(app, g.open());
}

pub fn set_close_delay(millis: u64) {
    CLOSE_MS.store(millis.clamp(200, 10_000), std::sync::atomic::Ordering::Relaxed);
}

/// Wider wings while an agent works; back to the plain notch when it's done.
pub fn set_wing(width: f64) {
    // 0 hides the wings entirely (away from the Mac): only the notch itself is left.
    WING.store(width.clamp(0.0, 320.0) as u32, std::sync::atomic::Ordering::Relaxed);
}
