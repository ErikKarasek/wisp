//! Cloudflare Workers: which scripts exist, their cron schedules, how the last
//! day went, and how much of the daily Workers AI allowance is used. Read only.
//! The API token lives in the Keychain (see `secrets`); it never reaches the page.

use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API: &str = "https://api.cloudflare.com/client/v4";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn rest(c: &reqwest::Client, token: &str, path: &str) -> Result<Value, String> {
    let res = c
        .get(format!("{API}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() || v["success"] == json!(false) {
        let msg = v["errors"][0]["message"].as_str().unwrap_or("chyba").to_string();
        return Err(format!("{path}: HTTP {status}: {msg}"));
    }
    Ok(v["result"].clone())
}

async fn graphql(c: &reqwest::Client, token: &str, query: &str, vars: Value) -> Result<Value, String> {
    let res = c
        .post(format!("{API}/graphql"))
        .bearer_auth(token)
        .json(&json!({ "query": query, "variables": vars }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = v["errors"].as_array().and_then(|e| e.first()) {
        return Err(err["message"].as_str().unwrap_or("GraphQL chyba").to_string());
    }
    Ok(v["data"].clone())
}

fn iso(t: SystemTime) -> String {
    // RFC 3339 in UTC without pulling in a date crate.
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

const INVOCATIONS: &str = r#"
query ($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors }
      dimensions { scriptName }
    }
  } }
}"#;

const CRON_EVENTS: &str = r#"
query ($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsScheduled(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
      scriptName cron status datetime
    }
  } }
}"#;

const NEURONS: &str = r#"
query ($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    aiInferenceAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) {
      sum { totalNeurons }
    }
  } }
}"#;

pub async fn snapshot(token: Option<String>) -> Value {
    let Some(token) = token else {
        return json!({ "configured": false });
    };
    let c = match client() {
        Ok(c) => c,
        Err(e) => return json!({ "configured": true, "error": e }),
    };
    let accounts = match rest(&c, &token, "/accounts").await {
        Ok(a) => a.as_array().cloned().unwrap_or_default(),
        Err(e) => return json!({ "configured": true, "error": e }),
    };
    let Some(account) = accounts.first().and_then(|a| a["id"].as_str()).map(String::from) else {
        return json!({ "configured": true, "error": "Token nevidí žádný účet." });
    };
    let scripts = match rest(&c, &token, &format!("/accounts/{account}/workers/scripts")).await {
        Ok(s) => s.as_array().cloned().unwrap_or_default(),
        Err(e) => return json!({ "configured": true, "account": account, "error": e }),
    };

    let mut workers = Vec::new();
    for s in &scripts {
        let Some(name) = s["id"].as_str() else { continue };
        let schedules = rest(&c, &token, &format!("/accounts/{account}/workers/scripts/{name}/schedules"))
            .await
            .map(|v| v["schedules"].clone())
            .unwrap_or(json!([]));
        workers.push(json!({
            "name": name,
            "modifiedOn": s["modified_on"],
            "schedules": schedules,
        }));
    }

    let now = SystemTime::now();
    let day_ago = now - Duration::from_secs(86_400);
    let vars = json!({ "account": account, "start": iso(day_ago), "end": iso(now) });
    let invocations = graphql(&c, &token, INVOCATIONS, vars.clone()).await;
    let cron_events = graphql(&c, &token, CRON_EVENTS, vars).await;

    // The Workers AI allowance resets at 00:00 UTC.
    let secs = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let midnight = UNIX_EPOCH + Duration::from_secs(secs - secs % 86_400);
    let neurons = graphql(&c, &token, NEURONS, json!({ "account": account, "start": iso(midnight), "end": iso(now) })).await;

    let pick = |r: &Result<Value, String>, key: &str| match r {
        Ok(d) => json!({ "ok": d["viewer"]["accounts"][0][key] }),
        Err(e) => json!({ "error": e }),
    };
    json!({
        "configured": true,
        "account": account,
        "workers": workers,
        "invocations": pick(&invocations, "workersInvocationsAdaptive"),
        "cronEvents": pick(&cron_events, "workersInvocationsScheduled"),
        "neurons": pick(&neurons, "aiInferenceAdaptiveGroups"),
    })
}
