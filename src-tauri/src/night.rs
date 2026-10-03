//! Noční směna: tasks for Claude Code written from the phone ("/noc buddy: add sounds"), done
//! while Erik is away. Each runs in its own git worktree on a new branch, so nothing he has
//! open is touched; the work is committed there, pushed, and opened as a draft PR. The result
//! goes to Telegram, quietly (it is likely the middle of the night).
//!
//! A task starts when Erik is away: at night (23–7), or after 20 minutes without the mouse
//! and keyboard, or at once when he asked for it ("/noc hned …"). One at a time.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

/// At most this long per task.
const LIMIT: Duration = Duration::from_secs(90 * 60);
/// Claude's five-hour limit at or above this: wait for it to reset.
const LIMIT_PCT: f64 = 85.0;
const NOREPLY: &str = "40054004+ErikKarasek@users.noreply.github.com";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project: String,
    pub task: String,
    /// queued, running, done, failed, cancelled
    pub status: String,
    #[serde(default)]
    pub now: bool,
    pub added_ms: u64,
    #[serde(default)]
    pub finished_ms: Option<u64>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub pr: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn path_env() -> String {
    let h = home();
    let h = h.display();
    format!("{h}/.local/bin:{h}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn file(app: &AppHandle) -> PathBuf {
    dir(app).join("night.json")
}

pub fn list(app: &AppHandle) -> Vec<Task> {
    std::fs::read(file(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Change the list as one step, under the lock.
fn change<R>(app: &AppHandle, f: impl FnOnce(&mut Vec<Task>) -> R) -> R {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = list(app);
    let out = f(&mut all);
    // Keep the queue and the last 30 finished.
    let finished: Vec<usize> = all.iter().enumerate().filter(|(_, t)| t.status != "queued" && t.status != "running").map(|(i, _)| i).collect();
    if finished.len() > 30 {
        let drop: Vec<usize> = finished[..finished.len() - 30].to_vec();
        let mut i = 0;
        all.retain(|_| {
            let keep = !drop.contains(&i);
            i += 1;
            keep
        });
    }
    let _ = std::fs::create_dir_all(dir(app));
    let tmp = file(app).with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(&all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, file(app));
    }
    out
}

/// The git projects in ~/Developer.
pub fn projects() -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(home().join("Developer"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join(".git").is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

/// "buddy", "Wisp Buddy", "job mail" → the folder it means, if exactly one fits.
pub fn find_project(name: &str) -> Option<String> {
    let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let want = norm(name);
    if want.is_empty() {
        return None;
    }
    let all = projects();
    if let Some(p) = all.iter().find(|p| norm(p) == want) {
        return Some(p.clone());
    }
    let partial: Vec<&String> = all.iter().filter(|p| norm(p).contains(&want)).collect();
    (partial.len() == 1).then(|| partial[0].clone())
}

pub fn add(app: &AppHandle, project: &str, task: &str, now: bool) -> Task {
    let t = Task {
        id: format!("{:x}", now_ms()),
        project: project.into(),
        task: task.trim().into(),
        status: "queued".into(),
        now,
        added_ms: now_ms(),
        finished_ms: None,
        summary: None,
        pr: None,
        branch: None,
    };
    change(app, |all| all.push(t.clone()));
    t
}

pub fn cancel(app: &AppHandle, id: &str) -> bool {
    change(app, |all| match all.iter_mut().find(|t| t.id == id && t.status == "queued") {
        Some(t) => {
            t.status = "cancelled".into();
            t.finished_ms = Some(now_ms());
            true
        }
        None => false,
    })
}

// ---------- running ----------

fn run(cmd: &str, args: &[&str], dir: &Path) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .current_dir(dir)
        .env("PATH", path_env())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("{cmd} selhal") } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    run("/usr/bin/git", args, dir)
}

/// A short branch name from the task: "noc/pridej-zvuky-1a2b".
fn branch_name(task: &Task) -> String {
    let ascii: String = task
        .task
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' => 'a', 'č' => 'c', 'ď' => 'd', 'é' | 'ě' => 'e', 'í' => 'i', 'ň' => 'n', 'ó' => 'o',
            'ř' => 'r', 'š' => 's', 'ť' => 't', 'ú' | 'ů' => 'u', 'ý' => 'y', 'ž' => 'z',
            c if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect();
    let words: Vec<&str> = ascii.split('-').filter(|w| !w.is_empty()).take(5).collect();
    format!("noc/{}-{}", words.join("-"), &task.id[task.id.len().saturating_sub(4)..])
}

struct Outcome {
    summary: String,
    pr: Option<String>,
    branch: Option<String>,
    ok: bool,
}

fn work(state: &Path, task: &Task) -> Outcome {
    let fail = |s: String| Outcome { summary: s, pr: None, branch: None, ok: false };
    let repo = home().join("Developer").join(&task.project);
    if !repo.join(".git").is_dir() {
        return fail(format!("{} už není git repozitář.", task.project));
    }
    let claude = home().join(".local/bin/claude");
    if !claude.exists() {
        return fail("Chybí Claude Code (claude).".into());
    }

    // Start from the newest default branch on GitHub, or from what is checked out without a remote.
    let has_remote = git(&repo, &["remote", "get-url", "origin"]).is_ok();
    let base = if has_remote {
        let _ = git(&repo, &["fetch", "-q", "origin"]);
        git(&repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).unwrap_or_else(|_| "origin/main".into())
    } else {
        "HEAD".into()
    };
    // The exact commit it starts from: "HEAD" would mean the new branch itself later on.
    let start = match git(&repo, &["rev-parse", &format!("{base}^{{commit}}")]) {
        Ok(sha) => sha,
        Err(e) => return fail(format!("Nevím, odkud začít: {e}")),
    };
    let branch = branch_name(task);
    let tree = state.join("noc").join(format!("{}-{}", task.project, task.id));
    let _ = std::fs::create_dir_all(tree.parent().unwrap_or(Path::new("/tmp")));
    if let Err(e) = git(&repo, &["worktree", "add", "-q", "-b", &branch, &tree.to_string_lossy(), &start]) {
        return fail(format!("Nepovedlo se připravit pracovní kopii: {e}"));
    }

    let prompt = format!(
        "Pracuješ v noci sám, Erik spí a na nic se ho nedá zeptat. Jsi v projektu {project} na nové větvi {branch} \
         (samostatná pracovní kopie, nic dalšího tu neběží).\n\nÚkol od Erika:\n{task}\n\n\
         Udělej ho celý, jak nejlíp umíš, ve stylu okolního kódu. Když něco není jasné, vyber rozumnou možnost a napiš to \
         do shrnutí. Průběžně commituj do téhle větve (git add + git commit, krátké zprávy v duchu historie projektu, \
         bez zmínek o Claudovi a bez Co-Authored-By). Nepushuj, to udělám já. Když projekt potřebuje závislosti, \
         nainstaluj je. Na konci ověř, že se to sestaví a testy projdou, pokud nějaké jsou.\n\n\
         Úplně na konec napiš česky, obyčejně jako v chatu, 3–6 vět: co jsi udělal, co jsi nestihl nebo nevěděl \
         a co má Erik ráno zkontrolovat.",
        project = task.project,
        task = task.task,
    );
    let tools = [
        "Read", "Edit", "Write", "Glob", "Grep", "WebSearch", "WebFetch",
        "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git add:*)", "Bash(git commit:*)",
        "Bash(git mv:*)", "Bash(git rm:*)", "Bash(ls:*)", "Bash(mkdir:*)",
        "Bash(cargo check:*)", "Bash(cargo build:*)", "Bash(cargo test:*)", "Bash(cargo fmt:*)", "Bash(cargo clippy:*)", "Bash(cargo add:*)",
        "Bash(pnpm install:*)", "Bash(pnpm add:*)", "Bash(pnpm run:*)", "Bash(pnpm test:*)", "Bash(pnpm build:*)", "Bash(pnpm exec:*)",
        "Bash(corepack pnpm:*)", "Bash(npm install:*)", "Bash(npm ci:*)", "Bash(npm run:*)", "Bash(npm test:*)", "Bash(npx tsc:*)",
        "Bash(node:*)", "Bash(python3:*)", "Bash(swift build:*)", "Bash(swift test:*)", "Bash(xcodebuild:*)",
    ]
    .join(",");
    // No "Co-Authored-By: Claude" and no "Generated with Claude Code".
    // No hooks either: Wisp's would ask Erik on the phone to allow each command, in the night.
    // Whatever isn't on the list above is just refused, and Claude finds another way.
    let settings = json!({ "includeCoAuthoredBy": false, "attribution": { "commit": "", "pr": "" }, "disableAllHooks": true }).to_string();
    let child = Command::new(&claude)
        .args(["-p", &prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", &tools, "--settings", &settings])
        .current_dir(&tree)
        .env("PATH", path_env())
        .env("GIT_AUTHOR_NAME", "Erik Karasek")
        .env("GIT_AUTHOR_EMAIL", NOREPLY)
        .env("GIT_COMMITTER_NAME", "Erik Karasek")
        .env("GIT_COMMITTER_EMAIL", NOREPLY)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            cleanup(&repo, &tree, &branch, true);
            return fail(e.to_string());
        }
    };
    let mut stdout = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let began = Instant::now();
    let mut timed_out = false;
    loop {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            break;
        }
        if began.elapsed() > LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let raw = reader.join().unwrap_or_default();
    let v: serde_json::Value = raw.find('{').and_then(|i| serde_json::from_str(&raw[i..]).ok()).unwrap_or_default();
    let mut summary = v.get("result").and_then(|r| r.as_str()).map(str::trim).unwrap_or_default().to_string();
    if timed_out {
        summary = format!("Nestihl jsem to za {} minut, uložil jsem, co bylo hotové. {summary}", LIMIT.as_secs() / 60);
    }

    // Anything Claude left uncommitted goes in one last commit, so nothing is lost with the worktree.
    if !git(&tree, &["status", "--porcelain"]).unwrap_or_default().is_empty() {
        let _ = git(&tree, &["add", "-A"]);
        let _ = Command::new("/usr/bin/git")
            .args(["commit", "-q", "-m", "Rozdělaná práce z noční směny"])
            .current_dir(&tree)
            .env("GIT_AUTHOR_NAME", "Erik Karasek")
            .env("GIT_AUTHOR_EMAIL", NOREPLY)
            .env("GIT_COMMITTER_NAME", "Erik Karasek")
            .env("GIT_COMMITTER_EMAIL", NOREPLY)
            .status();
    }
    let commits = git(&tree, &["rev-list", "--count", &format!("{start}..HEAD")]).ok().and_then(|n| n.parse::<u32>().ok()).unwrap_or(0);
    if commits == 0 {
        cleanup(&repo, &tree, &branch, true);
        return Outcome { summary: if summary.is_empty() { "Claude nic nezměnil a nic neřekl.".into() } else { summary }, pr: None, branch: None, ok: !timed_out };
    }

    // Up to GitHub as a draft PR, when the project has a remote.
    let mut pr = None;
    if has_remote && git(&tree, &["push", "-q", "-u", "origin", &branch]).is_ok() {
        let title: String = task.task.lines().next().unwrap_or("Noční směna").chars().take(70).collect();
        let body = format!("Noční směna: úkol z Telegramu.\n\n> {}\n\n{}", task.task.replace('\n', "\n> "), summary);
        let gh = home().join(".local/bin/gh");
        let gh = if gh.exists() { gh } else { PathBuf::from("/opt/homebrew/bin/gh") };
        let base_branch = base.strip_prefix("origin/").unwrap_or(&base).to_string();
        pr = run(&gh.to_string_lossy(), &["pr", "create", "--draft", "--base", &base_branch, "--head", &branch, "--title", &title, "--body", &body], &tree)
            .ok()
            .and_then(|out| out.lines().rev().find(|l| l.starts_with("https://")).map(String::from));
    }
    cleanup(&repo, &tree, &branch, false);
    Outcome { summary, pr, branch: Some(branch), ok: !timed_out }
}

/// The worktree goes; the branch stays unless nothing came of it.
fn cleanup(repo: &Path, tree: &Path, branch: &str, drop_branch: bool) {
    let _ = git(repo, &["worktree", "remove", "--force", &tree.to_string_lossy()]);
    let _ = std::fs::remove_dir_all(tree);
    let _ = git(repo, &["worktree", "prune"]);
    if drop_branch {
        let _ = git(repo, &["branch", "-D", branch]);
    }
}

fn local_hour() -> i32 {
    let secs = (now_ms() / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    tm.tm_hour
}

/// Erik is away: night, or 20 minutes without touching the Mac.
fn away() -> bool {
    let h = local_hour();
    h >= 23 || h < 7 || crate::telegram::idle_secs() >= 20 * 60
}

fn tell(app: &AppHandle, text: String) {
    if let Some(r) = crate::telegram::remote(app) {
        tauri::async_runtime::spawn(async move {
            let _ = crate::telegram::send_quiet(&r.token, &r.chat, &text).await;
        });
    }
}

pub fn start(app: AppHandle) {
    // A task left "running" by a crash or a restart goes back in the queue.
    change(&app, |all| {
        for t in all.iter_mut().filter(|t| t.status == "running") {
            t.status = "queued".into();
        }
    });
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let next = list(&app).into_iter().find(|t| t.status == "queued" && (t.now || away()));
        let Some(task) = next else { continue };
        // Not on the last few percent of Claude's limit: it would stop halfway. It resets within 5 hours.
        if !task.now && crate::claudecode::claude_session_percent().is_some_and(|p| p >= LIMIT_PCT) {
            continue;
        }
        change(&app, |all| {
            if let Some(t) = all.iter_mut().find(|t| t.id == task.id) {
                t.status = "running".into();
            }
        });
        let out = work(&dir(&app), &task);
        change(&app, |all| {
            if let Some(t) = all.iter_mut().find(|t| t.id == task.id) {
                t.status = if out.ok { "done" } else { "failed" }.into();
                t.finished_ms = Some(now_ms());
                t.summary = Some(out.summary.clone());
                t.pr = out.pr.clone();
                t.branch = out.branch.clone();
            }
        });
        let head = if out.ok { "🌙 Noční směna hotovo" } else { "🌙 Noční směna nedopadla" };
        let link = match (&out.pr, &out.branch) {
            (Some(pr), _) => format!("\n\nPR ke kontrole: {pr}"),
            (None, Some(b)) => format!("\n\nPráce je ve větvi {b}."),
            _ => String::new(),
        };
        tell(&app, format!("{head} · {}\n„{}“\n\n{}{link}", task.project, task.task, out.summary));
    });
}

/// "/noc …" from Telegram, answered in a sentence or a list.
pub fn command(app: &AppHandle, arg: &str) -> String {
    let arg = arg.trim();
    let all = list(app);
    let queued: Vec<&Task> = all.iter().filter(|t| t.status == "queued").collect();
    let plain = |s: &str| s.to_lowercase().replace('š', "s").replace('ú', "u");
    if arg.is_empty() || plain(arg) == "seznam" {
        let mut lines = vec!["🌙 Noční směna".to_string()];
        if let Some(t) = all.iter().find(|t| t.status == "running") {
            lines.push(format!("Teď dělám: {} – {}", t.project, t.task));
        } else if !queued.is_empty() && crate::claudecode::claude_session_percent().is_some_and(|p| p >= LIMIT_PCT) {
            lines.push("Čekám, až se Claudovi obnoví limit (je skoro vyčerpaný).".into());
        }
        if queued.is_empty() {
            lines.push("Ve frontě nic není.".into());
        } else {
            lines.push("Ve frontě:".into());
            for (i, t) in queued.iter().enumerate() {
                lines.push(format!("{}. {} – {}{}", i + 1, t.project, t.task, if t.now { " (hned)" } else { "" }));
            }
        }
        let done: Vec<&Task> = all.iter().rev().filter(|t| t.status == "done" || t.status == "failed").take(3).collect();
        if !done.is_empty() {
            lines.push("Naposledy:".into());
            for t in done {
                lines.push(format!("• {} – {}{}", t.project, t.task, t.pr.as_ref().map(|p| format!(" → {p}")).unwrap_or_else(|| if t.status == "failed" { " (nedopadlo)".into() } else { String::new() })));
            }
        }
        lines.push(String::new());
        lines.push("Nový úkol: /noc projekt: co udělat (třeba /noc wisp-buddy: přidej zvuky při skoku). Začnu v noci nebo až budeš 20 minut pryč, s „/noc hned …“ hned. Zrušit: /noc zrus 1".into());
        return lines.join("\n");
    }
    if let Some(n) = plain(arg).strip_prefix("zrus").map(str::trim).and_then(|n| n.parse::<usize>().ok()) {
        return match queued.get(n.wrapping_sub(1)) {
            Some(t) if cancel(app, &t.id) => format!("Zrušeno: {} – {}", t.project, t.task),
            _ => "Takový úkol ve frontě není. Seznam: /noc".into(),
        };
    }
    let (now, rest) = match plain(arg).strip_prefix("hned") {
        Some(_) => (true, arg[arg.char_indices().nth(4).map(|(i, _)| i).unwrap_or(arg.len())..].trim()),
        None => (false, arg),
    };
    let Some((name, task)) = rest.split_once(':') else {
        return "Napiš projekt a úkol oddělené dvojtečkou, třeba: /noc wisp-buddy: přidej zvuky při skoku".into();
    };
    if task.trim().len() < 5 {
        return "Napiš k tomu, co mám udělat.".into();
    }
    let Some(project) = find_project(name) else {
        return format!("Projekt „{}“ jsem nenašel. Mám tyhle: {}", name.trim(), projects().join(", "));
    };
    let t = add(app, &project, task, now);
    let when = if now { "Začínám hned." } else if away() { "Začnu do minuty, jsi pryč." } else { "Začnu v noci, nebo až budeš 20 minut od Macu." };
    let ahead = queued.len();
    format!(
        "Zapsáno pro {}: „{}“. {when}{} Pracuju ve vlastní větvi, tvoje rozdělané věci nechám být. Výsledek ti pošlu sem jako PR.",
        t.project,
        t.task,
        if ahead > 0 { format!(" Před ním {} ve frontě.", ahead) } else { String::new() }
    )
}

#[cfg(test)]
mod live {
    /// NOC_PROJECT=… NOC_TASK=… cargo test --lib night::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn work_once() {
        let task = super::Task {
            id: format!("{:x}", super::now_ms()),
            project: std::env::var("NOC_PROJECT").expect("NOC_PROJECT"),
            task: std::env::var("NOC_TASK").expect("NOC_TASK"),
            status: "running".into(),
            now: true,
            added_ms: super::now_ms(),
            finished_ms: None,
            summary: None,
            pr: None,
            branch: None,
        };
        let state = std::env::temp_dir().join("noc-test");
        let t = std::time::Instant::now();
        let out = super::work(&state, &task);
        println!("in {:?}, ok={}, branch={:?}, pr={:?}\n{}", t.elapsed(), out.ok, out.branch, out.pr, out.summary);
    }
}
