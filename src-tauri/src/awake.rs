//! Keeping the Mac awake while something works, LidRun-style: on its own while
//! agents or Claude Code work, by hand, on a timer, and with the lid closed.
//!
//! - Awake: a `caffeinate -i -w <our pid>` child. It dies with Wisp, so a crash
//!   can't leave the Mac unable to idle-sleep.
//! - Closed lid: `sudo -n pmset -a disablesleep 1`, allowed without a password by
//!   one sudoers rule the user installs once from the panel (macOS asks for the
//!   admin password). A marker file says Wisp turned it on; the next start turns
//!   it back off if Wisp died with it on.
//! - Safety: on battery below the stop level everything lets go; near empty, or
//!   hot with the lid shut, the Mac is put to sleep.
//!
//! What counts as work comes from the page (agents and jobs in "run", busy Claude
//! Code sessions) plus a few heavy build tools seen with `ps`.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const PMSET: &str = "/usr/bin/pmset";
const SUDOERS: &str = "/etc/sudoers.d/wisp-lid";
/// Work that stops for a moment (between two agent runs) doesn't let go at once.
const GRACE_MS: u64 = 120_000;
/// Below this on battery, nothing is held any more.
const BATTERY_CRITICAL: u8 = 7;
/// Build tools that count as work while they use the CPU. node and python are
/// left out on purpose: something of theirs runs all the time.
const TOOLS: &[(&str, &str)] = &[
    ("codex", "Codex"),
    ("agy", "Gemini"),
    ("xcodebuild", "Xcode build"),
    ("cargo", "Cargo"),
    ("rustc", "Rust build"),
    ("swift-frontend", "Swift build"),
    ("ffmpeg", "ffmpeg"),
    ("ollama", "Ollama"),
    ("com.docker.backend", "Docker"),
];

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Hold while something works.
    pub auto: bool,
    /// Hold until switched off (or the timer runs out).
    pub manual: bool,
    /// Only hold on the charger.
    pub charging_only: bool,
    /// Keep the display on too.
    pub display: bool,
    /// Keep running with the lid closed.
    pub lid: bool,
    /// With the lid: only while work runs, then sleep. Off: until switched off.
    pub lid_until_done: bool,
    /// When the timer ends (ms since epoch); it switches off by-hand holding and the lid.
    pub until_ms: Option<u64>,
    /// On battery, let go below this percentage.
    pub battery_stop: u8,
    /// After work Wisp held the Mac for: sleep once nobody touched it for this long (0 = never).
    pub sleep_after_min: u32,
    /// Remote: on the charger the Mac never sleeps (lid closed too, display off), so the
    /// phone can always reach it. A sleeping Mac can't be woken over the internet.
    pub remote: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            auto: true,
            manual: false,
            charging_only: false,
            display: false,
            lid: false,
            lid_until_done: true,
            until_ms: None,
            battery_stop: 20,
            sleep_after_min: 10,
            remote: false,
        }
    }
}

/// One stretch of holding the Mac awake for work, for the weekly figure and the morning summary.
#[derive(Clone, Serialize, Deserialize)]
pub struct Episode {
    pub start: u64,
    pub end: u64,
    pub lid: bool,
    pub who: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    prefs: Prefs,
    episodes: Vec<Episode>,
}

#[derive(Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    pub app: String,
    pub what: String,
}

#[derive(Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub prefs: Prefs,
    /// Wisp holds the Mac awake right now.
    pub holding: bool,
    /// The lid rule is in force (closing the lid won't sleep the Mac).
    pub lid_active: bool,
    /// The sudoers rule is installed.
    pub lid_ready: bool,
    pub why: String,
    pub working: Vec<String>,
    pub battery: Option<u8>,
    pub on_ac: bool,
    pub charging: bool,
    pub lid_closed: bool,
    /// 0 nominal, 1 fair, 2 serious, 3 critical.
    pub thermal: u8,
    /// The hottest CPU die sensor, °C.
    pub temp: Option<u8>,
    pub cpu: u8,
    pub idle_secs: u64,
    pub others: Vec<Holder>,
    pub week_minutes: u64,
    pub error: Option<String>,
}

struct Inner {
    dir: PathBuf,
    saved: Saved,
    /// What the page says works, and when it last said so.
    page_work: Vec<String>,
    page_at: u64,
    tool_work: Vec<String>,
    /// Last time anything worked.
    work_at: u64,
    /// Names seen during the current episode.
    episode: Option<Episode>,
    caffeinate: Option<(Child, String)>,
    lid_applied: bool,
    /// Waits for Wisp to exit and switches sleep back on, even after a kill -9.
    lid_guard: Option<Child>,
    /// Low battery: nothing is held until the charger or a few percent more.
    battery_lock: bool,
    /// Hot with the lid shut: the lid stays off for a while.
    thermal_lock_until: u64,
    /// Sleep once nobody touches the Mac, after an episode ended.
    sleep_pending: bool,
    /// Last time a nearly empty battery put the Mac to sleep.
    critical_at: u64,
    others_at: u64,
    status: Status,
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file(dir: &Path) -> PathBuf {
    dir.join("awake.json")
}

fn marker(dir: &Path) -> PathBuf {
    dir.join("lid-on")
}

fn save(inner: &Inner) {
    let _ = std::fs::create_dir_all(&inner.dir);
    let path = file(&inner.dir);
    let tmp = path.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string_pretty(&inner.saved) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn notify(app: &AppHandle, text: &str, urgent: bool) {
    let _ = app.emit_to("main", "notify", json!({ "title": "Wisp", "text": text, "urgent": urgent }));
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---------- the Mac's state ----------

/// Battery percentage, whether the charger is in, and whether it's charging.
fn battery() -> (Option<u8>, bool, bool) {
    let Some(out) = run(PMSET, &["-g", "batt"]) else { return (None, true, false) };
    let on_ac = out.contains("'AC Power'");
    let pct = out
        .split_whitespace()
        .find_map(|w| w.strip_suffix("%;").and_then(|n| n.parse::<u8>().ok()));
    let charging = out.contains("; charging;") || out.contains("finishing charge");
    (pct, on_ac, charging)
}

fn lid_closed() -> bool {
    run("/usr/sbin/ioreg", &["-r", "-k", "AppleClamshellState", "-d", "1"])
        .is_some_and(|o| o.lines().any(|l| l.contains("\"AppleClamshellState\" = Yes")))
}

fn thermal() -> u8 {
    let Some(cls) = AnyClass::get(c"NSProcessInfo") else { return 0 };
    unsafe {
        let info: *mut AnyObject = msg_send![cls, processInfo];
        if info.is_null() {
            return 0;
        }
        let s: isize = msg_send![info, thermalState];
        s.clamp(0, 3) as u8
    }
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(source: i32, event: u32) -> f64;
}

// The temperature sensors, through the HID event system (no root needed). The
// same private calls tools like Stats use; "PMU tdie*" are the CPU die sensors.
type CfRef = *const std::ffi::c_void;
#[repr(C)]
struct CfDictCallbacks([usize; 6]);
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDEventSystemClientCreate(alloc: CfRef) -> CfRef;
    fn IOHIDEventSystemClientSetMatching(client: CfRef, matching: CfRef) -> i32;
    fn IOHIDEventSystemClientCopyServices(client: CfRef) -> CfRef;
    fn IOHIDServiceClientCopyProperty(service: CfRef, key: CfRef) -> CfRef;
    fn IOHIDServiceClientCopyEvent(service: CfRef, kind: i64, options: i32, timestamp: i64) -> CfRef;
    fn IOHIDEventGetFloatValue(event: CfRef, field: i32) -> f64;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: CfDictCallbacks;
    static kCFTypeDictionaryValueCallBacks: CfDictCallbacks;
    fn CFStringCreateWithCString(alloc: CfRef, s: *const std::ffi::c_char, encoding: u32) -> CfRef;
    fn CFStringGetCString(s: CfRef, buf: *mut std::ffi::c_char, size: isize, encoding: u32) -> bool;
    fn CFNumberCreate(alloc: CfRef, kind: isize, value: *const std::ffi::c_void) -> CfRef;
    fn CFDictionaryCreate(alloc: CfRef, keys: *const CfRef, values: *const CfRef, n: isize, kc: *const CfDictCallbacks, vc: *const CfDictCallbacks) -> CfRef;
    fn CFArrayGetCount(a: CfRef) -> isize;
    fn CFArrayGetValueAtIndex(a: CfRef, i: isize) -> CfRef;
    fn CFRelease(cf: CfRef);
}

fn cf_release(cf: CfRef) {
    // CFRelease(NULL) crashes; anything here may have failed to be created.
    if !cf.is_null() {
        unsafe { CFRelease(cf) }
    }
}

const UTF8: u32 = 0x0800_0100;

/// The HID client matched to temperature sensors, made once: creating one is an IPC
/// round trip to hidd, too much for every tick. Kept for the app's whole life.
fn sensor_client() -> Option<CfRef> {
    static CLIENT: OnceLock<usize> = OnceLock::new();
    let ptr = *CLIENT.get_or_init(|| unsafe {
        let client = IOHIDEventSystemClientCreate(std::ptr::null());
        if client.is_null() {
            return 0;
        }
        let (page, usage): (i32, i32) = (0xff00, 5);
        let keys = [
            CFStringCreateWithCString(std::ptr::null(), c"PrimaryUsagePage".as_ptr(), UTF8),
            CFStringCreateWithCString(std::ptr::null(), c"PrimaryUsage".as_ptr(), UTF8),
        ];
        // kCFNumberSInt32Type
        let values = [
            CFNumberCreate(std::ptr::null(), 3, &page as *const i32 as *const _),
            CFNumberCreate(std::ptr::null(), 3, &usage as *const i32 as *const _),
        ];
        if keys.iter().chain(values.iter()).all(|p| !p.is_null()) {
            let matching = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), values.as_ptr(), 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            if !matching.is_null() {
                IOHIDEventSystemClientSetMatching(client, matching);
                cf_release(matching);
            }
        }
        for k in keys.into_iter().chain(values) {
            cf_release(k);
        }
        client as usize
    });
    (ptr != 0).then_some(ptr as CfRef)
}

/// The hottest CPU die sensor, in °C. Only called from tick, which runs under the state lock.
fn cpu_temp() -> Option<f64> {
    const TEMPERATURE: i64 = 15;
    let client = sensor_client()?;
    unsafe {
        let product = CFStringCreateWithCString(std::ptr::null(), c"Product".as_ptr(), UTF8);
        if product.is_null() {
            return None;
        }
        let services = IOHIDEventSystemClientCopyServices(client);
        let mut hottest: Option<f64> = None;
        if !services.is_null() {
            for i in 0..CFArrayGetCount(services) {
                let svc = CFArrayGetValueAtIndex(services, i);
                let name = IOHIDServiceClientCopyProperty(svc, product);
                if name.is_null() {
                    continue;
                }
                let mut buf = [0 as std::ffi::c_char; 64];
                let ok = CFStringGetCString(name, buf.as_mut_ptr(), 64, UTF8);
                cf_release(name);
                if !ok || !std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().contains("tdie") {
                    continue;
                }
                let event = IOHIDServiceClientCopyEvent(svc, TEMPERATURE, 0, 0);
                if event.is_null() {
                    continue;
                }
                let t = IOHIDEventGetFloatValue(event, (TEMPERATURE as i32) << 16);
                cf_release(event);
                if (1.0..130.0).contains(&t) {
                    hottest = Some(hottest.map_or(t, |h: f64| h.max(t)));
                }
            }
            cf_release(services);
        }
        cf_release(product);
        hottest
    }
}

/// Seconds since the last key or mouse event.
fn idle_secs() -> u64 {
    // kCGEventSourceStateHIDSystemState, kCGAnyInputEventType
    let s = unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) };
    if s.is_finite() && s > 0.0 { s as u64 } else { 0 }
}

/// Whole-machine CPU use in percent, and the build tools that are busy.
fn processes() -> (u8, Vec<String>) {
    let Some(out) = run("/bin/ps", &["-A", "-o", "%cpu=,comm="]) else { return (0, vec![]) };
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8) as f64;
    let mut total = 0.0;
    let mut busy: Vec<String> = vec![];
    for line in out.lines() {
        let line = line.trim();
        let Some((cpu, comm)) = line.split_once(' ') else { continue };
        let cpu: f64 = cpu.trim().parse().unwrap_or(0.0);
        total += cpu;
        let name = comm.trim().rsplit('/').next().unwrap_or("");
        if cpu >= 5.0 {
            if let Some((_, label)) = TOOLS.iter().find(|(p, _)| *p == name) {
                if !busy.iter().any(|b| b == label) {
                    busy.push(label.to_string());
                }
            }
        }
    }
    ((total / cores).round().clamp(0.0, 100.0) as u8, busy)
}

/// Claude Code sessions that wrote to their transcript in the last 90 s. Hooks don't reach
/// every session (the desktop app's own), and a thinking Claude uses no CPU, but every
/// session appends to ~/.claude/projects/<folder>/<session>.jsonl as it works.
/// Paperclip's agents are left out: paperclip_runs() counts them.
fn claude_sessions() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let Ok(dirs) = std::fs::read_dir(PathBuf::from(&home).join(".claude/projects")) else { return vec![] };
    let prefix = format!("{}-", home.replace(['/', '.'], "-"));
    let fresh = |m: std::time::SystemTime| m.elapsed().map(|e| e.as_secs() < 90).unwrap_or(false);
    let mut out = vec![];
    for d in dirs.flatten() {
        let name = d.file_name().to_string_lossy().into_owned();
        if name.contains("paperclip") {
            continue;
        }
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        let busy = files.flatten().any(|f| {
            f.path().extension().is_some_and(|e| e == "jsonl") && f.metadata().and_then(|m| m.modified()).is_ok_and(fresh)
        });
        if busy {
            let label = if name == prefix.trim_end_matches('-') { "" } else { name.strip_prefix(&prefix).unwrap_or(&name) };
            let label = label.strip_prefix("Developer-").unwrap_or(label);
            let label = if label.is_empty() || label == "-" { "domov" } else { label };
            out.push(format!("{label} · Claude Code"));
        }
    }
    out
}

/// Paperclip agents with a run queued or in progress, asked here rather than left to the page.
/// With the display off macOS throttles the hidden page's timers, and on 2026-10-03 the page
/// saw Fixer's runs, queued by the nightly review's last step, only after Wisp had slept the
/// Mac: every run died with the sleep and Paperclip retried each into the next one.
fn paperclip_runs() -> Vec<String> {
    let get = |path: &str| -> Option<Value> {
        let out = run("/usr/bin/curl", &["-sf", "-m", "2", &format!("http://127.0.0.1:3100/api{path}")])?;
        serde_json::from_str(&out).ok()
    };
    let items = |v: Value| match v {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("items") {
            Some(Value::Array(a)) => a,
            _ => vec![],
        },
        _ => vec![],
    };
    let Some(companies) = get("/companies") else { return vec![] };
    let mut out = vec![];
    for c in items(companies) {
        let Some(id) = c.get("id").and_then(|v| v.as_str()) else { continue };
        for r in get(&format!("/companies/{id}/live-runs")).map(items).unwrap_or_default() {
            let name = format!("{} · Paperclip", r.get("agentName").and_then(|v| v.as_str()).unwrap_or("Agent"));
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Other apps holding the Mac awake, from `pmset -g assertions`.
fn others(own: Option<u32>) -> Vec<Holder> {
    let Some(out) = run(PMSET, &["-g", "assertions"]) else { return vec![] };
    let mut list: Vec<Holder> = vec![];
    for line in out.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("pid ") else { continue };
        let Some((pid, rest)) = rest.split_once('(') else { continue };
        let Some((app, rest)) = rest.split_once(')') else { continue };
        let kind = ["PreventUserIdleSystemSleep", "PreventSystemSleep", "NoIdleSleepAssertion", "PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"]
            .into_iter()
            .find(|k| rest.contains(k));
        let Some(kind) = kind else { continue };
        if own.is_some_and(|o| pid.trim().parse::<u32>().ok() == Some(o)) {
            continue;
        }
        // powerd's own "while the display is on" and audio are macOS, not an app.
        if app == "powerd" {
            continue;
        }
        let what = match (app, kind) {
            ("coreaudiod", _) => "hraje zvuk".to_string(),
            (_, k) if k.contains("Display") => "nezhasíná displej".to_string(),
            _ => "nenechá Mac usnout".to_string(),
        };
        let app = if app == "coreaudiod" { "Zvuk".to_string() } else { app.to_string() };
        let h = Holder { app, what };
        if !list.contains(&h) {
            list.push(h);
        }
    }
    list
}

// ---------- the lid ----------

/// Whether the sudoers rule lets Wisp switch sleep off without a password.
pub fn lid_ready() -> bool {
    Command::new("/usr/bin/sudo")
        .args(["-n", "-l", PMSET, "-a", "disablesleep", "1"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn set_disablesleep(on: bool) -> Result<(), String> {
    let out = Command::new("/usr/bin/sudo")
        .args(["-n", PMSET, "-a", "disablesleep", if on { "1" } else { "0" }])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Install the sudoers rule. macOS asks for the admin password itself.
pub fn lid_setup() -> Result<(), String> {
    let user = std::env::var("USER").map_err(|_| "Nevím, kdo je přihlášený")?;
    if !user.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return Err("Neobvyklé uživatelské jméno, pravidlo nezakládám".into());
    }
    let rule = format!("{user} ALL=(root) NOPASSWD: {PMSET} -a disablesleep 0, {PMSET} -a disablesleep 1");
    // visudo checks the rule before it goes in, so a typo can't lock sudo up.
    let script = format!(
        "f=$(/usr/bin/mktemp) && /usr/bin/printf '%s\\n' '{rule}' > \"$f\" && /usr/sbin/visudo -cf \"$f\" && /usr/bin/install -m 0440 -o root -g wheel \"$f\" {SUDOERS}; r=$?; /bin/rm -f \"$f\"; exit $r"
    );
    let apple = format!(
        "do shell script \"{}\" with administrator privileges with prompt \"Wisp chce jednou nastavit, aby mohl nechat Mac běžet se zavřeným víkem.\"",
        script.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = Command::new("/usr/bin/osascript").args(["-e", &apple]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.contains("-128") { "Zrušeno".into() } else { err.trim().to_string() });
    }
    if lid_ready() {
        Ok(())
    } else {
        Err("Pravidlo je založené, ale sudo ho nebere (chybí #includedir v /etc/sudoers?)".into())
    }
}

// ---------- holding ----------

fn caffeinate_flags(p: &Prefs, on_ac: bool) -> String {
    let mut f = String::from("-i");
    if p.display {
        f.push_str(" -d");
    }
    if on_ac {
        f.push_str(" -s");
    }
    f
}

fn hold(inner: &mut Inner, flags: Option<String>) {
    let same = matches!((&flags, &inner.caffeinate), (Some(f), Some((_, cur))) if f == cur);
    if same {
        return;
    }
    if let Some((mut c, _)) = inner.caffeinate.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    let Some(f) = flags else { return };
    let pid = std::process::id().to_string();
    let mut args: Vec<&str> = f.split(' ').collect();
    args.extend(["-w", &pid]);
    if let Ok(child) = Command::new("/usr/bin/caffeinate").args(&args).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        inner.caffeinate = Some((child, f));
    }
}

fn apply_lid(inner: &mut Inner, on: bool) -> Result<(), String> {
    if inner.lid_applied == on {
        return Ok(());
    }
    set_disablesleep(on)?;
    inner.lid_applied = on;
    let m = marker(&inner.dir);
    if let Some(mut g) = inner.lid_guard.take() {
        let _ = g.kill();
        let _ = g.wait();
    }
    if on {
        let _ = std::fs::write(&m, b"1");
        // A crash would otherwise leave the Mac unable to sleep, lid or not, until Wisp
        // starts again. This shell outlives a killed Wisp and puts it right.
        let script = format!(
            "while /bin/kill -0 {pid} 2>/dev/null; do /bin/sleep 5; done; /usr/bin/sudo -n {PMSET} -a disablesleep 0; /bin/rm -f '{m}'",
            pid = std::process::id(),
            m = m.display()
        );
        inner.lid_guard = Command::new("/bin/sh").args(["-c", &script]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok();
    } else {
        let _ = std::fs::remove_file(m);
    }
    Ok(())
}

fn sleep_now() {
    let _ = Command::new(PMSET).arg("sleepnow").stdout(Stdio::null()).status();
}

fn close_episode(inner: &mut Inner, at: u64) {
    if let Some(mut e) = inner.episode.take() {
        e.end = at;
        if e.end.saturating_sub(e.start) >= 60_000 {
            inner.saved.episodes.push(e);
            // Two weeks is plenty for "this week" and "last night".
            let cut = at.saturating_sub(14 * 86_400_000);
            inner.saved.episodes.retain(|e| e.end >= cut);
            save(inner);
        }
    }
}

fn week_minutes(inner: &Inner, at: u64) -> u64 {
    let cut = at.saturating_sub(7 * 86_400_000);
    let mut ms: u64 = inner.saved.episodes.iter().filter(|e| e.end >= cut).map(|e| e.end - e.start.max(cut)).sum();
    if let Some(e) = &inner.episode {
        ms += at.saturating_sub(e.start);
    }
    ms / 60_000
}

/// One look at the Mac and one decision. Runs every few seconds, and at once after a change.
fn tick(app: &AppHandle, inner: &mut Inner) {
    let t = now();
    let (pct, on_ac, charging) = battery();
    let closed = lid_closed();
    let heat = thermal();
    let temp = cpu_temp().map(|t| t.round() as u8);
    let (cpu, mut tools) = processes();
    tools.extend(claude_sessions());
    tools.extend(paperclip_runs());
    let idle = idle_secs();
    inner.tool_work = tools;
    let mut error: Option<String> = None;

    // What works: the page's list (if it spoke lately) and the busy build tools.
    let mut working: Vec<String> = if t.saturating_sub(inner.page_at) < 60_000 { inner.page_work.clone() } else { vec![] };
    for w in &inner.tool_work {
        if !working.contains(w) {
            working.push(w.clone());
        }
    }
    if !working.is_empty() {
        inner.work_at = t;
    }
    let busy = inner.work_at > 0 && t.saturating_sub(inner.work_at) < GRACE_MS;

    // The timer switches by-hand holding and the lid off.
    if let Some(until) = inner.saved.prefs.until_ms {
        if t >= until {
            let p = &mut inner.saved.prefs;
            p.until_ms = None;
            p.manual = false;
            p.lid = false;
            save(inner);
            notify(app, "Časovač doběhl, Mac už vzhůru nedržím.", false);
        }
    }

    // Battery: let go below the stop level, come back on the charger or 5 % above it.
    let p = inner.saved.prefs.clone();
    if let Some(b) = pct {
        if !on_ac && b <= p.battery_stop && !inner.battery_lock {
            inner.battery_lock = true;
            if inner.caffeinate.is_some() || inner.lid_applied {
                notify(app, &format!("Baterie má {b} %, Mac už vzhůru nedržím. Zapoj nabíječku."), true);
            }
        }
        if inner.battery_lock && (on_ac || b > p.battery_stop + 5) {
            inner.battery_lock = false;
        }
    }
    let power_ok = !inner.battery_lock && (!p.charging_only || on_ac);

    // Hot with the lid shut: it can't cool, so it goes to sleep.
    if heat >= 2 && closed && inner.lid_applied {
        inner.thermal_lock_until = t + 15 * 60_000;
        let _ = apply_lid(inner, false);
        notify(app, "Mac se zavřeným víkem se přehřívá, uspávám ho.", true);
        sleep_now();
    }
    let lid_allowed = power_ok && t >= inner.thermal_lock_until;

    let remote_on = p.remote && on_ac && !inner.battery_lock;
    let lid_want = lid_allowed && ((p.lid && (p.manual || busy || !p.lid_until_done)) || (remote_on && inner.status.lid_ready));
    let hold_want = lid_want || remote_on || (power_ok && (p.manual || (p.auto && busy)));

    if let Err(e) = apply_lid(inner, lid_want) {
        error = Some(format!("Víko: {e}"));
        if lid_want {
            inner.saved.prefs.lid = false;
            save(inner);
            notify(app, "Režim zavřeného víka nejde zapnout: Wisp k tomu potřebuje jednorázové nastavení v panelu.", false);
        }
    }
    hold(inner, hold_want.then(|| caffeinate_flags(&p, on_ac)));

    // Episodes: stretches where work kept the Mac awake.
    let holding_for_work = hold_want && busy;
    match (&mut inner.episode, holding_for_work) {
        (Some(e), true) => {
            for w in &working {
                if !e.who.contains(w) {
                    e.who.push(w.clone());
                }
            }
            e.lid |= inner.lid_applied;
        }
        (None, true) => {
            inner.sleep_pending = false;
            inner.episode = Some(Episode { start: t, end: t, lid: inner.lid_applied, who: working.clone() });
        }
        (Some(_), false) => {
            let lid = inner.episode.as_ref().is_some_and(|e| e.lid);
            close_episode(inner, t);
            if !p.manual && !remote_on {
                if closed && lid {
                    notify(app, "Všechno doběhlo, uspávám Mac.", false);
                    sleep_now();
                } else if p.sleep_after_min > 0 {
                    inner.sleep_pending = true;
                }
            }
        }
        (None, false) => {}
    }
    // After work: sleep once nobody has touched the Mac for a while.
    if inner.sleep_pending {
        if hold_want || p.sleep_after_min == 0 {
            inner.sleep_pending = false;
        } else if idle >= p.sleep_after_min as u64 * 60 {
            inner.sleep_pending = false;
            // A film or music holds the display or the speakers: that's someone watching, not idle.
            // Asked now, not from the 20 s old list: playback may have just started.
            let own = inner.caffeinate.as_ref().map(|(c, _)| c.id());
            let watching = others(own).iter().any(|h| h.app == "Zvuk" || h.what == "nezhasíná displej");
            if !watching {
                sleep_now();
            }
        }
    }

    // Near empty with the lid closed: sleep before macOS shuts down hard.
    if let Some(b) = pct {
        if !on_ac && b <= BATTERY_CRITICAL && closed && t.saturating_sub(inner.critical_at) > 10 * 60_000 {
            inner.critical_at = t;
            notify(app, &format!("Baterie má {b} %, uspávám Mac."), true);
            sleep_now();
        }
    }

    if t.saturating_sub(inner.others_at) > 20_000 {
        inner.others_at = t;
        let own = inner.caffeinate.as_ref().map(|(c, _)| c.id());
        inner.status.others = others(own).into_iter().filter(|h| h.app != "caffeinate").collect();
    }

    let why = if !hold_want {
        if p.remote && !on_ac && !inner.battery_lock {
            "Na dálku: čekám na nabíječku".to_string()
        } else if inner.battery_lock {
            "Slabá baterie, nedržím".to_string()
        } else if p.charging_only && !on_ac {
            "Čekám na nabíječku".to_string()
        } else if p.auto {
            "Nic nepracuje, Mac může spát".to_string()
        } else {
            "Vypnuto".to_string()
        }
    } else if lid_want {
        if busy && p.lid_until_done && !p.manual { "Víko: běží, dokud práce nedoběhne".into() } else { "Víko: běží i zavřený".into() }
    } else if remote_on && !busy && !p.manual {
        "Na dálku: v nabíječce nespím".into()
    } else if p.manual {
        "Držím vzhůru".into()
    } else {
        "Držím vzhůru, dokud práce běží".into()
    };

    let next = Status {
        prefs: inner.saved.prefs.clone(),
        holding: inner.caffeinate.is_some(),
        lid_active: inner.lid_applied,
        lid_ready: inner.status.lid_ready,
        why,
        working: if busy { working } else { vec![] },
        battery: pct,
        on_ac,
        charging,
        lid_closed: closed,
        thermal: heat,
        temp,
        cpu,
        idle_secs: idle,
        others: inner.status.others.clone(),
        week_minutes: week_minutes(inner, t),
        error,
    };
    // idle and cpu change all the time: send only when something else did, or every 30 s.
    let mut a = next.clone();
    let mut b = inner.status.clone();
    a.idle_secs = 0;
    b.idle_secs = 0;
    a.cpu /= 10;
    b.cpu /= 10;
    a.temp = a.temp.map(|t| t / 3);
    b.temp = b.temp.map(|t| t / 3);
    inner.status = next;
    if a != b {
        let _ = app.emit("awake-state", &inner.status);
    }
}

fn with<T>(f: impl FnOnce(&mut Inner) -> T) -> Option<T> {
    let m = STATE.get()?;
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    Some(f(&mut g))
}

pub fn start(app: &AppHandle) {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("/tmp"));
    let saved: Saved = std::fs::read_to_string(file(&dir)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    // Wisp died with the lid rule on: switch it off before anything else.
    if marker(&dir).exists() && set_disablesleep(false).is_ok() {
        let _ = std::fs::remove_file(marker(&dir));
    }
    let ready = lid_ready();
    let mut inner = Inner {
        dir,
        saved,
        page_work: vec![],
        page_at: 0,
        tool_work: vec![],
        work_at: 0,
        episode: None,
        caffeinate: None,
        lid_applied: false,
        lid_guard: None,
        battery_lock: false,
        thermal_lock_until: 0,
        sleep_pending: false,
        critical_at: 0,
        others_at: 0,
        status: Status::default(),
    };
    inner.status.lid_ready = ready;
    if !ready && inner.saved.prefs.lid {
        inner.saved.prefs.lid = false;
    }
    let _ = STATE.set(Mutex::new(inner));
    let app = app.clone();
    std::thread::spawn(move || loop {
        with(|i| tick(&app, i));
        std::thread::sleep(Duration::from_secs(5));
    });
}

/// On quit: let go of everything, and give the lid back to macOS.
pub fn shutdown() {
    with(|i| {
        close_episode(i, now());
        hold(i, None);
        if i.lid_applied {
            let _ = set_disablesleep(false);
            let _ = std::fs::remove_file(marker(&i.dir));
            i.lid_applied = false;
        }
    });
}

pub fn status() -> Status {
    with(|i| i.status.clone()).unwrap_or_default()
}

pub fn set_work(names: Vec<String>) {
    with(|i| {
        i.page_work = names;
        i.page_at = now();
    });
}

/// Change some prefs from the panel; `{ "timerMin": 60 }` sets the timer, 0 clears it.
pub fn set(app: &AppHandle, patch: Value) -> Status {
    with(|i| {
        let mut cur = serde_json::to_value(&i.saved.prefs).unwrap_or(Value::Null);
        if let (Value::Object(cur), Value::Object(patch)) = (&mut cur, &patch) {
            for (k, v) in patch {
                if k != "timerMin" {
                    cur.insert(k.clone(), v.clone());
                }
            }
        }
        if let Ok(p) = serde_json::from_value::<Prefs>(cur) {
            i.saved.prefs = p;
        }
        if let Some(min) = patch.get("timerMin").and_then(Value::as_u64) {
            i.saved.prefs.until_ms = (min > 0).then(|| now() + min * 60_000);
        }
        // Switching the lid on without the rule can't work; the panel offers the setup instead.
        if i.saved.prefs.lid && !i.status.lid_ready {
            i.status.lid_ready = lid_ready();
            if !i.status.lid_ready {
                i.saved.prefs.lid = false;
            }
        }
        save(i);
        tick(app, i);
        i.status.clone()
    })
    .unwrap_or_default()
}

pub fn refresh_lid_ready(app: &AppHandle) -> Status {
    with(|i| {
        i.status.lid_ready = lid_ready();
        tick(app, i);
        let _ = app.emit("awake-state", &i.status);
        i.status.clone()
    })
    .unwrap_or_default()
}

/// Let go of everything and sleep now (the panel's button).
pub fn sleep(app: &AppHandle) {
    with(|i| {
        i.saved.prefs.manual = false;
        i.saved.prefs.until_ms = None;
        save(i);
        let _ = apply_lid(i, false);
        hold(i, None);
        close_episode(i, now());
        let _ = app.emit("awake-state", &i.status);
    });
    sleep_now();
}

/// For the Monday summary: last week's extra hours and who they were for, most first.
pub fn week(since_ms: u64, until_ms: u64) -> Option<String> {
    with(|i| {
        let mut total = 0u64;
        let mut by: BTreeMap<String, u64> = BTreeMap::new();
        let mut lid = 0u64;
        for e in i.saved.episodes.iter().filter(|e| e.end >= since_ms && e.start < until_ms) {
            let ms = e.end.min(until_ms) - e.start.max(since_ms);
            total += ms;
            if e.lid {
                lid += ms;
            }
            for w in &e.who {
                *by.entry(w.clone()).or_default() += ms;
            }
        }
        if total < 60_000 {
            return None;
        }
        let fmt = |ms: u64| {
            let (h, m) = (ms / 3_600_000, (ms % 3_600_000) / 60_000);
            if h > 0 { format!("{h} h {m} min") } else { format!("{m} min") }
        };
        let mut top: Vec<(String, u64)> = by.into_iter().collect();
        top.sort_by_key(|t| std::cmp::Reverse(t.1));
        let names: Vec<String> = top.iter().take(3).map(|(n, ms)| format!("{n} {}", fmt(*ms))).collect();
        let mut text = format!("Minulý týden Mac pracoval navíc {}", fmt(total));
        if lid > 0 {
            text.push_str(&format!(", z toho {} se zavřeným víkem", fmt(lid)));
        }
        if !names.is_empty() {
            text.push_str(&format!(". Nejvíc pro: {}", names.join(", ")));
        }
        Some(text)
    })
    .flatten()
}

/// For the morning summary: what kept the Mac awake overnight (since 18:00 yesterday).
pub fn night(since_ms: u64) -> Option<String> {
    with(|i| {
        let list: Vec<&Episode> = i.saved.episodes.iter().filter(|e| e.end >= since_ms).collect();
        if list.is_empty() {
            return None;
        }
        let ms: u64 = list.iter().map(|e| e.end - e.start.max(since_ms)).sum();
        let mut who: BTreeMap<String, ()> = BTreeMap::new();
        for e in &list {
            for w in &e.who {
                who.insert(w.clone(), ());
            }
        }
        let lid = list.iter().any(|e| e.lid);
        let h = ms / 3_600_000;
        let m = (ms % 3_600_000) / 60_000;
        let time = if h > 0 { format!("{h} h {m} min") } else { format!("{m} min") };
        let names: Vec<String> = who.into_keys().take(5).collect();
        Some(format!(
            "Mac jsem držel vzhůru {time}{} pro {}",
            if lid { " (i se zavřeným víkem)" } else { "" },
            names.join(", ")
        ))
    })
    .flatten()
}
