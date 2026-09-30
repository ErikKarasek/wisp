//! GitHub Actions through the `gh` CLI, so the app uses the login the user
//! already has instead of storing another token. Every repository name and
//! workflow id is checked before it goes near a command line.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

fn gh_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        format!("{home}/.local/bin/gh"),
        "/opt/homebrew/bin/gh".into(),
        "/usr/local/bin/gh".into(),
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

fn is_repo(s: &str) -> bool {
    let mut parts = s.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| !p.is_empty() && p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn gh(args: &[&str]) -> Result<String, String> {
    let bin = gh_path().ok_or("Nenašel jsem gh (GitHub CLI).")?;
    let out = Command::new(bin)
        .args(args)
        // A GUI app starts with a bare environment; gh only needs HOME.
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn api(path: &str) -> Result<Value, String> {
    serde_json::from_str(&gh(&["api", path])?).map_err(|e| e.to_string())
}

fn repo_snapshot(repo: &str) -> Value {
    let workflows = match api(&format!("repos/{repo}/actions/workflows?per_page=100")) {
        Ok(v) => v["workflows"].as_array().cloned().unwrap_or_default(),
        Err(e) => return json!({ "repo": repo, "error": e }),
    };
    let items: Vec<Value> = workflows
        .into_iter()
        .map(|w| {
            // Asked per workflow: a repo-wide page misses workflows that last ran long ago.
            let last = api(&format!("repos/{repo}/actions/workflows/{}/runs?per_page=1", w["id"]))
                .ok()
                .and_then(|v| v["workflow_runs"].get(0).cloned());
            json!({
                "id": w["id"],
                "name": w["name"],
                "path": w["path"],
                "state": w["state"],
                "htmlUrl": w["html_url"],
                "lastRun": last.map(|r| json!({
                    "status": r["status"],
                    "conclusion": r["conclusion"],
                    "event": r["event"],
                    "branch": r["head_branch"],
                    "title": r["display_title"],
                    "createdAt": r["created_at"],
                    "updatedAt": r["updated_at"],
                    "htmlUrl": r["html_url"],
                })),
            })
        })
        .collect();
    json!({ "repo": repo, "workflows": items })
}

pub fn snapshot(repos: &[String]) -> Value {
    if gh_path().is_none() {
        return json!({ "ok": false, "error": "Nenašel jsem gh (GitHub CLI)." });
    }
    let repos: Vec<Value> = repos
        .iter()
        .filter(|r| is_repo(r))
        .map(|r| repo_snapshot(r))
        .collect();
    json!({ "ok": true, "repos": repos })
}

/// The user's repositories that have at least one workflow.
pub fn discover() -> Result<Vec<String>, String> {
    let list = gh(&["repo", "list", "--limit", "100", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"])?;
    Ok(list
        .lines()
        .map(str::trim)
        .filter(|r| is_repo(r))
        .filter(|r| {
            api(&format!("repos/{r}/actions/workflows?per_page=1"))
                .map(|v| v["total_count"].as_i64().unwrap_or(0) > 0)
                .unwrap_or(false)
        })
        .map(String::from)
        .collect())
}

pub fn action(repo: &str, workflow_id: i64, action: &str) -> Result<(), String> {
    if !is_repo(repo) {
        return Err("Neplatné repo".into());
    }
    let id = workflow_id.to_string();
    let verb = match action {
        "run" => "run",
        "enable" => "enable",
        "disable" => "disable",
        other => return Err(format!("Neznámá akce {other}")),
    };
    gh(&["workflow", verb, &id, "-R", repo]).map(|_| ())
}
