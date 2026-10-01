//! Dragging the bot out of the notch onto another app's window, like Coucou:
//! a small floating copy of the bot follows the cursor while the button is
//! held, and where it is let go, that window is captured for a question about
//! it (Gemini reads the picture, as with a dropped file).
//!
//! The drag itself is followed from here, not from the page: the notch window
//! stops at its edges, and the cursor goes anywhere.

use crate::notch;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use serde::Serialize;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager};

pub const LABEL: &str = "buddy";
/// The floating bot's window, in points; the cursor holds it by the middle.
const SIZE: f64 = 64.0;
static DRAGGING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    pub path: String,
    pub app: String,
    pub title: String,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

fn ns_string(s: &str) -> *mut AnyObject {
    let c = CString::new(s).unwrap_or_default();
    unsafe { msg_send![AnyClass::get(c"NSString").unwrap(), stringWithUTF8String: c.as_ptr()] }
}

unsafe fn get(dict: *mut AnyObject, key: &str) -> *mut AnyObject {
    msg_send![dict, objectForKey: ns_string(key)]
}

unsafe fn text(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return String::new();
    }
    let p: *const c_char = msg_send![obj, UTF8String];
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

unsafe fn number(obj: *mut AnyObject) -> f64 {
    if obj.is_null() {
        0.0
    } else {
        msg_send![obj, doubleValue]
    }
}

/// The frontmost ordinary window of another app under a point: its number, app and title.
fn window_at(p: (f64, f64)) -> Option<(u32, String, String)> {
    let me = std::process::id() as f64;
    objc2::rc::autoreleasepool(|_| unsafe {
        // On screen only, without the desktop, front to back.
        let list = CGWindowListCopyWindowInfo((1 << 0) | (1 << 4), 0);
        if list.is_null() {
            return None;
        }
        let arr = list as *mut AnyObject;
        let count: usize = msg_send![arr, count];
        let mut found = None;
        for i in 0..count {
            let w: *mut AnyObject = msg_send![arr, objectAtIndex: i];
            // Layer 0 is ordinary app windows (not the menu bar, the Dock or overlays).
            if number(get(w, "kCGWindowLayer")) != 0.0 || number(get(w, "kCGWindowOwnerPID")) == me {
                continue;
            }
            let b = get(w, "kCGWindowBounds");
            let r = (number(get(b, "X")), number(get(b, "Y")), number(get(b, "Width")), number(get(b, "Height")));
            if r.2 < 40.0 || r.3 < 40.0 || !notch::inside(p, r, 0.0) {
                continue;
            }
            found = Some((number(get(w, "kCGWindowNumber")) as u32, text(get(w, "kCGWindowOwnerName")), text(get(w, "kCGWindowName"))));
            break;
        }
        CFRelease(list);
        found
    })
}

fn place(app: &AppHandle, p: (f64, f64)) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.set_position(LogicalPosition::new(p.0 - SIZE / 2.0, p.1 - SIZE / 2.0));
        }
    });
}

/// Start carrying the bot; returns at once, the drag runs on its own thread.
pub fn start(app: &AppHandle) {
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(LABEL) else {
        DRAGGING.store(false, Ordering::SeqCst);
        return;
    };
    if let Some(p) = notch::cursor() {
        let _ = window.set_position(LogicalPosition::new(p.0 - SIZE / 2.0, p.1 - SIZE / 2.0));
    }
    let _ = window.set_ignore_cursor_events(true);
    notch::float_over_menu_bar(&window);
    let _ = window.show();
    let _ = app.emit_to(LABEL, "buddy-carry", true);

    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = notch::cursor().unwrap_or_default();
        // Up to a minute of carrying; a missed button release can't leave it stuck.
        for _ in 0..3600 {
            std::thread::sleep(Duration::from_millis(16));
            if let Some(p) = notch::cursor() {
                if p != last {
                    last = p;
                    place(&app, p);
                }
            }
            if !notch::left_down() {
                break;
            }
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(LABEL) {
                let _ = w.hide();
            }
        });
        DRAGGING.store(false, Ordering::SeqCst);

        // Let go over the notch, or over nothing: the bot just goes back.
        let target = if notch::inside(last, notch::open_rect(), 0.0) { None } else { window_at(last) };
        let Some((id, owner, title)) = target else {
            let _ = app.emit_to(notch::LABEL, "buddy-back", ());
            return;
        };
        let dir = std::env::temp_dir().join("dispecink-ask");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("okno-{}.png", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
        // -x no sound, -o no shadow, -l just that window. Needs Screen Recording for Wisp.
        let ok = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-x", "-o", "-l", &id.to_string()])
            .arg(&path)
            .status()
            .is_ok_and(|s| s.success())
            && path.exists();
        if !ok {
            let _ = app.emit_to(notch::LABEL, "buddy-failed", "Okno se nepodařilo vyfotit. Povol Wispu Nahrávání obrazovky v Nastavení systému → Soukromí.");
            notch::peek(&app, 8000);
            return;
        }
        let _ = app.emit_to(notch::LABEL, "buddy-dropped", Dropped { path: path.to_string_lossy().into_owned(), app: owner, title });
        notch::peek(&app, 20_000);
    });
}
