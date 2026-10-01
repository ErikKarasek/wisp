//! How much of the Claude subscription is used: the current session and the
//! week, as Claude Code's own `/usage` prints them. Asking the CLI (as
//! Codenotch does) means Wisp never touches the Claude credentials.

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

/// One Antigravity limit: a model group ("Gemini" or "Claude a GPT") and a window.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyWindow {
    pub group: String,
    pub percent: u8,
    pub window_secs: u64,
    pub resets_at_ms: u64,
}

/// The Google AI Pro limits in Antigravity, from `agy -p /usage`, which prints
/// "Gemini Models<TAB>Five Hour Limit Remaining<TAB>100%<TAB>2026-10-01T00:16:21Z".
/// It asks no model, so it costs nothing; it takes ~10 s, hence its own pace.
pub fn gemini_usage() -> Result<Vec<AgyWindow>, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let bin = PathBuf::from(format!("{home}/.local/bin/agy"));
    if !bin.exists() {
        return Err("Antigravity CLI není nainstalovaný.".into());
    }
    let dir = std::env::temp_dir().join("dispecink-usage");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = Command::new(bin)
        .args(["-p", "/usage", "--print-timeout", "60s"])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let windows: Vec<AgyWindow> = text
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('\t').map(str::trim).collect();
            let [group, window, remaining, resets] = cols[..] else { return None };
            let left: f64 = remaining.trim_end_matches('%').parse().ok()?;
            let window_secs = if window.starts_with("Five Hour") {
                5 * 3600
            } else if window.starts_with("Weekly") {
                7 * 86400
            } else {
                0
            };
            Some(AgyWindow {
                group: if group.starts_with("Gemini") { "Gemini".into() } else { "Claude a GPT".into() },
                percent: (100.0 - left).round().clamp(0.0, 100.0) as u8,
                window_secs,
                resets_at_ms: parse_iso_ms(resets).unwrap_or(0),
            })
        })
        .collect();
    if windows.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let why = text.lines().chain(err.lines()).find(|l| !l.contains("logging before")).unwrap_or("agy /usage nic nevrátil");
        return Err(why.to_string());
    }
    Ok(windows)
}

/// "2026-10-01T00:16:21Z" in milliseconds, without pulling in a date crate.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let (date, time) = s.trim_end_matches('Z').split_once('T')?;
    let d: Vec<i64> = date.split('-').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let t: Vec<i64> = time.split(':').map(|p| p.split('.').next().unwrap_or(p).parse().ok()).collect::<Option<_>>()?;
    let (y, m, day) = (*d.first()?, *d.get(1)?, *d.get(2)?);
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + t.first()? * 3600 + t.get(1)? * 60 + t.get(2).copied().unwrap_or(0);
    u64::try_from(secs).ok().map(|s| s * 1000)
}

/// Days until the certificate Wisp is signed with runs out. After that the
/// Keychain starts asking again and new builds can't be signed.
pub fn signing_cert_days() -> Option<i64> {
    let pem = Command::new("/usr/bin/security")
        .args(["find-certificate", "-c", "Apple Development: erikkarasek@centrum.cz", "-p"])
        .output()
        .ok()?;
    let mut child = Command::new("/usr/bin/openssl")
        .args(["x509", "-noout", "-enddate"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    use std::io::Write;
    child.stdin.take()?.write_all(&pem.stdout).ok()?;
    let out = child.wait_with_output().ok()?;
    // "notAfter=Jun 11 12:50:47 2027 GMT"
    let text = String::from_utf8_lossy(&out.stdout);
    let date = text.trim().strip_prefix("notAfter=")?;
    let parts: Vec<&str> = date.split_whitespace().collect();
    let first = *parts.first()?;
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|m| *m == first)? + 1;
    let iso = format!("{}-{:02}-{:02}T{}Z", parts.get(3)?, month, parts.get(1)?.parse::<u32>().ok()?, parts.get(2)?);
    let end = parse_iso_ms(&iso)? as i64;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((end - now) / 86_400_000)
}
