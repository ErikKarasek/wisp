//! Claude Code sessions in the notch, like Coucou: what each session in a
//! terminal is doing right now, and its permission prompts answered from the
//! notch. Claude Code's hooks (see `install_hooks`) post to a tiny HTTP server
//! on 127.0.0.1; when Dispečink isn't running, the hooks fail silently and
//! Claude Code asks in the terminal as usual.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const PORT: u16 = 47811;
/// How long a permission prompt waits in the notch before the terminal asks.
const HOLD: Duration = Duration::from_secs(60);

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

/// What a tool call is doing, in a few Czech words.
fn step(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "Bash" => format!("Spouští: {}", short(s("command"), 90)),
        "Read" => format!("Čte {}", file_name(s("file_path"))),
        "Edit" | "MultiEdit" => format!("Upravuje {}", file_name(s("file_path"))),
        "Write" => format!("Píše {}", file_name(s("file_path"))),
        "NotebookEdit" => format!("Upravuje {}", file_name(s("notebook_path"))),
        "Grep" => format!("Hledá „{}“", short(s("pattern"), 60)),
        "Glob" => format!("Hledá soubory {}", short(s("pattern"), 60)),
        "WebFetch" => format!("Čte web {}", short(s("url"), 70)),
        "WebSearch" => format!("Hledá na webu „{}“", short(s("query"), 60)),
        "Task" | "Agent" => format!("Posílá agenta: {}", short(s("description"), 70)),
        "TodoWrite" => "Plánuje kroky".into(),
        t if t.starts_with("mcp__") => format!("Nástroj {}", t.trim_start_matches("mcp__").replace("__", " › ")),
        t => t.to_string(),
    }
}

/// The detail a permission prompt shows: the command itself, or the file.
fn detail(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "Bash" => short(s("command"), 160),
        "Read" | "Edit" | "MultiEdit" | "Write" => s("file_path").replace(&std::env::var("HOME").unwrap_or_default(), "~"),
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
    file_name(v.get("cwd").and_then(Value::as_str).unwrap_or("").trim_end_matches('/'))
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

fn respond(req: tiny_http::Request, body: String) {
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body).with_header(header));
}

fn permission(app: &AppHandle, v: &Value) -> String {
    let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
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
    let (tx, rx) = channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    let _ = app.emit("cc-permission", ask.clone());
    crate::notch::peek(app, HOLD.as_millis() as u64);
    let answer = rx.recv_timeout(HOLD).unwrap_or_default();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
    let _ = app.emit("cc-permission-done", id);
    crate::notch::release();
    let decision = match answer.as_str() {
        "allow" => json!({ "behavior": "allow" }),
        "always" => json!({ "behavior": "allow", "addPermissionRules": [ask.rule] }),
        "deny" => json!({ "behavior": "deny", "message": "Zamítnuto v Dispečinku." }),
        // "terminal" or no answer: Claude Code asks in the terminal.
        _ => return String::new(),
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }).to_string()
}

/// The answer from the notch's buttons.
pub fn decide(id: &str, answer: &str) -> bool {
    let tx = PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(id);
    tx.is_some_and(|tx| tx.send(answer.to_string()).is_ok())
}

pub fn start(app: &AppHandle) {
    let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Claude Code hooks: port {PORT} is taken ({e})");
            return;
        }
    };
    let app = app.clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().take(1 << 20).read_to_string(&mut body);
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            match req.url() {
                "/cc/event" => {
                    if let Some(e) = event(&v) {
                        let _ = app.emit("cc-event", e);
                    }
                    respond(req, String::new());
                }
                "/cc/permission" => {
                    // Each prompt waits on its own thread, so sessions don't queue behind each other.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let out = permission(&app, &v);
                        respond(req, out);
                    });
                }
                _ => respond(req, String::new()),
            }
        }
    });
}

// ---------- the hooks in ~/.claude/settings.json ----------

const MARK: &str = "127.0.0.1:47811/cc/";

fn settings_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude/settings.json")
}

fn hook(url: &str, timeout: u64, async_: bool) -> Value {
    // curl, not an http hook: when Dispečink is off it fails silently instead
    // of leaving an error notice in every session.
    let max = if async_ { 2 } else { timeout - 5 };
    let mut h = json!({
        "type": "command",
        "command": format!("curl -s -m {max} -H 'content-type: application/json' --data-binary @- http://{MARK}{url} 2>/dev/null || true"),
        "timeout": timeout,
    });
    if async_ {
        h["async"] = json!(true);
    }
    h
}

/// Whether Dispečink's hooks are in Claude Code's settings.
pub fn hooks_installed() -> bool {
    std::fs::read_to_string(settings_path()).is_ok_and(|s| s.contains(MARK))
}

/// Add (or remove) Dispečink's hooks, keeping everything else in the file.
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
        let add = |hooks: &mut serde_json::Map<String, Value>, event: &str, h: Value| {
            let list = hooks.entry(event).or_insert_with(|| json!([]));
            if let Some(a) = list.as_array_mut() {
                a.push(json!({ "hooks": [h] }));
            }
        };
        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"] {
            add(hooks, event, hook("event", 5, true));
        }
        add(hooks, "PermissionRequest", hook("permission", HOLD.as_secs() + 15, false));
    }
    let out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.dispecink-tmp");
    std::fs::write(&tmp, out + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
