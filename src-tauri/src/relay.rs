//! The iPhone app's link: Dispečink pushes its state to the Cloudflare relay
//! (relay/ in this repo) and picks up what the phone asked for. The relay's URL
//! and token live in config.json under "relay"; without them this does nothing.

use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Relay {
    url: String,
    token: String,
}

fn relay(app: &AppHandle) -> Option<Relay> {
    let cfg = crate::store::load(app.path().app_config_dir().ok()?).ok()?;
    let r = &cfg["relay"];
    let url = r["url"].as_str()?.trim_end_matches('/').to_string();
    let token = r["token"].as_str()?.to_string();
    (url.starts_with("https://") && token.len() >= 20).then_some(Relay { url, token })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())
}

/// The state the phone shows; the permission prompts waiting right now are added here.
pub async fn push(app: &AppHandle, mut state: Value) -> Result<(), String> {
    let Some(r) = relay(app) else { return Ok(()) };
    state["perms"] = json!(crate::claudecode::pending());
    let res = client()?
        .put(format!("{}/state", r.url))
        .bearer_auth(&r.token)
        .json(&state)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("relay: HTTP {}", res.status()))
    }
}

/// Every 10 s: commands from the phone. Permission answers are handled here,
/// the rest (tasks, replies) go to the main window, which knows Paperclip.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio_sleep(10).await;
            let Some(r) = relay(&app) else { continue };
            let Ok(c) = client() else { continue };
            let Ok(res) = c.get(format!("{}/cmd", r.url)).bearer_auth(&r.token).send().await else { continue };
            let cmds: Vec<Value> = res.json().await.unwrap_or_default();
            if cmds.is_empty() {
                continue;
            }
            let mut ids = Vec::new();
            for cmd in cmds {
                ids.push(cmd["id"].clone());
                match cmd["kind"].as_str() {
                    Some("perm") => {
                        let id = cmd["permId"].as_str().unwrap_or("");
                        let answer = cmd["answer"].as_str().unwrap_or("");
                        if ["allow", "always", "deny", "terminal"].contains(&answer) {
                            crate::claudecode::decide(id, answer);
                        }
                    }
                    _ => {
                        let _ = app.emit_to("main", "relay-cmd", cmd);
                    }
                }
            }
            let _ = c.post(format!("{}/cmd/ack", r.url)).bearer_auth(&r.token).json(&json!({ "ids": ids })).send().await;
        }
    });
}

async fn tokio_sleep(secs: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(secs))).await.ok();
}
