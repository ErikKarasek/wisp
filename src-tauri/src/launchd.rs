//! The user's own launchd agents: what they are, whether they run, and the
//! few things the app may do with them (run now, pause, resume).
//!
//! Only agents whose label starts with one of `PREFIXES` are listed, and every
//! action checks the label against that list first, so the app can never touch
//! a system or third-party job.

use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

const PREFIXES: &[&str] = &["com.erikkarasek.", "ing.paperclip."];
const LAUNCHCTL: &str = "/bin/launchctl";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarTime {
    pub hour: Option<i64>,
    pub minute: Option<i64>,
    pub weekday: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    Calendar { times: Vec<CalendarTime> },
    Interval { seconds: i64 },
    KeepAlive,
    OnLoad,
    Manual,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub label: String,
    pub plist_path: String,
    pub program: Vec<String>,
    pub schedule: Schedule,
    /// Known to launchd right now (bootstrapped).
    pub loaded: bool,
    /// Switched off with `launchctl disable`, so it stays off after a login.
    pub disabled: bool,
    pub running: bool,
    pub pid: Option<i64>,
    pub uptime_secs: Option<i64>,
    pub runs: Option<i64>,
    pub last_exit: Option<i64>,
    pub last_signal: Option<String>,
    pub log_path: Option<String>,
    pub log_modified_ms: Option<i64>,
    pub last_log_line: Option<String>,
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

fn domain() -> String {
    format!("gui/{}", uid())
}

fn agents_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join("Library/LaunchAgents")
}

fn is_ours(label: &str) -> bool {
    PREFIXES.iter().any(|p| label.starts_with(p))
}

fn int(v: Option<&plist::Value>) -> Option<i64> {
    v.and_then(|v| v.as_signed_integer())
}

fn calendar_time(v: &plist::Value) -> Option<CalendarTime> {
    let d = v.as_dictionary()?;
    Some(CalendarTime {
        hour: int(d.get("Hour")),
        minute: int(d.get("Minute")),
        weekday: int(d.get("Weekday")),
    })
}

fn schedule_of(d: &plist::Dictionary) -> Schedule {
    if let Some(v) = d.get("StartCalendarInterval") {
        let times: Vec<CalendarTime> = match v.as_array() {
            Some(list) => list.iter().filter_map(calendar_time).collect(),
            None => calendar_time(v).into_iter().collect(),
        };
        if !times.is_empty() {
            return Schedule::Calendar { times };
        }
    }
    if let Some(seconds) = int(d.get("StartInterval")) {
        return Schedule::Interval { seconds };
    }
    // KeepAlive may be a bool or a dictionary of conditions; either way the job
    // is meant to stay up.
    match d.get("KeepAlive") {
        Some(plist::Value::Boolean(true)) | Some(plist::Value::Dictionary(_)) => {
            return Schedule::KeepAlive
        }
        _ => {}
    }
    if d.get("RunAtLoad").and_then(|v| v.as_boolean()) == Some(true) {
        return Schedule::OnLoad;
    }
    Schedule::Manual
}

/// What `launchctl print` says about a loaded job. `None` when it isn't loaded.
struct Status {
    pid: Option<i64>,
    runs: Option<i64>,
    last_exit: Option<i64>,
    last_signal: Option<String>,
}

fn print_status(label: &str) -> Option<Status> {
    let out = Command::new(LAUNCHCTL)
        .args(["print", &format!("{}/{}", domain(), label)])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Only the job's own top-level fields: they sit one tab deep. Deeper lines
    // belong to sockets, endpoints and the like.
    let field = |name: &str| -> Option<String> {
        text.lines()
            .filter(|l| l.starts_with('\t') && !l.starts_with("\t\t"))
            .find_map(|l| {
                let (k, v) = l.trim().split_once(" = ")?;
                (k == name).then(|| v.trim().to_string())
            })
    };
    Some(Status {
        pid: field("pid").and_then(|v| v.parse().ok()),
        runs: field("runs").and_then(|v| v.parse().ok()),
        last_exit: field("last exit code").and_then(|v| v.parse().ok()),
        last_signal: field("last terminating signal"),
    })
}

fn disabled_labels() -> Vec<String> {
    let Ok(out) = Command::new(LAUNCHCTL)
        .args(["print-disabled", &domain()])
        .output()
    else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (k, v) = l.trim().split_once("=>")?;
            let v = v.trim();
            (v == "disabled" || v == "true").then(|| k.trim().trim_matches('"').to_string())
        })
        .collect()
}

/// `ps` elapsed time, `[[dd-]hh:]mm:ss`, as seconds.
fn uptime(pid: i64) -> Option<i64> {
    let out = Command::new("/bin/ps")
        .args(["-o", "etime=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<i64>().ok()?, r.to_string()),
        None => (0, s),
    };
    let parts: Vec<i64> = rest.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let secs = parts.iter().fold(0, |acc, p| acc * 60 + p);
    Some(days * 86_400 + secs)
}

/// The last `max` lines of a file, reading at most its final 256 KB.
fn tail(path: &str, max: usize) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(256 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = strip_ansi(&String::from_utf8_lossy(&buf));
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let from = lines.len().saturating_sub(max);
    Some(lines[from..].join("\n"))
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn modified_ms(path: &str) -> Option<i64> {
    let t = fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn read_job(path: &Path, disabled: &[String]) -> Option<Job> {
    let value = plist::Value::from_file(path).ok()?;
    let d = value.as_dictionary()?;
    let label = d.get("Label")?.as_string()?.to_string();
    if !is_ours(&label) {
        return None;
    }
    let program = match d.get("ProgramArguments").and_then(|v| v.as_array()) {
        Some(args) => args.iter().filter_map(|a| a.as_string().map(String::from)).collect(),
        None => d
            .get("Program")
            .and_then(|v| v.as_string())
            .map(|p| vec![p.to_string()])
            .unwrap_or_default(),
    };
    let log_path = d
        .get("StandardOutPath")
        .or_else(|| d.get("StandardErrorPath"))
        .and_then(|v| v.as_string())
        .map(String::from);
    let status = print_status(&label);
    let pid = status.as_ref().and_then(|s| s.pid);
    Some(Job {
        plist_path: path.to_string_lossy().into_owned(),
        program,
        schedule: schedule_of(d),
        loaded: status.is_some(),
        disabled: disabled.contains(&label),
        running: pid.is_some(),
        pid,
        uptime_secs: pid.and_then(uptime),
        runs: status.as_ref().and_then(|s| s.runs),
        last_exit: status.as_ref().and_then(|s| s.last_exit),
        last_signal: status.and_then(|s| s.last_signal),
        log_modified_ms: log_path.as_deref().and_then(modified_ms),
        last_log_line: log_path.as_deref().and_then(|p| tail(p, 1)),
        log_path,
        label,
    })
}

pub fn list() -> Vec<Job> {
    let disabled = disabled_labels();
    let Ok(entries) = fs::read_dir(agents_dir()) else {
        return vec![];
    };
    let mut jobs: Vec<Job> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "plist"))
        .filter_map(|p| read_job(&p, &disabled))
        .collect();
    jobs.sort_by(|a, b| a.label.cmp(&b.label));
    jobs
}

fn find(label: &str) -> Result<Job, String> {
    if !is_ours(label) {
        return Err(format!("{label} není tvoje úloha"));
    }
    list()
        .into_iter()
        .find(|j| j.label == label)
        .ok_or_else(|| format!("Úloha {label} nenalezena"))
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new(LAUNCHCTL)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("launchctl {} skončil s kódem {:?}", args[0], out.status.code())
        } else {
            err
        })
    }
}

pub fn log(label: &str, lines: usize) -> Result<String, String> {
    let job = find(label)?;
    let path = job.log_path.ok_or("Úloha nemá log")?;
    Ok(tail(&path, lines.min(500)).unwrap_or_default())
}

/// Start it now. `restart` kills a running copy first (for always-on jobs).
pub fn run(label: &str, restart: bool) -> Result<(), String> {
    let job = find(label)?;
    if !job.loaded {
        return Err("Úloha je vypnutá. Nejdřív ji zapni.".into());
    }
    let target = format!("{}/{}", domain(), job.label);
    if restart {
        launchctl(&["kickstart", "-k", &target])
    } else {
        launchctl(&["kickstart", &target])
    }
}

/// Stop it and keep it stopped across logins.
pub fn pause(label: &str) -> Result<(), String> {
    let job = find(label)?;
    let target = format!("{}/{}", domain(), job.label);
    launchctl(&["disable", &target])?;
    if job.loaded {
        launchctl(&["bootout", &target])?;
    }
    Ok(())
}

pub fn resume(label: &str) -> Result<(), String> {
    let job = find(label)?;
    let target = format!("{}/{}", domain(), job.label);
    launchctl(&["enable", &target])?;
    if !job.loaded {
        launchctl(&["bootstrap", &domain(), &job.plist_path])?;
    }
    Ok(())
}
