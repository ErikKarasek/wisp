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
