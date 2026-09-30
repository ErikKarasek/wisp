//! Today's and tomorrow's events from the Mac's calendars, through EventKit.
//! macOS asks once for permission; until then the calendar tab offers to ask.

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use serde::Serialize;
use std::ffi::{c_char, CStr};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[link(name = "EventKit", kind = "framework")]
extern "C" {}

/// EKEntityTypeEvent
const EVENTS: isize = 0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub title: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub all_day: bool,
    pub calendar: String,
    pub location: String,
}

struct Store(*mut AnyObject);
// EKEventStore may be used from any thread once created.
unsafe impl Send for Store {}
unsafe impl Sync for Store {}
static STORE: OnceLock<Store> = OnceLock::new();

fn store() -> Option<*mut AnyObject> {
    let s = STORE.get_or_init(|| unsafe {
        let cls = AnyClass::get(c"EKEventStore").expect("EventKit");
        let obj: *mut AnyObject = msg_send![cls, alloc];
        let obj: *mut AnyObject = msg_send![obj, init];
        Store(obj) // kept for the life of the app
    });
    (!s.0.is_null()).then_some(s.0)
}

/// "none", "denied", "granted" or "writeOnly".
pub fn status() -> &'static str {
    let Some(cls) = AnyClass::get(c"EKEventStore") else { return "denied" };
    let s: isize = unsafe { msg_send![cls, authorizationStatusForEntityType: EVENTS] };
    match s {
        0 => "none",
        3 => "granted",
        4 => "writeOnly",
        _ => "denied",
    }
}

/// Ask macOS for access; blocks until the user answers (up to two minutes).
pub fn request() -> bool {
    let Some(store) = store() else { return false };
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe {
        let _: () = msg_send![store, requestFullAccessToEventsWithCompletion: &*block];
    }
    rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
}

unsafe fn text(obj: *mut AnyObject) -> String {
    if obj.is_null() {
        return String::new();
    }
    let c: *const c_char = msg_send![obj, UTF8String];
    if c.is_null() {
        String::new()
    } else {
        CStr::from_ptr(c).to_string_lossy().into_owned()
    }
}

unsafe fn millis(date: *mut AnyObject) -> f64 {
    if date.is_null() {
        return 0.0;
    }
    let s: f64 = msg_send![date, timeIntervalSince1970];
    s * 1000.0
}

/// Events from the start of today until the end of tomorrow, sorted by start.
pub fn upcoming() -> Vec<Event> {
    if status() != "granted" {
        return vec![];
    }
    let Some(store) = store() else { return vec![] };
    autoreleasepool(|_| unsafe {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        let date_cls = AnyClass::get(c"NSDate").expect("Foundation");
        let start: *mut AnyObject = msg_send![date_cls, dateWithTimeIntervalSince1970: now - 12.0 * 3600.0];
        let end: *mut AnyObject = msg_send![date_cls, dateWithTimeIntervalSince1970: now + 48.0 * 3600.0];
        let pred: *mut AnyObject =
            msg_send![store, predicateForEventsWithStartDate: start, endDate: end, calendars: std::ptr::null_mut::<AnyObject>()];
        let list: *mut AnyObject = msg_send![store, eventsMatchingPredicate: pred];
        if list.is_null() {
            return vec![];
        }
        let count: usize = msg_send![list, count];
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let ev: *mut AnyObject = msg_send![list, objectAtIndex: i];
            let cal: *mut AnyObject = msg_send![ev, calendar];
            let all_day: Bool = msg_send![ev, isAllDay];
            out.push(Event {
                title: text(msg_send![ev, title]),
                start_ms: millis(msg_send![ev, startDate]),
                end_ms: millis(msg_send![ev, endDate]),
                all_day: all_day.as_bool(),
                calendar: if cal.is_null() { String::new() } else { text(msg_send![cal, title]) },
                location: text(msg_send![ev, location]),
            });
        }
        out.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        out
    })
}
