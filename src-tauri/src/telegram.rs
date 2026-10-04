//! Messages to the user's own Telegram bot. The bot token stays in the Keychain;
//! the page only passes the chat id and the text.

use serde_json::{json, Value};
use std::time::Duration;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

fn check(v: &Value) -> Result<(), String> {
    if v["ok"] == json!(true) {
        Ok(())
    } else {
        Err(v["description"].as_str().unwrap_or("Telegram odmítl požadavek").to_string())
    }
}

fn valid_chat(chat: &str) -> bool {
    let digits = chat.strip_prefix('-').unwrap_or(chat);
    !digits.is_empty() && digits.len() <= 20 && digits.chars().all(|c| c.is_ascii_digit())
}

pub async fn send(token: &str, chat: &str, text: &str) -> Result<(), String> {
    if !valid_chat(chat) {
        return Err("Chat id musí být číslo.".into());
    }
    let v: Value = client()?
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&json!({ "chat_id": chat, "text": text, "disable_web_page_preview": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&v)
}

/// Like `send`, but without a sound on the phone (the night shift reports in the night).
pub async fn send_quiet(token: &str, chat: &str, text: &str) -> Result<(), String> {
    if !valid_chat(chat) {
        return Err("Chat id musí být číslo.".into());
    }
    let v: Value = client()?
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&json!({ "chat_id": chat, "text": text, "disable_web_page_preview": true, "disable_notification": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&v)
}

/// Chats that recently wrote to the bot, so the user can pick theirs.
pub async fn recent_chats(token: &str) -> Result<Vec<Value>, String> {
    let v: Value = client()?
        .get(format!("https://api.telegram.org/bot{token}/getUpdates"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&v)?;
    let mut chats: Vec<Value> = Vec::new();
    for u in v["result"].as_array().into_iter().flatten() {
        // A plain message, an edit, a channel post or the bot being added somewhere.
        let chat = ["message", "edited_message", "channel_post", "my_chat_member"]
            .iter()
            .map(|k| &u[*k]["chat"])
            .find(|c| c.is_object())
            .unwrap_or(&Value::Null);
        let Some(id) = chat["id"].as_i64() else { continue };
        if chats.iter().any(|c| c["id"] == json!(id.to_string())) {
            continue;
        }
        let name = chat["title"]
            .as_str()
            .or(chat["username"].as_str())
            .or(chat["first_name"].as_str())
            .unwrap_or("?");
        chats.push(json!({ "id": id.to_string(), "name": name }));
    }
    Ok(chats)
}

/// Who the bot is, and whether something else already takes its updates.
pub async fn bot_info(token: &str) -> Result<Value, String> {
    let c = client()?;
    let me: Value = c
        .get(format!("https://api.telegram.org/bot{token}/getMe"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&me)?;
    let hook: Value = c
        .get(format!("https://api.telegram.org/bot{token}/getWebhookInfo"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "username": me["result"]["username"],
        "name": me["result"]["first_name"],
        "webhook": hook["result"]["url"].as_str().is_some_and(|u| !u.is_empty()),
    }))
}

// ---------- the phone: the same bot, listening back ----------
//
// Wisp long-polls the bot's updates, but only when Telegram is on and
// `telegram.remote` isn't switched off, and it only listens to the chat from the
// settings. Buttons answer Claude Code's permission prompts; plain messages go to
// the main window, which turns them into tasks and comments for the agents.

use tauri::{AppHandle, Emitter, Manager};

pub struct Remote {
    pub token: String,
    pub chat: String,
}

/// The bot and the chat, when remote control is on.
pub fn remote(app: &AppHandle) -> Option<Remote> {
    let cfg = crate::store::load(app.path().app_config_dir().ok()?).ok()?;
    let t = &cfg["telegram"];
    if t["enabled"] != json!(true) || t["remote"] == json!(false) {
        return None;
    }
    let chat = t["chat"].as_str()?.to_string();
    if !valid_chat(&chat) {
        return None;
    }
    Some(Remote { token: crate::store::secret_get("telegram")?, chat })
}

/// A message with buttons; returns its id so it can be edited later.
pub async fn send_buttons(r: &Remote, text: &str, buttons: &[(&str, String)]) -> Result<i64, String> {
    let row: Vec<Value> = buttons.iter().map(|(label, data)| json!({ "text": label, "callback_data": data })).collect();
    let v: Value = client()?
        .post(format!("https://api.telegram.org/bot{}/sendMessage", r.token))
        .json(&json!({ "chat_id": r.chat, "text": text, "reply_markup": { "inline_keyboard": [row] } }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&v)?;
    v["result"]["message_id"].as_i64().ok_or("Telegram nevrátil id zprávy".into())
}

/// A message with rows of buttons the page lays out itself: `callback_data` ones come back
/// as "tg-pr" events, `url` ones open a page. Returns the message id, so it can be edited later.
pub async fn send_keyboard(r: &Remote, text: &str, keyboard: &Value) -> Result<i64, String> {
    let v: Value = client()?
        .post(format!("https://api.telegram.org/bot{}/sendMessage", r.token))
        .json(&json!({ "chat_id": r.chat, "text": text, "disable_web_page_preview": true, "reply_markup": { "inline_keyboard": keyboard } }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&v)?;
    v["result"]["message_id"].as_i64().ok_or("Telegram nevrátil id zprávy".into())
}

/// Replace a message's text and its buttons (none when `keyboard` is empty).
pub async fn edit_keyboard(r: &Remote, message_id: i64, text: &str, keyboard: &Value) -> Result<(), String> {
    let v: Value = client()?
        .post(format!("https://api.telegram.org/bot{}/editMessageText", r.token))
        .json(&json!({ "chat_id": r.chat, "message_id": message_id, "text": text, "disable_web_page_preview": true, "reply_markup": { "inline_keyboard": keyboard } }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    check(&v)
}

/// Replace a message's text and drop its buttons.
pub async fn edit(r: &Remote, message_id: i64, text: &str) {
    if let Ok(c) = client() {
        let _ = c
            .post(format!("https://api.telegram.org/bot{}/editMessageText", r.token))
            .json(&json!({ "chat_id": r.chat, "message_id": message_id, "text": text }))
            .send()
            .await;
    }
}

async fn answer_callback(r: &Remote, id: &str, text: &str) {
    if let Ok(c) = client() {
        let _ = c
            .post(format!("https://api.telegram.org/bot{}/answerCallbackQuery", r.token))
            .json(&json!({ "callback_query_id": id, "text": text }))
            .send()
            .await;
    }
}

/// Seconds since the last key press or mouse move: "away from the Mac".
pub fn idle_secs() -> u64 {
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-c", "IOHIDSystem"]).output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    text.lines()
        .find(|l| l.contains("\"HIDIdleTime\""))
        .and_then(|l| l.rsplit('=').next())
        .and_then(|n| n.trim().parse::<u64>().ok())
        .map(|ns| ns / 1_000_000_000)
        .unwrap_or(0)
}

/// Poll the bot for as long as the app runs.
pub fn start_listening(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut offset: i64 = 0;
        let mut menu_set = false;
        let long = reqwest::Client::builder().timeout(Duration::from_secs(65)).build();
        let Ok(long) = long else { return };
        loop {
            let Some(r) = remote(&app) else {
                tokio_sleep(60).await;
                continue;
            };
            // The "/" menu in Telegram, so the commands don't have to be remembered.
            if !menu_set {
                menu_set = true;
                let _ = long
                    .post(format!("https://api.telegram.org/bot{}/setMyCommands", r.token))
                    .json(&json!({ "commands": [
                        { "command": "stav", "description": "Co se děje: kdo pracuje, co čeká na tebe" },
                        { "command": "agenti", "description": "Agenti a jak jim dát úkol" },
                        { "command": "limity", "description": "Limity Claude, ChatGPT a Gemini" },
                        { "command": "mac", "description": "Baterie, teplota a jestli Mac drží vzhůru" },
                        { "command": "vzhuru", "description": "Držet Mac vzhůru (třeba /vzhuru 2h, /vzhuru vyp)" },
                        { "command": "viko", "description": "Běžet i se zavřeným víkem (/viko vyp)" },
                        { "command": "nadalku", "description": "V nabíječce nespát, ať se k Macu vždycky dostaneš" },
                        { "command": "spi", "description": "Uspat Mac" },
                        { "command": "pomoc", "description": "Jak se mnou mluvit" }
                    ] }))
                    .send()
                    .await;
            }
            let res = long
                .post(format!("https://api.telegram.org/bot{}/getUpdates", r.token))
                .json(&json!({ "offset": offset, "timeout": 50, "allowed_updates": ["message", "callback_query"] }))
                .send()
                .await;
            let v: Value = match res {
                Ok(resp) => resp.json().await.unwrap_or(Value::Null),
                Err(_) => {
                    tokio_sleep(10).await;
                    continue;
                }
            };
            if v["error_code"] == json!(409) {
                // Another program (job-mail's bot) takes this bot's updates.
                let _ = app.emit("tg-conflict", ());
                tokio_sleep(300).await;
                continue;
            }
            for u in v["result"].as_array().into_iter().flatten() {
                offset = offset.max(u["update_id"].as_i64().unwrap_or(0) + 1);
                if let Some(q) = u.get("callback_query") {
                    if q["message"]["chat"]["id"].as_i64().map(|i| i.to_string()) != Some(r.chat.clone()) {
                        continue;
                    }
                    let data = q["data"].as_str().unwrap_or("");
                    let qid = q["id"].as_str().unwrap_or("");
                    if let Some(rest) = data.strip_prefix("cc:") {
                        let (answer, id) = rest.split_once(':').unwrap_or(("", ""));
                        let ok = crate::claudecode::decide(id, answer);
                        answer_callback(&r, qid, if ok { "Hotovo" } else { "Už je vyřízené" }).await;
                    } else if data.starts_with("pr:") {
                        // Merge or close a pull request: the main window asks "really?" and does it.
                        answer_callback(&r, qid, "").await;
                        let _ = app.emit_to("main", "tg-pr", json!({ "data": data, "messageId": q["message"]["message_id"] }));
                    }
                } else if let Some(m) = u.get("message") {
                    if m["chat"]["id"].as_i64().map(|i| i.to_string()) != Some(r.chat.clone()) {
                        continue;
                    }
                    let text = m["text"].as_str().unwrap_or("").trim().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    let _ = app.emit_to(
                        "main",
                        "tg-message",
                        json!({ "text": text, "replyTo": m["reply_to_message"]["text"].as_str().unwrap_or("") }),
                    );
                }
            }
            if v["ok"] != json!(true) {
                tokio_sleep(10).await;
            }
        }
    });
}

async fn tokio_sleep(secs: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_secs(secs))).await.ok();
}
