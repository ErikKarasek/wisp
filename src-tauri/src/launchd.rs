//! The user's own launchd agents: what they are, whether they run, and the
//! few things the app may do with them (run now, pause, resume).
//!
//! Only agents whose label starts with one of `PREFIXES` are listed, and every
//! action checks the label against that list first, so the app can never touch
//! a system or third-party job.

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

const PREFIXES: &[&str] = &["com.erikkarasek.", "ing.paperclip."];
/// New jobs get this prefix, and this key marks the ones the app made itself:
/// only those can be edited or deleted from the app.
const NEW_PREFIX: &str = "com.erikkarasek.";
const MANAGED_KEY: &str = "cz.erikkarasek.dispecink.managed";
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
    /// Made by Wisp, so it may be edited and deleted here.
    pub managed: bool,
    /// For managed jobs: the shell command and working folder, for the edit form.
    pub command: Option<String>,
    pub working_dir: Option<String>,
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
    let managed = d.get(MANAGED_KEY).and_then(|v| v.as_boolean()) == Some(true);
    let command = managed.then(|| program.get(2).cloned()).flatten();
    let working_dir = d.get("WorkingDirectory").and_then(|v| v.as_string()).map(String::from);
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
        managed,
        command,
        working_dir,
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

// ---------- making jobs ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourMinute {
    pub hour: u8,
    pub minute: u8,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NewSchedule {
    /// At these times; on these weekdays (0 = Sunday), or every day when empty.
    Daily { times: Vec<HourMinute>, weekdays: Vec<u8> },
    Interval { minutes: u32 },
    KeepAlive,
    AtLogin,
    Manual,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub slug: String,
    pub command: String,
    pub working_dir: Option<String>,
    pub schedule: NewSchedule,
    #[serde(default)]
    pub run_now: bool,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn valid_slug(slug: &str) -> bool {
    let mut chars = slug.chars();
    slug.len() <= 40
        && chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn plist_path(label: &str) -> PathBuf {
    agents_dir().join(format!("{label}.plist"))
}

fn write_plist(label: &str, spec: &JobSpec) -> Result<(), String> {
    use plist::{Dictionary, Value};
    let command = spec.command.trim();
    if command.is_empty() {
        return Err("Chybí příkaz.".into());
    }
    let mut d = Dictionary::new();
    d.insert("Label".into(), Value::String(label.into()));
    // A login shell, so the job gets the same PATH (Homebrew, ~/.local/bin) as Terminal.
    d.insert(
        "ProgramArguments".into(),
        Value::Array(vec!["/bin/zsh".into(), "-lc".into(), Value::String(command.into())]),
    );
    let logs = home().join("Library/Logs/Dispecink");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log = logs.join(format!("{}.log", spec.slug)).to_string_lossy().into_owned();
    d.insert("StandardOutPath".into(), Value::String(log.clone()));
    d.insert("StandardErrorPath".into(), Value::String(log));
    if let Some(dir) = spec.working_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        if !Path::new(dir).is_dir() {
            return Err(format!("Složka {dir} neexistuje."));
        }
        d.insert("WorkingDirectory".into(), Value::String(dir.into()));
    }
    match &spec.schedule {
        NewSchedule::Daily { times, weekdays } => {
            if times.is_empty() {
                return Err("Přidej aspoň jeden čas.".into());
            }
            let mut list = Vec::new();
            for t in times {
                if t.hour > 23 || t.minute > 59 {
                    return Err("Neplatný čas.".into());
                }
                let days: Vec<Option<u8>> = if weekdays.is_empty() { vec![None] } else { weekdays.iter().map(|w| Some(*w % 7)).collect() };
                for day in days {
                    let mut e = Dictionary::new();
                    e.insert("Hour".into(), Value::Integer((t.hour as i64).into()));
                    e.insert("Minute".into(), Value::Integer((t.minute as i64).into()));
                    if let Some(day) = day {
                        e.insert("Weekday".into(), Value::Integer((day as i64).into()));
                    }
                    list.push(Value::Dictionary(e));
                }
            }
            d.insert("StartCalendarInterval".into(), Value::Array(list));
        }
        NewSchedule::Interval { minutes } => {
            if *minutes < 1 {
                return Err("Interval musí být aspoň minuta.".into());
            }
            d.insert("StartInterval".into(), Value::Integer((*minutes as i64 * 60).into()));
        }
        NewSchedule::KeepAlive => {
            d.insert("KeepAlive".into(), Value::Boolean(true));
            d.insert("RunAtLoad".into(), Value::Boolean(true));
        }
        NewSchedule::AtLogin => {
            d.insert("RunAtLoad".into(), Value::Boolean(true));
        }
        NewSchedule::Manual => {}
    }
    d.insert(MANAGED_KEY.into(), Value::Boolean(true));
    fs::create_dir_all(agents_dir()).map_err(|e| e.to_string())?;
    let path = plist_path(label);
    let tmp = path.with_extension("plist.tmp");
    Value::Dictionary(d).to_file_xml(&tmp).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn create(spec: &JobSpec) -> Result<String, String> {
    if !valid_slug(&spec.slug) {
        return Err("Zkratka smí mít jen malá písmena bez diakritiky, číslice a pomlčky.".into());
    }
    let label = format!("{NEW_PREFIX}{}", spec.slug);
    if plist_path(&label).exists() || print_status(&label).is_some() {
        return Err(format!("Úloha {label} už existuje."));
    }
    write_plist(&label, spec)?;
    let path = plist_path(&label).to_string_lossy().into_owned();
    if let Err(e) = launchctl(&["bootstrap", &domain(), &path]) {
        let _ = fs::remove_file(&path);
        return Err(e);
    }
    if spec.run_now {
        launchctl(&["kickstart", &format!("{}/{}", domain(), label)])?;
    }
    Ok(label)
}

fn managed(label: &str) -> Result<Job, String> {
    let job = find(label)?;
    if !job.managed {
        return Err("Tuhle úlohu nezaložil Wisp, takže ji tu neměním.".into());
    }
    Ok(job)
}

pub fn update(label: &str, spec: &JobSpec) -> Result<(), String> {
    let job = managed(label)?;
    if label != format!("{NEW_PREFIX}{}", spec.slug) {
        return Err("Zkratka úlohy se měnit nedá.".into());
    }
    let target = format!("{}/{}", domain(), label);
    if job.loaded {
        launchctl(&["bootout", &target])?;
    }
    write_plist(label, spec)?;
    // A paused job stays paused; the new settings apply once it is resumed.
    if !job.disabled {
        launchctl(&["bootstrap", &domain(), &job.plist_path])?;
    }
    if spec.run_now && !job.disabled {
        launchctl(&["kickstart", &target])?;
    }
    Ok(())
}

/// Stops the job and removes its plist. Its log stays in ~/Library/Logs/Dispecink.
pub fn delete(label: &str) -> Result<(), String> {
    let job = managed(label)?;
    let target = format!("{}/{}", domain(), label);
    if job.loaded {
        launchctl(&["bootout", &target])?;
    }
    let _ = launchctl(&["enable", &target]); // forget a leftover "disabled" flag
    fs::remove_file(&job.plist_path).map_err(|e| e.to_string())
}

