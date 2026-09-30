//! A file dropped on the notch and a question about it, answered by Gemini
//! through Antigravity (Google AI Pro), so it costs nothing from Claude.

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn ask_file(path: &str, question: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let agy = PathBuf::from(format!("{home}/.local/bin/agy"));
    if !agy.exists() {
        return Err("Chybí Antigravity CLI (agy).".into());
    }
    let file = Path::new(path);
    if !file.exists() {
        return Err("Soubor už tam není.".into());
    }
    let dir = if file.is_dir() { file } else { file.parent().unwrap_or(Path::new("/")) };
    let prompt = format!(
        "Soubor: {path}\n\nOtázka: {question}\n\nPřečti si ten soubor a odpověz na otázku česky, stručně a přímo, \
         jako v chatu: bez nadpisů, nanejvýš pár vět nebo krátký seznam. Nic neměň, nic nespouštěj, jen čti."
    );
    let out = Command::new(agy)
        .args(["-p", &prompt, "--model", "gemini-3.8-flash-medium", "--print-timeout", "3m", "--add-dir"])
        .arg(dir)
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().rev().find(|l| !l.contains("logging before") && !l.trim().is_empty()).unwrap_or("Gemini neodpověděl.").to_string());
    }
    Ok(text)
}

/// A follow-up question on a report from the Antigravity jobs: the report and
/// the conversation so far go in, Gemini answers. It may read files under
/// ~/Developer to answer, but runs nothing and changes nothing.
pub fn ask_report(report: &str, thread: &str, question: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let agy = PathBuf::from(format!("{home}/.local/bin/agy"));
    if !agy.exists() {
        return Err("Chybí Antigravity CLI (agy).".into());
    }
    let dev = PathBuf::from(format!("{home}/Developer"));
    let prompt = format!(
        "Tohle je týdenní report, který Erik dostal:\n\n{report}\n\n---\nDosavadní rozhovor o něm:\n{thread}\n\n---\n\
         Erikova otázka: {question}\n\nOdpověz česky, prostě a konkrétně, jako v chatu (žádné nadpisy). \
         Když se ptá, jak něco opravit, dej přesné kroky nebo příkazy. Projekty jsou v ~/Developer; \
         smíš je číst, ale nic nespouštěj a nic neměň."
    );
    let out = Command::new(agy)
        .args(["-p", &prompt, "--model", "gemini-3.1-pro-low", "--output-format", "json", "--print-timeout", "4m"])
        .current_dir(&dev)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = text.find('{').and_then(|i| serde_json::from_str(&text[i..]).ok()).unwrap_or_default();
    match v.get("response").and_then(|r| r.as_str()).map(str::trim) {
        Some(r) if !r.is_empty() => Ok(r.to_string()),
        _ => Err("Gemini neodpověděl.".into()),
    }
}

/// A quick question from the shortcut, with whatever was copied as its context.
pub fn ask_quick(question: &str, context: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let agy = PathBuf::from(format!("{home}/.local/bin/agy"));
    if !agy.exists() {
        return Err("Chybí Antigravity CLI (agy).".into());
    }
    let prompt = if context.trim().is_empty() {
        format!("{question}\n\nOdpověz česky, stručně a přímo, jako v chatu (žádné nadpisy).")
    } else {
        format!(
            "Zkopírovaný text:\n---\n{context}\n---\n\n{question}\n\nOdpověz česky, stručně a přímo, jako v chatu (žádné nadpisy). \
             Když jde o překlad nebo přepis, vrať rovnou výsledný text."
        )
    };
    let dir = std::env::temp_dir().join("dispecink-ask");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = Command::new(agy)
        .args(["-p", &prompt, "--model", "gemini-3.8-flash-medium", "--output-format", "json", "--print-timeout", "2m"])
        .current_dir(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = text.find('{').and_then(|i| serde_json::from_str(&text[i..]).ok()).unwrap_or_default();
    match v.get("response").and_then(|r| r.as_str()).map(str::trim) {
        Some(r) if !r.is_empty() => Ok(r.to_string()),
        _ => Err("Gemini neodpověděl.".into()),
    }
}

/// What is on the clipboard as text (at most 8000 characters).
pub fn clipboard() -> String {
    // Without a UTF-8 locale (an app has none) pbpaste turns š and ř into garbage.
    let out = Command::new("/usr/bin/pbpaste").env("LANG", "en_US.UTF-8").env("LC_ALL", "en_US.UTF-8").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    out.chars().take(8000).collect()
}
