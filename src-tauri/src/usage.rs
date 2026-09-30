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

