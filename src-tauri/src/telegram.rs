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
