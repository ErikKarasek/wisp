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
const WING: f64 = 46.0;
/// Size of the expanded overview.
const OPEN_W: f64 = 420.0;
const OPEN_H: f64 = 260.0;
/// Without a notch, a pill this wide sits at the top centre of the menu bar.
const NO_NOTCH_W: f64 = 180.0;

#[derive(Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    /// Top-left of the screen, in the global coordinates Tauri uses.
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_width: f64,
    pub notch_width: f64,
    pub bar_height: f64,
    pub has_notch: bool,
}

impl Geometry {
    fn closed(&self) -> (f64, f64, f64, f64) {
        let w = if self.has_notch { self.notch_width + 2.0 * WING } else { NO_NOTCH_W };
        (self.screen_x + (self.screen_width - w) / 2.0, self.screen_y, w, self.bar_height)
    }
    fn open(&self) -> (f64, f64, f64, f64) {
        let w = OPEN_W.max(self.closed().2);
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
            notch_width = frame.size.width - left.size.width - right.size.width;
        }
        let top = frame.origin.y + frame.size.height;
        let bar = if has_notch { insets.top } else { (top - (visible.origin.y + visible.size.height)).max(24.0) };
        Some(Geometry {
            screen_x: frame.origin.x,
            screen_y: primary_frame.size.height - top,
            screen_width: frame.size.width,
            notch_width,
            bar_height: bar,
            has_notch,
        })
    }
}

/// Float above the menu bar, on every Space and over full-screen apps.
fn float_over_menu_bar(window: &tauri::WebviewWindow) {
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
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// The cursor in global top-left coordinates, from any thread.
fn cursor() -> Option<(f64, f64)> {
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
}

static STATE: Mutex<State> = Mutex::new(State {
    enabled: false,
    open: false,
    geometry: Geometry { screen_x: 0.0, screen_y: 0.0, screen_width: 0.0, notch_width: 0.0, bar_height: 0.0, has_notch: false },
    hover_since: None,
    outside_since: None,
    peek_until: None,
    last_look: (0.0, 0.0),
});

fn inside(p: (f64, f64), r: (f64, f64, f64, f64), margin: f64) -> bool {
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

fn set_open(app: &AppHandle, open: bool, geometry: Geometry) {
    if open {
        // Grow the window first, then let the page animate into it.
        place(app, geometry.open());
        let _ = app.emit_to(LABEL, "notch-open", true);
    } else {
        // Let the page animate back, then shrink the window.
        let _ = app.emit_to(LABEL, "notch-open", false);
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(260));
            let still_closed = STATE.lock().map(|s| !s.open).unwrap_or(true);
            if still_closed {
                place(&app2, geometry.closed());
            }
        });
    }
}

/// Create the notch window's behaviour and start watching the cursor.
pub fn setup(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    float_over_menu_bar(&window);
    if let Some(g) = geometry() {
        STATE.lock().unwrap().geometry = g;
        let (x, y, w, h) = g.closed();
        let _ = window.set_size(LogicalSize::new(w, h));
        let _ = window.set_position(LogicalPosition::new(x, y));
    }

    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(50));
        let Some(p) = cursor() else { continue };
        let mut s = STATE.lock().unwrap();
        if !s.enabled {
            continue;
        }
        let g = s.geometry;
        let now = Instant::now();
        let closed = g.closed();

        // Eyes follow the cursor when it is anywhere near.
        let cx = closed.0 + closed.2 / 2.0;
        let (dx, dy) = (p.0 - cx, p.1 - g.screen_y);
        if dx.abs() < 900.0 && dy < 700.0 {
            let look = ((dx / 450.0).clamp(-1.0, 1.0), (dy / 350.0).clamp(-1.0, 1.0));
            if (look.0 - s.last_look.0).abs() > 0.02 || (look.1 - s.last_look.1).abs() > 0.02 {
                s.last_look = look;
                let _ = app.emit_to(LABEL, "notch-look", look);
            }
        }

        if !s.open {
            if inside(p, closed, 2.0) {
                let since = *s.hover_since.get_or_insert(now);
                if now.duration_since(since) > Duration::from_millis(140) {
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
                s.outside_since = None;
                s.peek_until = None; // the user took over; stay open while they look
            } else if !peeking {
                let since = *s.outside_since.get_or_insert(now);
                if now.duration_since(since) > Duration::from_millis(380) {
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
            place(app, g.closed());
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
        if s.open {
            return;
        }
        s.open = true;
        s.geometry
    };
    set_open(app, true, g);
}

pub fn current_geometry() -> Geometry {
    STATE.lock().map(|s| s.geometry).unwrap_or_default()
}
