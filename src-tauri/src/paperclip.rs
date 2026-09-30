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

/// The calls Dispečink makes, and only those. `{id}` stands for one id segment.
const ALLOWED: &[(&str, &str)] = &[
    // tasks and their comments
    ("GET", "/issues/{id}"),
    ("PATCH", "/issues/{id}"),
    ("GET", "/issues/{id}/comments"),
    ("POST", "/issues/{id}/comments"),
    ("POST", "/companies/{id}/issues"),
    ("GET", "/companies/{id}/issues"),
    // what an agent is doing: its runs and their logs
    ("GET", "/companies/{id}/heartbeat-runs"),
    ("GET", "/heartbeat-runs/{id}"),
    ("GET", "/heartbeat-runs/{id}/log"),
    // agents' secrets (values go in, never come back out)
    ("GET", "/companies/{id}/secrets"),
    ("POST", "/companies/{id}/secrets"),
    ("POST", "/secrets/{id}/rotate"),
    // routines and their schedules
    ("POST", "/companies/{id}/routines"),
    ("PATCH", "/routines/{id}"),
    ("POST", "/routines/{id}/triggers"),
    ("PATCH", "/routine-triggers/{id}"),
    // agents
    ("GET", "/agents/{id}"),
    ("PATCH", "/agents/{id}"),
    ("DELETE", "/agents/{id}"),
    ("POST", "/agents/{id}/terminate"),
    ("GET", "/agents/{id}/instructions-bundle"),
    ("GET", "/agents/{id}/instructions-bundle/file"),
    ("PUT", "/agents/{id}/instructions-bundle/file"),
    ("POST", "/companies/{id}/agents"),
    ("GET", "/companies/{id}/skills"),
    ("GET", "/companies/{id}/adapters/claude_local/models"),
    ("GET", "/companies/{id}/adapters/codex_local/models"),
    // how much of the ChatGPT (and Claude) subscription is used
    ("GET", "/companies/{id}/costs/quota-windows"),
];

fn allowed(method: &str, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    let segs: Vec<&str> = path.split('/').collect();
    ALLOWED.iter().any(|(m, pattern)| {
        let pat: Vec<&str> = pattern.split('/').collect();
        *m == method
            && pat.len() == segs.len()
            && pat.iter().zip(&segs).all(|(p, s)| if *p == "{id}" { is_id(s) } else { p == s })
    })
}

pub async fn request(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !allowed(method, path) {
        return Err(format!("{method} {path} Dispečink nesmí volat"));
    }
    // Only these query keys, with plain values.
    const KEYS: &[&str] = &["path", "limit", "agentId", "offset", "limitBytes"];
    if let Some(q) = path.split_once('?').map(|(_, q)| q) {
        let ok = q.split('&').all(|pair| {
            pair.split_once('=').is_some_and(|(k, v)| {
                KEYS.contains(&k) && !v.contains("..") && v.chars().all(|c| c.is_ascii_alphanumeric() || "-_.%".contains(c))
            })
        });
        if !ok {
            return Err("Neplatný dotaz".into());
        }
    }
    let url = format!("{BASE}/api{path}");
    let c = client()?;
    let req = match method {
        "GET" => c.get(&url),
        "PATCH" => c.patch(&url),
        "PUT" => c.put(&url),
        "POST" => c.post(&url),
        "DELETE" => c.delete(&url),
        _ => unreachable!(),
    };
    let req = match body {
        Some(b) => req.json(&b),
        None => req,
    };
    // Paperclip asks the Claude and Codex CLIs for the limits, which takes ~9 s.
    let req = if path.ends_with("/costs/quota-windows") { req.timeout(Duration::from_secs(30)) } else { req };
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if status.is_success() {
        Ok(v)
    } else {
        let msg = v.get("error").and_then(|e| e.as_str()).map(String::from).unwrap_or(text);
        Err(format!("HTTP {status}: {msg}"))
    }
}

/// ChatGPT agents run Codex by its full path inside Paperclip's own install,
/// which moves with every Paperclip update. Point any agent whose codex is gone
/// at the current one; returns the names it fixed.
pub async fn heal_codex(command: &str) -> Result<Vec<String>, String> {
    let c = client()?;
    let mut fixed = Vec::new();
    for company in list(get(&c, "/companies").await?) {
        let Some(cid) = company["id"].as_str() else { continue };
        for a in list(get(&c, &format!("/companies/{cid}/agents")).await.unwrap_or_default()) {
            if a["adapterType"] != "codex_local" || a["status"] == "terminated" {
                continue;
            }
            let Some(id) = a["id"].as_str() else { continue };
            let full = get(&c, &format!("/agents/{id}")).await?;
            let current = full["adapterConfig"]["command"].as_str().unwrap_or("");
            if !current.is_empty() && std::path::Path::new(current).exists() {
                continue;
            }
            let res = c
                .patch(format!("{BASE}/api/agents/{id}"))
                .json(&serde_json::json!({ "adapterConfig": { "command": command, "engine": "cli" } }))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if res.status().is_success() {
                fixed.push(a["name"].as_str().unwrap_or(id).to_string());
            }
        }
    }
    Ok(fixed)
}
