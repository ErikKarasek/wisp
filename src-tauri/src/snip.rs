//! ⌃⌥E: mark an error anywhere on the screen. Gemini (through Antigravity, so free) reads the
//! picture, says what went wrong and which project in ~/Developer it came from. On Erik's
//! button Claude Code fixes it right there in the folder (no commit), and one more button
//! puts every file back the way it was.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn developer() -> PathBuf {
    home().join("Developer")
}

/// An app started by launchd has a bare PATH; Claude's checks need cargo, pnpm and friends.
fn path_env() -> String {
    let h = home();
    let h = h.display();
    format!("{h}/.local/bin:{h}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
}

fn millis() -> u128 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

// ---------- marking a part of the screen ----------

/// The crosshair (Space switches to a whole window, Esc gives up). None when given up.
pub fn capture() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("dispecink-ask");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("vyrez-{}.png", millis()));
    // -i interactive, -x no sound, -o no window shadow. Needs Screen Recording for Wisp.
    let _ = Command::new("/usr/sbin/screencapture").args(["-i", "-x", "-o"]).arg(&path).status();
    path.exists().then_some(path)
}

// ---------- reading it ----------

/// The git projects in ~/Developer, the most recently touched first.
fn projects() -> Vec<(String, u64)> {
    let now = SystemTime::now();
    let mut out: Vec<(String, u64)> = std::fs::read_dir(developer())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let git = e.path().join(".git");
            if !git.is_dir() {
                return None;
            }
            let touched = ["index", "logs/HEAD", "HEAD"]
                .iter()
                .filter_map(|f| std::fs::metadata(git.join(f)).and_then(|m| m.modified()).ok())
                .max()?;
            let ago = now.duration_since(touched).map(|d| d.as_secs()).unwrap_or(0);
            Some((e.file_name().to_string_lossy().into_owned(), ago))
        })
        .collect();
    out.sort_by_key(|p| p.1);
    out
}

fn ago(secs: u64) -> String {
    match secs {
        s if s < 3600 => format!("před {} min", s / 60),
        s if s < 86_400 => format!("před {} h", s / 3600),
        s => format!("před {} dny", s / 86_400),
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// Whether the picture shows an error at all.
    pub error: bool,
    /// One sentence for the notch.
    pub summary: String,
    /// The error's text, copied out of the picture.
    pub text: String,
    /// A folder in ~/Developer, when Gemini could tell.
    pub project: Option<String>,
    pub file: Option<String>,
    pub cause: String,
}

/// Gemini looks at the picture: what it is, and where it came from.
pub fn read(path: &str, app: &str, title: &str) -> Result<Reading, String> {
    let agy = home().join(".local/bin/agy");
    if !agy.exists() {
        return Err("Chybí Antigravity CLI (agy).".into());
    }
    let file = Path::new(path);
    let dir = file.parent().ok_or("Obrázek není.")?;
    let list = projects();
    let names = list.iter().take(30).map(|(n, a)| format!("- {n} (změna {})", ago(*a))).collect::<Vec<_>>().join("\n");
    let prompt = format!(
        "Obrázek: {path}\n\nErik si na obrazovce označil tenhle výřez. Byl v okně: {app}{}.\n\n\
         Jeho projekty v ~/Developer (nahoře ty, na kterých dělal naposledy):\n{names}\n\n\
         Podívej se na obrázek. Když na něm je chyba (výpis z terminálu, kompilátoru, testů, prohlížeče, \
         hláška aplikace…), zjisti, ze kterého projektu nejspíš je: podle cest, názvů souborů a balíčků \
         v textu, podle okna, a když nic z toho, podle toho, na čem dělal naposledy. Smíš si ty projekty \
         prohlédnout (jen číst). Nic nespouštěj a nic neměň.\n\n\
         Odpověz jen tímhle JSONem, bez ničeho okolo:\n\
         {{\"error\": true/false, \"summary\": \"jedna krátká věta česky, co se stalo (u nechyby: co na obrázku je)\", \
         \"text\": \"text chyby přepsaný z obrázku, doslova (u nechyby prázdný)\", \
         \"project\": \"název složky ze seznamu, nebo null\", \"file\": \"soubor a řádek, když je vidět, jinak null\", \
         \"cause\": \"česky jednou dvěma větami, čím to asi je\"}}",
        if title.is_empty() { String::new() } else { format!(" · {title}") }
    );
    let out = Command::new(agy)
        .args(["-p", &prompt, "--model", "gemini-3.8-flash-medium", "--output-format", "json", "--print-timeout", "3m", "--add-dir"])
        .arg(dir)
        .arg("--add-dir")
        .arg(developer())
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = raw.find('{').and_then(|i| serde_json::from_str(&raw[i..]).ok()).unwrap_or_default();
    let answer = v.get("response").and_then(|r| r.as_str()).unwrap_or_default();
    // The answer is JSON, maybe inside ``` fences.
    let json = match (answer.find('{'), answer.rfind('}')) {
        (Some(a), Some(b)) if b > a => &answer[a..=b],
        _ => return Err("Gemini neodpověděl.".into()),
    };
    let mut r: Reading = serde_json::from_str(json).map_err(|_| "Gemini odpověděl nesrozumitelně.".to_string())?;
    // Only a folder that is really there.
    r.project = r.project.filter(|p| list.iter().any(|(n, _)| n == p));
    Ok(r)
}

// ---------- fixing it, with a way back ----------

/// What a fix changed, kept until Erik keeps it or takes it back.
struct Undo {
    dir: PathBuf,
    /// The folder's state before: a commit made by `git stash create` (HEAD when nothing was changed).
    before: String,
    /// Files that were not in git before, copied aside: Claude may have changed them too.
    backup: PathBuf,
    untracked_before: Vec<String>,
    changed: Vec<String>,
    created: Vec<String>,
}

static UNDO: Mutex<Option<HashMap<String, Undo>>> = Mutex::new(None);
static RUNNING: Mutex<bool> = Mutex::new(false);

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("/usr/bin/git").args(args).current_dir(dir).env("PATH", path_env()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn lines(s: String) -> Vec<String> {
    s.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixed {
    pub id: String,
    /// Claude's own words: what was wrong and what it changed.
    pub summary: String,
    /// Every file that is different now, relative to the project.
    pub files: Vec<String>,
}

/// Claude Code fixes the error in `project`, in place. Nothing is committed.
pub fn fix(project: &str, text: &str, cause: &str, file: Option<&str>) -> Result<Fixed, String> {
    if project.contains('/') || project.starts_with('.') {
        return Err("Divný název projektu.".into());
    }
    let dir = developer().join(project);
    if !dir.join(".git").is_dir() {
        return Err(format!("{project} není git repozitář."));
    }
    let claude = home().join(".local/bin/claude");
    if !claude.exists() {
        return Err("Chybí Claude Code (claude).".into());
    }
    {
        let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if *running {
            return Err("Claude už jednu chybu opravuje.".into());
        }
        *running = true;
    }
    let result = fix_locked(&dir, &claude, project, text, cause, file);
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = false;
    result
}

fn fix_locked(dir: &Path, claude: &Path, project: &str, text: &str, cause: &str, file: Option<&str>) -> Result<Fixed, String> {
    // The way back, before anything changes.
    let stash = git(dir, &["stash", "create"])?;
    let before = if stash.is_empty() { git(dir, &["rev-parse", "HEAD"])? } else { stash };
    let untracked_before = lines(git(dir, &["ls-files", "-o", "--exclude-standard"])?);
    let id = format!("{}", millis());
    let backup = std::env::temp_dir().join("dispecink-fix").join(&id);
    let mut size = 0u64;
    for f in &untracked_before {
        let src = dir.join(f);
        let len = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        size += len;
        if size > 50_000_000 {
            return Err("V projektu je moc souborů mimo git, nedokázal bych je vrátit. Oprav to radši ručně.".into());
        }
        let dst = backup.join(f);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    }

    let prompt = format!(
        "Erik si na obrazovce označil tuhle chybu z projektu {project}:\n---\n{text}\n---\n\
         Gemini z obrázku odhaduje: {cause}{}\n\n\
         Najdi skutečnou příčinu a oprav ji co nejmenší změnou přímo v tomhle repozitáři. \
         Necommituj, nic neinstaluj, nic nemaž kromě toho, co oprava potřebuje. Když to jde, ověř opravu \
         (typecheck, build nebo testy). Když chyba z kódu opravit nejde (chybí přihlášení, síť, \
         oprávnění v macOS…), nic neměň a napiš, co má Erik udělat.\n\n\
         Na konci napiš česky dvě tři krátké věty, obyčejně jako v chatu: co bylo špatně a co jsi změnil.",
        file.map(|f| format!("\nSoubor z výpisu: {f}")).unwrap_or_default()
    );
    let tools = [
        "Read", "Edit", "Write", "Glob", "Grep",
        "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
        "Bash(cargo check:*)", "Bash(cargo test:*)", "Bash(cargo build:*)",
        "Bash(npx tsc:*)", "Bash(pnpm exec tsc:*)", "Bash(pnpm build:*)", "Bash(pnpm test:*)",
        "Bash(npm run:*)", "Bash(pnpm run:*)", "Bash(npm test:*)", "Bash(node:*)", "Bash(python3:*)",
    ]
    .join(",");
    let mut child = Command::new(claude)
        .args(["-p", &prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", &tools])
        .current_dir(dir)
        .env("PATH", path_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    // At most a quarter of an hour; the output is read on the side so a long one can't block it.
    let mut stdout = child.stdout.take().ok_or("Claude neběží.")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(15 * 60) {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let raw = reader.join().unwrap_or_default();
    let v: serde_json::Value = raw.find('{').and_then(|i| serde_json::from_str(&raw[i..]).ok()).unwrap_or_default();
    let summary = v.get("result").and_then(|r| r.as_str()).map(str::trim).unwrap_or_default().to_string();

    // What is different now.
    let changed = lines(git(dir, &["diff", "--name-only", &before])?);
    let untracked_now = lines(git(dir, &["ls-files", "-o", "--exclude-standard"])?);
    let created: Vec<String> = untracked_now.iter().filter(|f| !untracked_before.contains(f)).cloned().collect();
    let touched_untracked: Vec<String> = untracked_before
        .iter()
        .filter(|f| std::fs::read(dir.join(f)).ok() != std::fs::read(backup.join(f)).ok())
        .cloned()
        .collect();
    let mut files: Vec<String> = changed.iter().chain(&created).chain(&touched_untracked).cloned().collect();
    files.sort();
    files.dedup();

    if summary.is_empty() && files.is_empty() {
        let _ = std::fs::remove_dir_all(&backup);
        return Err(if start.elapsed() > Duration::from_secs(15 * 60) { "Claude to nestihl za čtvrt hodiny.".into() } else { "Claude neodpověděl.".into() });
    }
    if files.is_empty() {
        let _ = std::fs::remove_dir_all(&backup);
    } else {
        UNDO.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(
            id.clone(),
            Undo { dir: dir.to_path_buf(), before, backup, untracked_before, changed, created },
        );
    }
    Ok(Fixed { id, summary, files })
}

/// "Vrátit": every file as it was before the fix.
pub fn undo(id: &str) -> Result<(), String> {
    let u = UNDO.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|m| m.remove(id)).ok_or("Tahle oprava už vrátit nejde.")?;
    // Files in git: back to their content before, in the working tree only (what was staged stays staged).
    for f in &u.changed {
        let in_before = git(&u.dir, &["cat-file", "-e", &format!("{}:{f}", u.before)]).is_ok();
        if in_before {
            git(&u.dir, &["restore", &format!("--source={}", u.before), "--worktree", "--", f])?;
        } else {
            let _ = std::fs::remove_file(u.dir.join(f));
        }
    }
    for f in &u.created {
        let _ = std::fs::remove_file(u.dir.join(f));
    }
    for f in &u.untracked_before {
        let saved = u.backup.join(f);
        if std::fs::read(u.dir.join(f)).ok() != std::fs::read(&saved).ok() {
            std::fs::copy(&saved, u.dir.join(f)).map_err(|e| e.to_string())?;
        }
    }
    let _ = std::fs::remove_dir_all(&u.backup);
    Ok(())
}

/// "Nechat": the fix stays, the way back is dropped.
pub fn keep(id: &str) {
    if let Some(u) = UNDO.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|m| m.remove(id)) {
        let _ = std::fs::remove_dir_all(&u.backup);
    }
}

#[cfg(test)]
mod live {
    /// SNIP_IMG=… cargo test --lib snip::live -- --ignored --nocapture: reads the picture, fixes
    /// the error with Claude, prints what changed and takes it back (SNIP_KEEP=1 keeps it).
    #[test]
    #[ignore]
    fn read_fix_undo() {
        let img = std::env::var("SNIP_IMG").expect("SNIP_IMG");
        let t = std::time::Instant::now();
        let r = super::read(&img, "Terminal", "").expect("read");
        println!("read in {:?}: {}", t.elapsed(), serde_json::to_string_pretty(&r).unwrap());
        let Some(project) = r.project.clone() else { return };
        let t = std::time::Instant::now();
        let f = super::fix(&project, &r.text, &r.cause, r.file.as_deref()).expect("fix");
        println!("fix in {:?}: {}\nfiles: {:?}", t.elapsed(), f.summary, f.files);
        if std::env::var("SNIP_KEEP").is_err() && !f.files.is_empty() {
            super::undo(&f.id).expect("undo");
            println!("undone");
        }
    }
}
