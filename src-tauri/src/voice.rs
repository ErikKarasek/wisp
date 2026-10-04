//! Talking to the notch: hold ⌃⌥V, say it in Czech, let go. ffmpeg records the Mac's own
//! microphone; Gemini (through Antigravity) writes down what was said and works out what to
//! do with it: answer a question, add a reminder (to the Reminders app, so the iPhone rings
//! too), give the night shift a task, or give an agent one. The notch carries it out (mini.ts).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

static RECORDING: Mutex<Option<(Child, PathBuf, Instant)>> = Mutex::new(None);

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn ffmpeg() -> Option<PathBuf> {
    ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].iter().map(PathBuf::from).find(|p| p.exists())
}

/// The Mac's own microphone: not the iPhone's (Continuity lists it first), when it can tell.
fn microphone(ff: &PathBuf) -> String {
    let out = Command::new(ff).args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stderr).into_owned()).unwrap_or_default();
    let audio = text.split("audio devices").nth(1).unwrap_or_default();
    for line in audio.lines() {
        // "[AVFoundation indev @ 0x…] [1] Mikrofon MacBook Air"
        let Some(rest) = line.rsplit("] [").next() else { continue };
        let Some((idx, name)) = rest.split_once("] ") else { continue };
        if name.contains("MacBook") || name.to_lowercase().contains("built-in") || name.contains("vestavěn") {
            return format!(":{idx}");
        }
    }
    ":default".into()
}

pub fn start() -> Result<(), String> {
    let mut rec = RECORDING.lock().unwrap_or_else(|e| e.into_inner());
    if rec.is_some() {
        return Ok(());
    }
    let ff = ffmpeg().ok_or("Chybí ffmpeg (brew install ffmpeg).")?;
    let dir = std::env::temp_dir().join("dispecink-ask");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("hlas-{ms}.wav"));
    let child = Command::new(&ff)
        .args(["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", &microphone(&ff), "-ac", "1", "-ar", "16000", "-t", "60", "-y"])
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    *rec = Some((child, path, Instant::now()));
    Ok(())
}

/// A recording on disk; the file is deleted when this is dropped, whatever path the caller takes.
pub struct Recording(PathBuf);

impl Recording {
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Stop and hand back the recording; None when there was none or it was too short to mean anything.
pub fn stop() -> Option<Recording> {
    let (mut child, path, began) = RECORDING.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    // "q" lets ffmpeg finish the file properly.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    let long_enough = began.elapsed() > Duration::from_millis(600);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if !long_enough || size < 8_000 {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(Recording(path))
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Heard {
    /// What was said, written down.
    pub heard: String,
    /// ask, remind, night, agent, or nothing (couldn't hear / not a command).
    pub action: String,
    /// ask: the answer.
    pub answer: String,
    /// remind: what, and when ("2026-10-04T17:00", local).
    pub text: String,
    pub at: String,
    /// night / agent
    pub project: String,
    pub task: String,
    pub now: bool,
    pub agent: String,
}

pub fn understand(rec: Recording, agents: &[String]) -> Result<Heard, String> {
    let path = rec.path().to_string_lossy().into_owned();
    let agy = home().join(".local/bin/agy");
    if !agy.exists() {
        return Err("Chybí Antigravity CLI (agy).".into());
    }
    let dir = rec.path().parent().ok_or("Nahrávka není.")?.to_path_buf();
    let now = {
        let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&secs, &mut tm) };
        let days = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
        format!("{}-{:02}-{:02}T{:02}:{:02} ({})", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, days[tm.tm_wday as usize % 7])
    };
    let projects = crate::night::projects().join(", ");
    let prompt = format!(
        "Soubor {path} je krátká hlasová nahrávka, Erik mluví česky ke svému Macu. Přečti ji nástrojem a přepiš.\n\n\
         Teď je {now}. Jeho projekty: {projects}. Jeho agenti: {}.\n\n\
         Pak rozhodni, co chce, a odpověz jen JSONem bez ničeho okolo:\n\
         {{\"heard\": \"přepis doslova\", \"action\": \"…\", …}}\n\
         action je jedno z:\n\
         - \"ask\": otázka nebo prosba o text (přelož, vymysli, spočítej…). Přidej \"answer\": odpověď česky, krátce a přímo, bez nadpisů.\n\
         - \"remind\": ať mu něco připomeneš. Přidej \"text\" (co, krátce, jako položka seznamu) a \"at\" (místní čas YYYY-MM-DDTHH:MM; \
           „v pět“ odpoledne znamená 17:00, když už je po páté ráno; bez času = za hodinu).\n\
         - \"night\": ať se na něčem v projektu zapracuje, až bude pryč / přes noc. Přidej \"project\" (přesně název ze seznamu) \
           a \"task\" (úkol vlastními slovy, jasně); \"now\": true, když řekl hned/teď.\n\
         - \"agent\": úkol pro jednoho z agentů (oslovil ho jménem). Přidej \"agent\" (jméno přesně ze seznamu) a \"task\".\n\
         - \"none\": nic nebylo slyšet nebo to není pokyn.",
        if agents.is_empty() { "žádní".into() } else { agents.join(", ") }
    );
    // Once more if Gemini comes back empty-handed (it now and then does).
    for _ in 0..2 {
        let out = Command::new(&agy)
            .args(["-p", &prompt, "--model", "gemini-3.8-flash-medium", "--output-format", "json", "--print-timeout", "90s", "--add-dir"])
            .arg(&dir)
            .current_dir(&dir)
            .output()
            .map_err(|e| e.to_string())?;
        let raw = String::from_utf8_lossy(&out.stdout);
        let v: serde_json::Value = raw.find('{').and_then(|i| serde_json::from_str(&raw[i..]).ok()).unwrap_or_default();
        let answer = v["response"].as_str().unwrap_or_default();
        if let (Some(a), Some(b)) = (answer.find('{'), answer.rfind('}')) {
            if let Ok(h) = serde_json::from_str::<Heard>(&answer[a..=b]) {
                return Ok(h);
            }
        }
    }
    Err("Gemini tomu nerozuměl. Zkus to znovu.".into())
}

/// A reminder in the Reminders app (it syncs to the iPhone and rings there too).
pub fn remind(text: &str, at: &str) -> Result<String, String> {
    let (date, time) = at.split_once('T').ok_or("Nevím kdy.")?;
    let mut d = date.split('-').map(|p| p.parse::<i32>().unwrap_or(0));
    let (y, mo, da) = (d.next().unwrap_or(0), d.next().unwrap_or(0), d.next().unwrap_or(0));
    let mut t = time.split(':').map(|p| p.get(..2).unwrap_or(p).parse::<i32>().unwrap_or(0));
    let (h, mi) = (t.next().unwrap_or(9), t.next().unwrap_or(0));
    if y < 2000 || !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return Err("Nevím kdy.".into());
    }
    let esc = text.replace('\\', "\\\\").replace('"', "\\\"");
    // The date is built field by field: AppleScript's date parsing follows the system's locale.
    let script = format!(
        "set d to current date\nset day of d to 1\nset year of d to {y}\nset month of d to {mo}\nset day of d to {da}\n\
         set hours of d to {h}\nset minutes of d to {mi}\nset seconds of d to 0\n\
         tell application \"Reminders\" to make new reminder with properties {{name:\"{esc}\", due date:d, remind me date:d}}"
    );
    let out = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.contains("-1743") { "Wisp nesmí do Připomínek. Povol to v Nastavení → Soukromí → Automatizace.".into() } else { err.trim().to_string() });
    }
    Ok(format!("{da}. {mo}. v {h}:{mi:02}"))
}

/// The agents in Paperclip (not the terminated ones): name, id, company.
pub async fn agents() -> Vec<(String, String, String)> {
    let list = |v: serde_json::Value| match v {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(o) => o.into_iter().find_map(|(_, v)| v.as_array().cloned()).unwrap_or_default(),
        _ => vec![],
    };
    let mut out = Vec::new();
    for c in crate::paperclip::request("GET", "/companies", None).await.map(list).unwrap_or_default() {
        let Some(cid) = c["id"].as_str() else { continue };
        for a in crate::paperclip::request("GET", &format!("/companies/{cid}/agents"), None).await.map(list).unwrap_or_default() {
            if a["status"] == "terminated" {
                continue;
            }
            if let (Some(name), Some(id)) = (a["name"].as_str(), a["id"].as_str()) {
                out.push((name.to_string(), id.to_string(), cid.to_string()));
            }
        }
    }
    out
}

/// A task for an agent, as from Telegram ("Watcher: …"): a new issue, and the agent woken.
pub async fn agent_task(name: &str, task: &str) -> Result<String, String> {
    let all = agents().await;
    let (agent, id, company) = all.iter().find(|(n, _, _)| n.eq_ignore_ascii_case(name.trim())).ok_or(format!("Agenta {name} nemám."))?;
    let first: String = task.lines().next().unwrap_or(task).chars().take(120).collect();
    let issue = crate::paperclip::request(
        "POST",
        &format!("/companies/{company}/issues"),
        Some(serde_json::json!({ "title": first, "description": task, "status": "todo", "priority": "medium", "assigneeAgentId": id })),
    )
    .await?;
    let _ = crate::paperclip::action("agentInvoke", id).await;
    Ok(format!("{agent} dostal úkol {}.", issue["identifier"].as_str().unwrap_or("")))
}

#[cfg(test)]
mod live {
    /// VOICE_WAV=… cargo test --lib voice::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn understand() {
        let wav = std::env::var("VOICE_WAV").expect("VOICE_WAV");
        let copy = std::env::temp_dir().join("voice-test.wav");
        std::fs::copy(&wav, &copy).unwrap();
        let t = std::time::Instant::now();
        let names = vec!["Watcher".to_string(), "Fixer".to_string()];
        println!("{:?} {:#?}", t.elapsed(), super::understand(super::Recording(copy), &names));
    }
}
