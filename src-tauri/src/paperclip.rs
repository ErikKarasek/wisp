//! The local Paperclip server. Read companies, agents, routines and issues in
//! one go, and run the handful of actions the app offers. The API only listens
//! on 127.0.0.1, and the webview can't call it directly (no CORS), so it goes
//! through here.

use serde_json::{json, Value};
use std::time::Duration;

const BASE: &str = "http://127.0.0.1:3100";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}

async fn get(c: &reqwest::Client, path: &str) -> Result<Value, String> {
    let res = c
        .get(format!("{BASE}/api{path}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{path}: HTTP {}", res.status()));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn list(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("items") {
            Some(Value::Array(a)) => a,
            _ => vec![],
        },
        _ => vec![],
    }
}

pub async fn snapshot() -> Value {
    let c = match client() {
        Ok(c) => c,
        Err(e) => return json!({ "online": false, "error": e }),
    };
    let companies = match get(&c, "/companies").await {
        Ok(v) => list(v),
        Err(e) => return json!({ "online": false, "error": e }),
    };
    let mut out = Vec::new();
    for company in companies {
        let Some(id) = company.get("id").and_then(|v| v.as_str()).map(String::from) else {
            continue;
        };
        let agents = get(&c, &format!("/companies/{id}/agents")).await.map(list).unwrap_or_default();
        let routines = get(&c, &format!("/companies/{id}/routines")).await.map(list).unwrap_or_default();
        let issues = get(&c, &format!("/companies/{id}/issues")).await.map(list).unwrap_or_default();
        out.push(json!({
            "company": company,
            "agents": agents,
            "routines": routines,
            // Finished work only clutters the view.
            "issues": issues
                .into_iter()
                .filter(|i| !matches!(i.get("status").and_then(|s| s.as_str()), Some("done" | "cancelled")))
                .collect::<Vec<_>>(),
        }));
    }
    json!({ "online": true, "baseUrl": BASE, "companies": out })
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub async fn action(kind: &str, id: &str) -> Result<(), String> {
    if !is_id(id) {
        return Err("Neplatné id".into());
    }
    let (path, body) = match kind {
        "agentPause" => (format!("/agents/{id}/pause"), json!({})),
        "agentResume" => (format!("/agents/{id}/resume"), json!({})),
        "agentInvoke" => (format!("/agents/{id}/heartbeat/invoke"), json!({})),
        "routineRun" => (format!("/routines/{id}/run"), json!({ "source": "manual" })),
        _ => return Err(format!("Neznámá akce {kind}")),
    };
    let res = client()?
        .post(format!("{BASE}/api{path}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or(text);
        Err(format!("HTTP {status}: {msg}"))
    }
}
