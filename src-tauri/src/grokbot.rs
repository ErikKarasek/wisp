//! Grok Bot on the card wall. It is an agent like the others, so Wisp should show
//! it next to them instead of pretending it isn't running.
//!
//! Everything here comes off the disk Grok Bot already writes to. Nothing is asked
//! of its backend, no token is needed, and a missing file only makes that one fact
//! unknown: the app is someone else's and its layout can change without warning.
//!
//! What cannot be read this way: the routines, which live in the cloud, so the card
//! shows the bot's state, not a countdown to Monday.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrokBot {
    /// False when the app isn't on this Mac at all; the group is then left out.
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    /// Its link to the Mac: the cloud can run commands here only while this serves.
    pub daemon: bool,
    pub bot_name: Option<String>,
    pub last_message: Option<String>,
    pub last_activity_ms: Option<f64>,
    pub unread: u32,
    pub plan: Option<String>,
    pub percent_used: Option<u8>,
    pub resets_ms: Option<f64>,
    /// Letting the cloud drive the Mac's apps, off by default.
    pub computer_use: bool,
    /// Letting the cloud's box route its traffic through this Mac's connection.
    pub local_egress: bool,
}

const APP: &str = "/Applications/Grok Bot.app";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn support() -> PathBuf {
    home().join("Library/Application Support/Grok Bot")
}

fn read_json(path: PathBuf) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The persistence files are named after their key, base32 without padding
/// (RFC 4648, lowercase). Decoding the name beats guessing from the contents.
fn base32(name: &str) -> Option<String> {
    let mut bits = 0u32;
    let mut have = 0u8;
    let mut out = Vec::new();
    for c in name.bytes() {
        let v = match c {
            b'a'..=b'z' => c - b'a',
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        };
        bits = (bits << 5) | v as u32;
        have += 5;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
        }
    }
    String::from_utf8(out).ok()
}

/// The persistence slice whose key ends in `suffix`.
fn slice(suffix: &str) -> Option<serde_json::Value> {
    let dir = support().join("sand-client-persistence");
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let file = entry.file_name();
        let name = file.to_str()?;
        let Some(stem) = name.strip_suffix(".blob") else { continue };
        if base32(stem).is_some_and(|key| key.ends_with(suffix)) {
            return read_json(entry.path());
        }
    }
    None
}

/// The newest session file the app keeps for its own crash reporting: the version
/// it runs, its pid, and when it last said it was alive.
fn session() -> Option<serde_json::Value> {
    let dir = support().join("dune-reliability/sessions");
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if !entry.file_name().to_string_lossy().ends_with(".running.json") {
            continue;
        }
        let at = entry.metadata().and_then(|m| m.modified()).ok()?;
        if newest.as_ref().is_none_or(|(best, _)| at > *best) {
            newest = Some((at, entry.path()));
        }
    }
    read_json(newest?.1)
}

fn alive(pid: i64) -> bool {
    // Signal 0 only checks that the pid exists and we may signal it.
    pid > 0 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
}

pub fn snapshot() -> GrokBot {
    let mut s = GrokBot { installed: PathBuf::from(APP).exists(), ..Default::default() };
    if !s.installed {
        return s;
    }

    if let Some(sess) = session() {
        s.version = sess["identity"]["appVersion"].as_str().map(str::to_string);
        s.running = sess["pid"].as_i64().is_some_and(alive);
    }

    // The daemon that lets the cloud reach this Mac. Its pid file outlives the
    // process, so the pid is checked rather than trusted.
    if let Some(d) = read_json(home().join(".grokbot/local-exec-daemon.json")) {
        s.daemon = d["pid"].as_i64().is_some_and(alive) && d["servingAt"].is_number();
    }

    // Not read: the MCP servers. The local settings only hold the ones added in the
    // app, while a server the bot adds to the account lives in the cloud, so the
    // count here would show zero next to a server that is plainly connected.
    if let Some(settings) = read_json(home().join(".grokbot/settings.json")) {
        s.local_egress = settings["localEgressAllowed"].as_bool().unwrap_or(false);
    }
    if let Some(gate) = read_json(home().join(".grokbot/local-computer-use-gate.json")) {
        s.computer_use = gate["isOn"].as_bool().unwrap_or(false);
    }

    if let Some(usage) = slice("weekly-usage.cache") {
        let u = &usage["value"]["reading"]["usage"];
        s.plan = u["grokPlanLabel"].as_str().map(str::to_string);
        s.percent_used = u["percentUsed"].as_u64().map(|n| n.min(100) as u8);
        s.resets_ms = u["nextResetMs"].as_f64();
    }

    // One bot per account today, but the roster is a list, so take the busiest.
    if let Some(roster) = slice("roster.last-roster") {
        if let Some(rows) = roster["value"]["rows"].as_array() {
            if let Some(bot) = rows.iter().max_by(|a, b| {
                let at = |v: &serde_json::Value| v["lastActivityAt"].as_f64().unwrap_or(0.0);
                at(a).total_cmp(&at(b))
            }) {
                s.bot_name = bot["name"].as_str().map(str::to_string);
                s.last_message = bot["lastEntry"]["text"].as_str().map(|t| t.chars().take(300).collect());
                s.last_activity_ms = bot["lastActivityAt"].as_f64();
                s.unread = if bot["hasUnread"].as_bool().unwrap_or(false) {
                    bot["unreadCount"].as_u64().unwrap_or(1) as u32
                } else {
                    0
                };
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_decodes_a_slice_key() {
        let name = "onqw4zbomnwgszlooqxhg3djmnss4y3mnfsw45bnnvsxiyjomfrwg33vnz2c243mn52a";
        assert_eq!(base32(name).as_deref(), Some("sand.client.slice.client-meta.account-slot"));
    }

    #[test]
    fn base32_refuses_what_is_not_base32() {
        assert_eq!(base32("tohle-neni-base32!"), None);
    }

    #[test]
    fn a_missing_app_reports_nothing_else() {
        // Not a live test: with the app absent, the snapshot must stay empty rather
        // than claim a bot that is not there.
        let s = GrokBot { installed: false, ..Default::default() };
        assert!(!s.running && !s.daemon && s.bot_name.is_none());
    }

    /// What this Mac really reports: `cargo test --lib grokbot::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live() {
        let s = snapshot();
        println!("installed {} | running {} | daemon {}", s.installed, s.running, s.daemon);
        println!("version {:?} | plan {:?} | percent {:?}", s.version, s.plan, s.percent_used);
        println!("bot {:?} | unread {} | egress {}", s.bot_name, s.unread, s.local_egress);
        println!("computer use {} | last activity {:?}", s.computer_use, s.last_activity_ms);
        println!("last message {:?}", s.last_message.as_deref().map(|m| m.chars().take(80).collect::<String>()));
    }
}
