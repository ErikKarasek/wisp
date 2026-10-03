//! Kde jsem skončil: back at the Mac after half an hour or more, the notch says what Erik was
//! working on (from the last Claude Code conversation and the project's git), what to do next
//! (Gemini, through Antigravity), and what the night shift finished meanwhile. Also /kde on
//! Telegram.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

/// Away at least this long counts as a break.
const BREAK: Duration = Duration::from_secs(30 * 60);

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub project: Option<String>,
    /// The conversation's title in the Claude app, when it has one.
    pub title: Option<String>,
    pub summary: String,
    pub next: String,
    pub branch: Option<String>,
    pub dirty: usize,
    pub last_commit: Option<String>,
    /// Minutes since the conversation was last written to.
    pub ago_min: u64,
    pub night: Vec<NightDone>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NightDone {
    pub project: String,
    pub task: String,
    pub pr: Option<String>,
    pub ok: bool,
}

/// The text of a message's content: a plain string, or its text blocks (no tool results).
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

struct Conversation {
    asks: Vec<String>,
    last_answer: String,
    title: Option<String>,
    project: Option<String>,
    modified: SystemTime,
}

/// Prompts the background runs send (snip.rs, night.rs): those are not Erik's conversations.
fn is_background(first_ask: &str) -> bool {
    first_ask.starts_with("Erik si na obrazovce označil") || first_ask.starts_with("Pracuješ v noci sám")
}

/// The newest conversation Erik had with Claude Code about something in ~/Developer.
fn last_conversation() -> Option<Conversation> {
    let dev = home().join("Developer");
    let dev_s = format!("{}/", dev.display());
    let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(home().join(".claude/projects"))
        .ok()?
        .flatten()
        // Erik's own folders; not the temp dirs of background runs, not Paperclip's agents.
        .filter(|d| {
            let n = d.file_name().to_string_lossy().into_owned();
            n.starts_with("-Users-") && !n.contains("-paperclip-")
        })
        .filter_map(|d| std::fs::read_dir(d.path()).ok())
        .flatten()
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let repo_re = |s: &str, counts: &mut HashMap<String, usize>| {
        let mut rest = s;
        while let Some(i) = rest.find(&dev_s) {
            rest = &rest[i + dev_s.len()..];
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
            if !name.is_empty() && !name.starts_with('.') && dev.join(&name).join(".git").is_dir() {
                *counts.entry(name).or_default() += 1;
            }
        }
    };
    for (modified, path) in files.into_iter().take(12) {
        let Ok(f) = std::fs::File::open(&path) else { continue };
        let mut asks: Vec<String> = Vec::new();
        let mut last_answer = String::new();
        let mut title = None;
        let mut cwd = None;
        // Which projects the recent work touched, by the paths in the last tool calls.
        let mut touches: Vec<String> = Vec::new();
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            match v["type"].as_str() {
                Some("custom-title") => title = v["customTitle"].as_str().or(v["title"].as_str()).map(String::from),
                Some("user") => {
                    if cwd.is_none() {
                        cwd = v["cwd"].as_str().map(String::from);
                    }
                    let t = text_of(&v["message"]["content"]);
                    let t = t.trim();
                    // Real asks only: not tool results, not the app's own reminders.
                    if !t.is_empty() && !t.starts_with('<') && !t.starts_with("[Image") && v["isMeta"] != Value::Bool(true) {
                        asks.push(t.chars().take(400).collect::<String>());
                    }
                }
                Some("assistant") => {
                    let t = text_of(&v["message"]["content"]);
                    if !t.trim().is_empty() {
                        last_answer = t.trim().chars().take(900).collect();
                    }
                    if let Some(blocks) = v["message"]["content"].as_array() {
                        for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
                            touches.push(b["input"].to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        if asks.is_empty() || is_background(&asks[0]) {
            continue;
        }
        let mut counts = HashMap::new();
        for t in touches.iter().rev().take(40) {
            repo_re(t, &mut counts);
        }
        let project = counts.into_iter().max_by_key(|(_, n)| *n).map(|(p, _)| p).or_else(|| {
            let mut c = HashMap::new();
            repo_re(&format!("{}/", cwd.as_deref().unwrap_or("")), &mut c);
            c.into_keys().next()
        });
        let asks = asks.split_off(asks.len().saturating_sub(5));
        return Some(Conversation { asks, last_answer, title, project, modified });
    }
    None
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("/usr/bin/git").args(args).current_dir(dir).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Gemini's two sentences: where it stopped, and what's next. None when it can't answer.
fn gemini(conv: &Conversation, git_line: &str) -> Option<(String, String)> {
    let agy = home().join(".local/bin/agy");
    if !agy.exists() {
        return None;
    }
    let asks = conv.asks.iter().map(|a| format!("- {}", a.replace('\n', " "))).collect::<Vec<_>>().join("\n");
    let prompt = format!(
        "Erik se vrací k počítači po pauze. Takhle skončil jeho poslední rozhovor s Claude Code\
         {}.\n\nJeho poslední zprávy:\n{asks}\n\nPoslední odpověď Clauda:\n{}\n\nGit: {git_line}\n\n\
         Odpověz jen JSONem {{\"summary\": \"…\", \"next\": \"…\"}}: summary je jedna věta česky, obyčejně jako \
         kamarád, na čem dělal a kde to skončilo; next je jedna krátká věta, co by měl udělat dál (třeba \
         vyzkoušet, commitnout, odpovědět Claudovi). Piš mu v jednotném čísle (ty, ne vy). Nic nespouštěj.",
        conv.project.as_ref().map(|p| format!(" (projekt {p})")).unwrap_or_default(),
        conv.last_answer
    );
    let dir = std::env::temp_dir().join("dispecink-ask");
    std::fs::create_dir_all(&dir).ok()?;
    let out = Command::new(agy)
        .args(["-p", &prompt, "--model", "gemini-3.8-flash-medium", "--output-format", "json", "--print-timeout", "90s"])
        .current_dir(&dir)
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let v: Value = raw.find('{').and_then(|i| serde_json::from_str(&raw[i..]).ok())?;
    let answer = v["response"].as_str()?;
    let (a, b) = (answer.find('{')?, answer.rfind('}')?);
    let j: Value = serde_json::from_str(&answer[a..=b]).ok()?;
    Some((j["summary"].as_str()?.trim().to_string(), j["next"].as_str().unwrap_or_default().trim().to_string()))
}

/// The card, from scratch. `since` (seconds) picks the night shift's results to mention.
pub fn card(app: &AppHandle, since: u64) -> Card {
    let mut c = Card::default();
    if let Some(conv) = last_conversation() {
        c.ago_min = conv.modified.elapsed().map(|d| d.as_secs() / 60).unwrap_or(0);
        c.title = conv.title.clone();
        c.project = conv.project.clone();
        let mut git_line = "nevím, ve kterém projektu".to_string();
        if let Some(p) = &conv.project {
            let dir = home().join("Developer").join(p);
            c.branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]);
            c.dirty = git(&dir, &["status", "--porcelain"]).map(|s| s.lines().count()).unwrap_or(0);
            c.last_commit = git(&dir, &["log", "-1", "--format=%s (%cr)"]);
            git_line = format!(
                "větev {}, {} necommitnutých souborů, poslední commit: {}",
                c.branch.as_deref().unwrap_or("?"),
                c.dirty,
                c.last_commit.as_deref().unwrap_or("žádný")
            );
        }
        match gemini(&conv, &git_line) {
            Some((s, n)) => {
                c.summary = s;
                c.next = n;
            }
            None => c.summary = format!("Naposledy jsi psal: „{}“", conv.asks.last().map(|a| a.chars().take(160).collect::<String>()).unwrap_or_default()),
        }
    }
    let since_ms = since * 1000;
    c.night = crate::night::list(app)
        .into_iter()
        .filter(|t| (t.status == "done" || t.status == "failed") && t.finished_ms.is_some_and(|f| f >= since_ms))
        .map(|t| NightDone { ok: t.status == "done", project: t.project, task: t.task, pr: t.pr })
        .collect();
    c
}

/// "/kde" on Telegram: the same card as text.
pub fn as_text(c: &Card) -> String {
    let mut lines = vec![format!("📍 Kde jsi skončil{}", c.project.as_ref().map(|p| format!(" · {p}")).unwrap_or_default())];
    if !c.summary.is_empty() {
        lines.push(c.summary.clone());
    }
    if !c.next.is_empty() {
        lines.push(format!("Dál: {}", c.next));
    }
    if let Some(b) = &c.branch {
        lines.push(format!(
            "Větev {b}{}{}",
            if c.dirty > 0 { format!(" · necommitnuto {}", c.dirty) } else { String::new() },
            c.last_commit.as_ref().map(|l| format!(" · poslední commit „{l}“")).unwrap_or_default()
        ));
    }
    for n in &c.night {
        lines.push(format!("🌙 {} – {}{}", n.project, n.task, n.pr.as_ref().map(|p| format!(" → {p}")).unwrap_or_else(|| if n.ok { String::new() } else { " (nedopadlo)".into() })));
    }
    lines.join("\n")
}

/// Watch for Erik coming back: a gap of at least half an hour between two touches of the Mac.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_touch = now_secs().saturating_sub(crate::telegram::idle_secs());
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let idle = crate::telegram::idle_secs();
            let touch = now_secs().saturating_sub(idle);
            if idle < 10 && touch.saturating_sub(last_touch) >= BREAK.as_secs() {
                let away_since = last_touch;
                let app2 = app.clone();
                std::thread::spawn(move || {
                    let c = card(&app2, away_since);
                    if c.summary.is_empty() && c.night.is_empty() {
                        return;
                    }
                    crate::notch::peek(&app2, 90_000);
                    let _ = app2.emit_to(crate::notch::LABEL, "resume", c);
                });
            }
            if touch > last_touch {
                last_touch = touch;
            }
        }
    });
}

/// The card's buttons: the project in VS Code, or the Claude app.
pub fn open(project: Option<&str>, how: &str) -> Result<(), String> {
    let mut cmd = Command::new("/usr/bin/open");
    match (how, project) {
        ("code", Some(p)) if !p.contains('/') && !p.starts_with('.') => {
            cmd.args(["-a", "Visual Studio Code"]).arg(home().join("Developer").join(p));
        }
        ("claude", _) => {
            cmd.args(["-a", "Claude"]);
        }
        _ => return Err("Nevím, co otevřít.".into()),
    }
    cmd.status().map_err(|e| e.to_string()).map(|_| ())
}

#[cfg(test)]
mod live {
    /// cargo test --lib resume::live -- --ignored --nocapture: the last conversation, as found.
    #[test]
    #[ignore]
    fn last() {
        let c = super::last_conversation().expect("a conversation");
        println!("project={:?} title={:?} ago={:?}\nasks={:#?}\nanswer={}", c.project, c.title, c.modified.elapsed(), c.asks, c.last_answer);
        let t = std::time::Instant::now();
        println!("gemini ({:?}): {:?}", t.elapsed(), super::gemini(&c, "test"));
    }
}
