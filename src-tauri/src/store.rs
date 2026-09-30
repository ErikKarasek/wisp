//! What the user sets up in the app: their characters, which item wears which,
//! renamed items, repositories and switches. One JSON file in the app's config
//! folder, not the webview's localStorage, which macOS can wipe with its cache.
//!
//! Secrets go to the Keychain instead and are never handed back to the page:
//! it can only ask whether one is set.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

const KEYCHAIN_SERVICE: &str = "cz.erikkarasek.dispecink";
const SECRETS: &[&str] = &["cloudflare", "telegram"];
/// Enough history for weeks of state changes; the oldest drop off.
const HISTORY_MAX: usize = 5000;

fn path(dir: PathBuf) -> PathBuf {
    dir.join("config.json")
}

pub fn load(dir: PathBuf) -> Result<Value, String> {
    match fs::read_to_string(path(dir)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("config.json je poškozený: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save(dir: PathBuf, value: &Value) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = path(dir);
    let tmp = file.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // Rename is atomic, so a crash never leaves half a file behind.
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    if !SECRETS.contains(&name) {
        return Err(format!("Neznámý secret {name}"));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

pub fn secret_get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok()
}

pub fn secret_set(name: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Prázdná hodnota".into());
    }
    entry(name)?.set_password(value).map_err(|e| e.to_string())
}

pub fn secret_delete(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------- history ----------

fn history_path(dir: PathBuf) -> PathBuf {
    dir.join("history.json")
}

pub fn history_load(dir: PathBuf) -> Value {
    fs::read_to_string(history_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Array(vec![]))
}

pub fn history_append(dir: PathBuf, entries: Vec<Value>) -> Result<(), String> {
    let mut all = match history_load(dir.clone()) {
        Value::Array(a) => a,
        _ => vec![],
    };
    all.extend(entries);
    if all.len() > HISTORY_MAX {
        all.drain(..all.len() - HISTORY_MAX);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = history_path(dir);
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}
