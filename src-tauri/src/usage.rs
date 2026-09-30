//! How much of the Claude subscription is used: the current session and the
//! week, as Claude Code's own `/usage` prints them. Asking the CLI (as
//! Codenotch does) means Dispečink never touches the Claude credentials.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub percent: u8,
    pub resets: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub session: Option<Window>,
    pub week: Option<Window>,
}

fn claude() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    [format!("{home}/.local/bin/claude"), "/opt/homebrew/bin/claude".into(), "/usr/local/bin/claude".into()]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// "Current session: 26% used · resets Sep 30 at 11:29pm (Europe/Prague)"
fn parse(line: &str) -> Option<Window> {
    let (_, rest) = line.split_once(':')?;
    let pct: String = rest.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    let percent = pct.parse::<u8>().ok()?;
    let resets = rest
        .split_once("resets ")
        .map(|(_, r)| r.split(" (").next().unwrap_or(r).trim().to_string())
        .unwrap_or_default();
    Some(Window { percent, resets })
}

pub fn claude_usage() -> Result<Usage, String> {
    let bin = claude().ok_or("Nenašel jsem claude.")?;
    // Its own scratch folder: /usage files nothing there, but it must run somewhere.
    let dir = std::env::temp_dir().join("dispecink-usage");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = Command::new(bin)
        .args(["--print", "--no-session-persistence", "--strict-mcp-config", "/usage"])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut usage = Usage::default();
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("Current session") {
            usage.session = parse(l);
        } else if l.starts_with("Current week") && usage.week.is_none() {
            usage.week = parse(l);
        }
    }
    if usage.session.is_none() && usage.week.is_none() {
        return Err(text.lines().next().unwrap_or("claude /usage nic nevrátil").to_string());
    }
    Ok(usage)
}


/// One of the ChatGPT subscription's limits.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GptWindow {
    pub percent: u8,
    /// How long the window is: 5 h on Plus and Pro, 30 days on Go.
    pub window_secs: u64,
    pub resets_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GptUsage {
    pub plan: String,
    pub windows: Vec<GptWindow>,
}

/// ChatGPT's own usage endpoint, with the login Codex keeps in ~/.codex, the
/// way Paperclip and Codex read it. Takes a fraction of a second, so it can
/// run every minute. The token stays in this process; nothing is written.
pub async fn chatgpt_usage() -> Result<GptUsage, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let auth: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{home}/.codex/auth.json")).map_err(|_| "Codex není přihlášený.".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let token = auth["tokens"]["access_token"].as_str().ok_or("Codex není přihlášený přes ChatGPT.")?;
    let mut req = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header("User-Agent", "Dispecink");
    if let Some(account) = auth["tokens"]["account_id"].as_str() {
        req = req.header("ChatGPT-Account-Id", account);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("ChatGPT vrátil {}", res.status()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let windows = ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|k| {
            let w = &body["rate_limit"][k];
            let pct = w["used_percent"].as_f64()?;
            Some(GptWindow {
                percent: pct.round().clamp(0.0, 100.0) as u8,
                window_secs: w["limit_window_seconds"].as_u64().unwrap_or(0),
                resets_at_ms: w["reset_at"].as_u64().unwrap_or(0) * 1000,
            })
        })
        .collect();
    Ok(GptUsage { plan: body["plan_type"].as_str().unwrap_or("").to_string(), windows })
}
