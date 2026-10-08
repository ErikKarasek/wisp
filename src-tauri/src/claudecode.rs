//! Claude Code sessions in the notch, like Coucou: what each session in a
//! terminal is doing right now, and its permission prompts answered from the
//! notch. Claude Code's hooks (see `install_hooks`) post to a tiny HTTP server
//! on 127.0.0.1; when Wisp isn't running, the hooks fail silently and
//! Claude Code asks in the terminal as usual.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const PORT: u16 = 47811;
/// How long a permission prompt waits in the notch before the terminal asks.
const HOLD: Duration = Duration::from_secs(60);
/// Away from the Mac, it waits this long for an answer from the phone.
const HOLD_AWAY: Duration = Duration::from_secs(600);
/// Claude's own question (AskUserQuestion) waits longer: it has to be read, not just waved through.
const HOLD_ASK: Duration = Duration::from_secs(150);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CcEvent {
    pub session: String,
    pub project: String,
    /// "step", "done", "waiting", "prompt", "start", "end"
    pub kind: &'static str,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CcPermission {
    pub id: String,
    pub session: String,
    pub project: String,
    pub tool: String,
    pub detail: String,
    /// The rule "Vždy" adds, e.g. `Bash(git push *)`.
    pub rule: String,
}

static PENDING: Mutex<Option<HashMap<String, Sender<String>>>> = Mutex::new(None);
/// A secret in the hook URLs, so another local program can't feed Claude permission answers.
static KEY: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// The secret, made once and kept in the app's config folder. `None` when the
/// random bytes for it couldn't be read: a key that isn't random is no secret,
/// so Wisp then does without the hooks instead of trusting a guessable one.
fn key() -> Option<&'static str> {
    KEY.get_or_init(|| {
        let path = dirs_config().join("cc-hook-key");
        if let Ok(k) = std::fs::read_to_string(&path) {
            let k = k.trim().to_string();
            if k.len() >= 32 {
                return Some(k);
            }
        }
        let mut bytes = [0u8; 24];
        let mut f = match std::fs::File::open("/dev/urandom") {
            Ok(f) => f,
            Err(e) => {
                eprintln!("Claude Code hooks: /dev/urandom can't be opened ({e})");
                return None;
            }
        };
        if let Err(e) = f.read_exact(&mut bytes) {
            eprintln!("Claude Code hooks: /dev/urandom can't be read ({e})");
            return None;
        }
        let k: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let _ = std::fs::create_dir_all(dirs_config());
        let _ = std::fs::write(&path, &k);
        // Only Erik's account may read it.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        Some(k)
    })
    .as_deref()
}

fn dirs_config() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/cz.erikkarasek.dispecink")
}
/// The prompts themselves, for the phone.
static ASKS: Mutex<Vec<CcPermission>> = Mutex::new(Vec::new());

/// Permission prompts waiting for an answer right now.
pub fn pending() -> Vec<CcPermission> {
    ASKS.lock().map(|a| a.clone()).unwrap_or_default()
}

fn short(s: &str, n: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() > n {
        format!("{}…", line.chars().take(n).collect::<String>())
    } else {
        line.to_string()
    }
}

fn file_name(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

/// A file this big is not worth reading just to count its lines.
const MAX_DIFF: u64 = 200 * 1024;

/// How many lines a change adds and removes, counted the way a diff would:
/// lines that stay the same on both sides are not counted twice.
fn counts(old: &str, new: &str) -> (usize, usize) {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    // Cut the matching start and end off first. Claude usually replaces a whole
    // block to change a line or two in it, and this leaves only the real change,
    // small enough for the quadratic part below.
    let head = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
    let (ra, rb) = (&a[head..], &b[head..]);
    let tail = ra.iter().rev().zip(rb.iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&ra[..ra.len() - tail], &rb[..rb.len() - tail]);
    // Past this the longest common subsequence costs more than the answer is
    // worth; count the blocks whole instead, which is what a diff shows anyway
    // when nothing in them lines up.
    if a.len() * b.len() > 250_000 {
        return (b.len(), a.len());
    }
    // Only the length of the longest common subsequence is needed, so one row is enough.
    let mut row = vec![0usize; b.len() + 1];
    for x in a {
        let mut corner = 0;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y { corner + 1 } else { above.max(row[j]) };
            corner = above;
        }
    }
    let same = row[b.len()];
    (b.len() - same, a.len() - same)
}

/// " +12 -3" behind the file name, or nothing when there is nothing honest to say.
fn churn(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    let edit = |e: &Value| {
        let g = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or("");
        counts(g("old_string"), g("new_string"))
    };
    let (add, del) = match tool {
        "Edit" => edit(input),
        "MultiEdit" => input.get("edits").and_then(Value::as_array).map_or((0, 0), |es| {
            es.iter().fold((0, 0), |(a, d), e| {
                let (x, y) = edit(e);
                (a + x, d + y)
            })
        }),
        // PreToolUse runs before the write, so the file on disk is still the old one.
        "Write" => match std::fs::metadata(s("file_path")) {
            // A file that is there but cannot be read or weighed is better left
            // uncounted than counted as if it were new.
            Ok(m) if m.is_file() => {
                if m.len() > MAX_DIFF {
                    return String::new();
                }
                match std::fs::read_to_string(s("file_path")) {
                    Ok(was) => counts(&was, s("content")),
                    Err(_) => return String::new(),
                }
            }
            _ => counts("", s("content")),
        },
        _ => return String::new(),
    };
    match (add, del) {
        (0, 0) => String::new(),
        // A new file or a pure deletion reads better without the zero half.
        (a, 0) => format!(" +{a}"),
        (0, d) => format!(" -{d}"),
        (a, d) => format!(" +{a} -{d}"),
    }
}

/// What a tool call is doing, in a few Czech words.
fn step(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "Bash" => format!("Spouští: {}", short(s("command"), 90)),
        "Read" => format!("Čte {}", file_name(s("file_path"))),
        "Edit" | "MultiEdit" => format!("Upravuje {}{}", file_name(s("file_path")), churn(tool, input)),
        "Write" => format!("Píše {}{}", file_name(s("file_path")), churn(tool, input)),
        "NotebookEdit" => format!("Upravuje {}", file_name(s("notebook_path"))),
        "Grep" => format!("Hledá „{}“", short(s("pattern"), 60)),
        "Glob" => format!("Hledá soubory {}", short(s("pattern"), 60)),
        "WebFetch" => format!("Čte web {}", short(s("url"), 70)),
        "WebSearch" => format!("Hledá na webu „{}“", short(s("query"), 60)),
        "Task" | "Agent" => format!("Posílá agenta: {}", short(s("description"), 70)),
        "TodoWrite" => "Plánuje kroky".into(),
        // The question itself goes to the notch from the `/cc/ask` hook; the ticker only says
        // what is going on, so it does not read out the tool's name.
        "AskUserQuestion" => "Na něco se ptá".into(),
        t if t.starts_with("mcp__") => format!("Nástroj {}", t.trim_start_matches("mcp__").replace("__", " › ")),
        t => t.to_string(),
    }
}

/// The detail a permission prompt shows: the command itself, or the file.
fn detail(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "Bash" => short(s("command"), 160),
        // The size of the change belongs on the permission card too: it is the
        // difference between waving through a typo and a rewrite.
        "Read" | "Edit" | "MultiEdit" | "Write" => {
            format!("{}{}", s("file_path").replace(&std::env::var("HOME").unwrap_or_default(), "~"), churn(tool, input))
        }
        "WebFetch" => s("url").to_string(),
        _ => step(tool, input),
    }
}

/// "Vždy" allows the same kind of call from now on: for Bash the first two
/// words (`git push *`), otherwise the whole tool.
fn rule(tool: &str, input: &Value) -> String {
    if tool == "Bash" {
        let cmd = input.get("command").and_then(Value::as_str).unwrap_or("");
        let words: Vec<&str> = cmd.split_whitespace().take(2).collect();
        if !words.is_empty() {
            return format!("Bash({} *)", words.join(" "));
        }
    }
    tool.to_string()
}

fn project(v: &Value) -> String {
    let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("").trim_end_matches('/');
    // A Paperclip agent's Claude works in .paperclip/…/workspaces/<agent id>: name it by the
    // agent ("agent:<id>"), the notch turns that into the agent's name.
    if let Some(id) = agent_workspace(cwd) {
        return format!("agent:{id}");
    }
    file_name(cwd)
}

/// The agent id when this Claude session is one of Paperclip's agents, not Erik in a terminal.
fn agent_workspace(cwd: &str) -> Option<&str> {
    let (_, rest) = cwd.split_once("/.paperclip/")?;
    let (_, id) = rest.split_once("/workspaces/")?;
    Some(id.split('/').next().unwrap_or(id))
}

fn event(v: &Value) -> Option<CcEvent> {
    let name = v.get("hook_event_name").and_then(Value::as_str)?;
    let session = v.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
    let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    let (kind, text) = match name {
        "PreToolUse" => ("step", step(tool, &input)),
        "UserPromptSubmit" => ("prompt", short(v.get("user_input").or(v.get("prompt")).and_then(Value::as_str).unwrap_or(""), 90)),
        "Stop" => ("done", short(v.get("last_assistant_message").and_then(Value::as_str).unwrap_or("Hotovo."), 120)),
        "Notification" => ("waiting", short(v.get("message").and_then(Value::as_str).unwrap_or("Čeká na tebe."), 120)),
        "SessionStart" => ("start", String::new()),
        "SessionEnd" => ("end", String::new()),
        _ => return None,
    };
    Some(CcEvent { session, project: project(v), kind, text })
}

// ---------- Wisp Buddy ----------

/// The last state the page sent to the notch ("dispecink-state"), for Wisp Buddy to read.
static STATE: Mutex<Option<Value>> = Mutex::new(None);

pub fn remember_state(json: &str) {
    if let (Ok(v), Ok(mut s)) = (serde_json::from_str::<Value>(json), STATE.lock()) {
        *s = Some(v);
    }
}

/// Claude's five-hour limit, used so far in percent (as the page last saw it).
pub fn claude_session_percent() -> Option<f64> {
    STATE.lock().ok()?.as_ref()?["usage"]["session"]["percent"].as_f64()
}

/// What the buddy needs, and no more: who works, who failed or waits, and Claude's limits.
/// No agent conversations, no tokens.
fn buddy_summary() -> Value {
    let Some(s) = STATE.lock().ok().and_then(|s| s.clone()) else { return json!({ "ready": false }) };
    let item = |i: &Value| json!({ "id": i["id"], "name": i["name"], "state": i["state"], "doing": i["doing"], "character": i["character"] });
    let items: Vec<Value> = s["items"].as_array().map(|a| a.iter().map(item).collect()).unwrap_or_default();
    let live: Vec<Value> = s["live"]
        .as_array()
        .map(|a| a.iter().map(|l| json!({ "name": l["name"], "lines": l["lines"], "character": l["character"] })).collect())
        .unwrap_or_default();
    json!({
        "ready": true,
        "at": s["at"],
        "counts": s["counts"],
        "items": items,
        "live": live,
        "claude": { "session": s["usage"]["session"]["percent"], "week": s["usage"]["week"]["percent"] },
        "focus": s["focus"],
    })
}

fn respond(req: tiny_http::Request, body: String) {
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body).with_header(header));
}

fn permission(app: &AppHandle, v: &Value) -> String {
    // An agent's own Claude decides by its own permission mode; asking Erik in the notch would
    // only hold the agent up for a minute on every step.
    if agent_workspace(v.get("cwd").and_then(Value::as_str).unwrap_or("")).is_some() {
        return String::new();
    }
    let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
    // AskUserQuestion has nothing to permit: the question itself is the prompt, and the
    // `/cc/ask` hook already put it in the notch (or left it to the terminal). A permission
    // card for it would only say "Claude chce použít AskUserQuestion" and cover the real one.
    if tool == "AskUserQuestion" {
        return json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }).to_string();
    }
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    let id = v
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| format!("p{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
    let ask = CcPermission {
        id: id.clone(),
        session: v.get("session_id").and_then(Value::as_str).unwrap_or("").to_string(),
        project: project(v),
        detail: detail(&tool, &input),
        rule: rule(&tool, &input),
        tool,
    };
    ASKS.lock().unwrap().push(ask.clone());
    let (tx, rx) = channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    let _ = app.emit("cc-permission", ask.clone());
    crate::notch::peek(app, HOLD.as_millis() as u64);
    // Away from the Mac for two minutes: the same question with buttons on the phone.
    let phone = crate::telegram::remote(app).filter(|_| crate::telegram::idle_secs() >= 120).and_then(|r| {
        let text = format!("{} · Claude chce {}:\n{}", ask.project, if ask.tool == "Bash" { "spustit" } else { "použít nástroj" }, ask.detail);
        let buttons = [
            ("Povolit", format!("cc:allow:{id}")),
            ("Vždy", format!("cc:always:{id}")),
            ("Zamítnout", format!("cc:deny:{id}")),
        ];
        tauri::async_runtime::block_on(crate::telegram::send_buttons(&r, &text, &buttons)).ok().map(|m| (r, m, text))
    });
    let answer = rx.recv_timeout(if phone.is_some() { HOLD_AWAY } else { HOLD }).unwrap_or_default();
    if let Some((r, m, text)) = phone {
        let what = match answer.as_str() {
            "allow" => "✓ povoleno",
            "always" => "✓ povoleno i příště",
            "deny" => "✗ zamítnuto",
            _ => "→ zeptá se terminál",
        };
        tauri::async_runtime::block_on(crate::telegram::edit(&r, m, &format!("{text}\n\n{what}")));
    }
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
    ASKS.lock().unwrap().retain(|a| a.id != id);
    let _ = app.emit("cc-permission-done", id);
    crate::notch::release();
    let decision = match answer.as_str() {
        "allow" => json!({ "behavior": "allow" }),
        "always" => json!({ "behavior": "allow", "addPermissionRules": [ask.rule] }),
        "deny" => json!({ "behavior": "deny", "message": "Zamítnuto ve Wispu." }),
        // "terminal" or no answer: Claude Code asks in the terminal.
        _ => return String::new(),
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string()
}

// ---------- AskUserQuestion: Claude's own question, answered in the notch ----------

#[derive(Serialize, Clone)]
pub struct CcOption {
    pub label: String,
    pub description: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CcQuestionItem {
    pub question: String,
    pub header: String,
    pub options: Vec<CcOption>,
    pub multi: bool,
}

#[derive(Serialize, Clone)]
pub struct CcQuestion {
    pub id: String,
    pub project: String,
    pub items: Vec<CcQuestionItem>,
}

/// Claude Code's shape: 1 to 4 questions, each with 2 to 4 options. Anything else is
/// None, and the question goes back to the terminal rather than into a half-drawn card.
fn questions(input: Option<&Value>) -> Option<Vec<CcQuestionItem>> {
    let raw = input?.get("questions")?.as_array()?;
    if raw.is_empty() || raw.len() > 4 {
        return None;
    }
    let mut items = Vec::new();
    for q in raw {
        let question = q.get("question").and_then(Value::as_str).filter(|s| !s.is_empty())?;
        let opts = q.get("options")?.as_array()?;
        if opts.len() < 2 || opts.len() > 4 {
            return None;
        }
        let mut options = Vec::new();
        for o in opts {
            let label = o.get("label").and_then(Value::as_str).filter(|s| !s.is_empty())?;
            options.push(CcOption {
                label: label.to_string(),
                description: o.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
            });
        }
        items.push(CcQuestionItem {
            question: question.to_string(),
            header: q.get("header").and_then(Value::as_str).unwrap_or("").chars().take(12).collect(),
            options,
            multi: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    Some(items)
}

/// The PreToolUse hook matched on AskUserQuestion: hold the tool while the notch
/// shows the choices, then hand Claude Code the answers as the tool's input.
fn question(app: &AppHandle, v: &Value) -> String {
    if v.get("tool_name").and_then(Value::as_str) != Some("AskUserQuestion") {
        return String::new();
    }
    let Some(items) = questions(v.get("tool_input")) else { return String::new() };
    let id = format!("q{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let q = CcQuestion { id: id.clone(), project: project(v), items };
    let (tx, rx) = channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    let _ = app.emit("cc-question", q);
    crate::notch::peek(app, HOLD_ASK.as_millis() as u64);
    let answer = rx.recv_timeout(HOLD_ASK).unwrap_or_default();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
    let _ = app.emit("cc-question-done", id);
    crate::notch::release();
    // The notch sends {"<question>": "<label>"}, or a list of labels where several
    // answers are allowed. Nothing usable (Terminál, or no answer at all) and Claude
    // Code asks in the terminal, exactly as it would without Wisp.
    ask_output(v.pointer("/tool_input/questions"), &answer)
}

/// What Claude Code gets back: the questions it asked, plus the answers, as the
/// tool's new input. An answer that is not a filled-in object (Terminál, or nobody
/// answered) gives nothing back, and Claude Code asks in the terminal as it would
/// without Wisp.
fn ask_output(asked: Option<&Value>, answer: &str) -> String {
    let Ok(answers) = serde_json::from_str::<Value>(answer) else { return String::new() };
    if !answers.as_object().is_some_and(|m| !m.is_empty()) {
        return String::new();
    }
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": {
                "questions": asked.cloned().unwrap_or_else(|| json!([])),
                "answers": answers,
            },
        }
    })
    .to_string()
}

/// The answer from the notch's buttons.
pub fn decide(id: &str, answer: &str) -> bool {
    let tx = PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(id);
    tx.is_some_and(|tx| tx.send(answer.to_string()).is_ok())
}

pub fn start(app: &AppHandle) {
    // The secret guards the permission answers. Without one the server still runs for /notify and /focus, which
    // local scripts use without a key, and every /cc/ request gets 403, so Claude Code asks in the terminal.
    if key().is_none() {
        eprintln!("Claude Code hooks: no secret, so /cc/ stays closed");
    }
    let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Claude Code hooks: port {PORT} is taken ({e})");
            return;
        }
    };
    // The key file from older versions was readable by every account on the Mac.
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dirs_config().join("cc-hook-key"), std::fs::Permissions::from_mode(0o600));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            // Each request on its own thread, so one slow sender can't hold up the
            // rest; a cap keeps a flood from spawning without end.
            if BUSY.fetch_add(1, Ordering::SeqCst) >= MAX_BUSY {
                BUSY.fetch_sub(1, Ordering::SeqCst);
                let _ = req.respond(tiny_http::Response::from_string("").with_status_code(503));
                continue;
            }
            let app = app.clone();
            std::thread::spawn(move || {
                handle(&app, req);
                BUSY.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
}

/// Requests in flight, and how many may be at once (permission prompts wait for minutes).
static BUSY: AtomicUsize = AtomicUsize::new(0);
const MAX_BUSY: usize = 32;
/// Hook payloads are small; a file Claude writes can make one bigger, never this big.
const MAX_BODY: u64 = 1 << 20;

/// Only local programs that talk to us directly. A web page in a browser can
/// also send to 127.0.0.1, but it always says where it comes from (Origin), and
/// a rebound domain name shows up in Host; curl and the scripts send neither.
fn from_local_program(req: &tiny_http::Request) -> bool {
    let header = |name: &'static str| req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_ascii_lowercase());
    if header("Origin").is_some() || header("Sec-Fetch-Site").is_some() {
        return false;
    }
    header("Host").is_none_or(|h| h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"))
}

fn handle(app: &AppHandle, mut req: tiny_http::Request) {
    if !from_local_program(&req) || req.body_length().is_some_and(|n| n as u64 > MAX_BODY) {
        let _ = req.respond(tiny_http::Response::from_string("").with_status_code(403));
        return;
    }
    let (path, query) = req.url().split_once('?').unwrap_or((req.url(), ""));
    let path = path.to_string();
    // Claude Code's hooks and Wisp Buddy carry the secret; anything else gets nothing, before
    // its body is even read.
    if (path.starts_with("/cc/") || path.starts_with("/buddy/")) && !key().is_some_and(|k| query.split('&').any(|p| p == format!("k={k}"))) {
        let _ = req.respond(tiny_http::Response::from_string("").with_status_code(403));
        return;
    }
    if path == "/buddy/state" {
        return respond(req, buddy_summary().to_string());
    }
    if !matches!(path.as_str(), "/cc/event" | "/cc/permission" | "/cc/ask" | "/notify" | "/focus/on" | "/focus/off") {
        let _ = req.respond(tiny_http::Response::from_string("").with_status_code(404));
        return;
    }
    let mut body = String::new();
    let _ = req.as_reader().take(MAX_BODY).read_to_string(&mut body);
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    match path.as_str() {
        "/cc/event" => {
            if let Some(e) = event(&v) {
                let _ = app.emit("cc-event", e);
            }
            respond(req, String::new());
        }
        "/cc/permission" => {
            let out = permission(app, &v);
            respond(req, out);
        }
        "/cc/ask" => {
            let out = question(app, &v);
            respond(req, out);
        }
        // Local scripts (the watchers in ~/Developer/hlidaci): a message for Erik.
        "/notify" => {
            let _ = app.emit_to("main", "notify", v);
            respond(req, String::new());
        }
        // A Shortcuts automation when a macOS Focus turns on or off.
        _ => {
            let _ = app.emit("focus", path == "/focus/on");
            respond(req, String::new());
        }
    }
}

// ---------- the hooks in ~/.claude/settings.json ----------

const MARK: &str = "127.0.0.1:47811/cc/";

fn settings_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude/settings.json")
}

fn hook(key: &str, url: &str, timeout: u64, async_: bool) -> Value {
    // curl, not an http hook: when Wisp is off it fails silently instead
    // of leaving an error notice in every session.
    let max = if async_ { 2 } else { timeout - 5 };
    let mut h = json!({
        "type": "command",
        "command": format!("curl -s -m {max} -H 'content-type: application/json' --data-binary @- 'http://{MARK}{url}?k={key}' 2>/dev/null || true"),
        "timeout": timeout,
    });
    if async_ {
        h["async"] = json!(true);
    }
    h
}

/// Whether Wisp's hooks are in Claude Code's settings.
pub fn hooks_installed() -> bool {
    std::fs::read_to_string(settings_path()).is_ok_and(|s| s.contains(MARK))
}

/// Add (or remove) Wisp's hooks, keeping everything else in the file.
pub fn set_hooks(on: bool) -> Result<(), String> {
    let path = settings_path();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
    let mut v: Value = serde_json::from_str(&text).map_err(|e| format!("settings.json se nedá přečíst: {e}"))?;
    if !v.is_object() {
        return Err("settings.json nemá tvar, jaký čekám.".into());
    }
    let hooks = v.as_object_mut().unwrap().entry("hooks").or_insert_with(|| json!({}));
    let Some(hooks) = hooks.as_object_mut() else { return Err("hooks v settings.json nejsou objekt.".into()) };
    // Drop ours from every event first, so this is safe to run twice.
    for list in hooks.values_mut() {
        if let Some(groups) = list.as_array_mut() {
            for g in groups.iter_mut() {
                if let Some(hs) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                    hs.retain(|h| !h.get("command").and_then(Value::as_str).is_some_and(|c| c.contains(MARK)));
                }
            }
            groups.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|hs| !hs.is_empty()));
        }
    }
    hooks.retain(|_, list| list.as_array().is_none_or(|a| !a.is_empty()));
    if on {
        // No secret, no hooks: settings.json stays as it is.
        let Some(key) = key() else {
            return Err("Tajný klíč pro hooky se nepodařilo vytvořit.".into());
        };
        let add = |hooks: &mut serde_json::Map<String, Value>, event: &str, h: Value| {
            let list = hooks.entry(event).or_insert_with(|| json!([]));
            if let Some(a) = list.as_array_mut() {
                a.push(json!({ "hooks": [h] }));
            }
        };
        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"] {
            add(hooks, event, hook(key, "event", 5, true));
        }
        add(hooks, "PermissionRequest", hook(key, "permission", HOLD_AWAY.as_secs() + 15, false));
        // AskUserQuestion needs its own PreToolUse entry: the one above is async and
        // fire-and-forget, this one holds the tool until the notch has the answer.
        if let Some(list) = hooks.entry("PreToolUse").or_insert_with(|| json!([])).as_array_mut() {
            list.push(json!({ "matcher": "AskUserQuestion", "hooks": [hook(key, "ask", HOLD_ASK.as_secs() + 15, false)] }));
        }
    }
    let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.dispecink-tmp");
    std::fs::write(&tmp, out + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod ask_tests {
    use super::*;

    fn input(questions: Value) -> Value {
        json!({ "questions": questions })
    }

    #[test]
    fn reads_claude_codes_shape() {
        let v = input(json!([{
            "question": "Kterou cestou?", "header": "Přístup", "multiSelect": true,
            "options": [{"label": "Rychle", "description": "Dneska"}, {"label": "Pořádně"}],
        }]));
        let items = questions(Some(&v)).expect("a well-formed question");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].header, "Přístup");
        assert!(items[0].multi);
        assert_eq!(items[0].options.len(), 2);
        // A missing description is empty, not a reason to drop the question.
        assert_eq!(items[0].options[1].description, "");
    }

    #[test]
    fn a_header_longer_than_twelve_is_cut() {
        let v = input(json!([{
            "question": "q", "header": "Dlouhatánský nadpis",
            "options": [{"label": "a"}, {"label": "b"}],
        }]));
        let items = questions(Some(&v)).unwrap();
        assert_eq!(items[0].header.chars().count(), 12);
    }

    #[test]
    fn anything_outside_the_shape_goes_to_the_terminal() {
        // One option, five options, no options, no questions, an empty label, nothing at all.
        for bad in [
            input(json!([{ "question": "q", "options": [{"label": "a"}] }])),
            input(json!([{ "question": "q", "options": (0..5).map(|i| json!({"label": i.to_string()})).collect::<Vec<_>>() }])),
            input(json!([{ "question": "q" }])),
            input(json!([])),
            input(json!([{ "question": "q", "options": [{"label": ""}, {"label": "b"}] }])),
            json!({}),
        ] {
            assert!(questions(Some(&bad)).is_none(), "should be refused: {bad}");
        }
        assert!(questions(None).is_none());
    }

    #[test]
    fn five_questions_are_too_many() {
        let v = input((0..5).map(|_| json!({ "question": "q", "options": [{"label": "a"}, {"label": "b"}] })).collect::<Vec<_>>().into());
        assert!(questions(Some(&v)).is_none());
    }

    #[test]
    fn the_answer_carries_the_questions_back() {
        let asked = json!([{ "question": "Kterou cestou?", "options": [{"label": "Rychle"}, {"label": "Pořádně"}] }]);
        let out = ask_output(Some(&asked), r#"{"Kterou cestou?":"Rychle"}"#);
        let v: Value = serde_json::from_str(&out).unwrap();
        let o = &v["hookSpecificOutput"];
        assert_eq!(o["hookEventName"], "PreToolUse");
        assert_eq!(o["permissionDecision"], "allow");
        assert_eq!(o["updatedInput"]["questions"], asked);
        assert_eq!(o["updatedInput"]["answers"]["Kterou cestou?"], "Rychle");
    }

    #[test]
    fn several_answers_stay_a_list() {
        let out = ask_output(None, r#"{"Co zapnout?":["A","B"]}"#);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hookSpecificOutput"]["updatedInput"]["answers"]["Co zapnout?"], json!(["A", "B"]));
    }

    #[test]
    fn no_usable_answer_means_the_terminal() {
        // Terminál, a timeout (empty), an empty object, and something that is not an object.
        for answer in ["terminal", "", "{}", "\"Rychle\"", "null"] {
            assert_eq!(ask_output(None, answer), "", "should fall back: {answer:?}");
        }
    }
}

#[cfg(test)]
mod churn_tests {
    use super::*;

    #[test]
    fn nothing_changed_is_nothing_shown() {
        assert_eq!(counts("a\nb\nc", "a\nb\nc"), (0, 0));
        assert_eq!(churn("Edit", &json!({ "old_string": "a\nb", "new_string": "a\nb" })), "");
    }

    #[test]
    fn only_the_changed_lines_count() {
        // A whole block replaced to change the middle line: a diff shows +1 -1,
        // not +3 -3, and so should the ticker.
        let old = "fn a() {\n    let x = 1;\n}";
        let new = "fn a() {\n    let x = 2;\n}";
        assert_eq!(counts(old, new), (1, 1));
    }

    #[test]
    fn added_and_removed_lines() {
        assert_eq!(counts("a\nb", "a\nb\nc\nd"), (2, 0));
        assert_eq!(counts("a\nb\nc", "a"), (0, 2));
        assert_eq!(counts("", "a\nb\nc"), (3, 0));
        assert_eq!(counts("a\nb\nc", ""), (0, 3));
    }

    #[test]
    fn a_moved_line_reads_as_one_added_and_one_removed() {
        assert_eq!(counts("a\nb\nc", "b\nc\na"), (1, 1));
    }

    #[test]
    fn an_edit_is_labelled() {
        let v = json!({ "file_path": "/x/mini.ts", "old_string": "a\nb\nc", "new_string": "a\nZ\nc" });
        assert_eq!(churn("Edit", &v), " +1 -1");
        assert_eq!(step("Edit", &v), "Upravuje mini.ts +1 -1");
    }

    #[test]
    fn multiedit_adds_its_edits_up() {
        let v = json!({ "file_path": "/x/a.rs", "edits": [
            { "old_string": "a", "new_string": "b" },
            { "old_string": "c\nd", "new_string": "c\nd\ne\nf" },
        ]});
        assert_eq!(churn("MultiEdit", &v), " +3 -1");
    }

    #[test]
    fn a_write_to_a_file_that_is_not_there_is_all_new() {
        let v = json!({ "file_path": "/nekde/takovy/soubor/nenitu.txt", "content": "a\nb\nc" });
        assert_eq!(churn("Write", &v), " +3");
    }

    #[test]
    fn a_write_over_a_file_counts_against_what_is_in_it() {
        let dir = std::env::temp_dir().join("wisp-churn-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, "a\nb\nc\n").unwrap();
        let v = json!({ "file_path": f.to_string_lossy(), "content": "a\nZ\nc\n" });
        assert_eq!(churn("Write", &v), " +1 -1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tools_that_change_nothing_say_nothing() {
        for tool in ["Read", "Bash", "Grep"] {
            assert_eq!(churn(tool, &json!({ "file_path": "/x/a", "command": "ls" })), "");
        }
        assert_eq!(step("Read", &json!({ "file_path": "/x/mini.ts" })), "Čte mini.ts");
        // Not "AskUserQuestion": the question has its own card in the notch.
        assert_eq!(step("AskUserQuestion", &json!({})), "Na něco se ptá");
    }

    #[test]
    fn a_huge_rewrite_still_answers_quickly() {
        let old: String = (0..3000).map(|i| format!("řádek {i}\n")).collect();
        let new: String = (0..3000).map(|i| format!("jiný řádek {i}\n")).collect();
        let t = std::time::Instant::now();
        let (add, del) = counts(&old, &new);
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "trvalo {:?}", t.elapsed());
        assert_eq!((add, del), (3000, 3000));
    }
}
