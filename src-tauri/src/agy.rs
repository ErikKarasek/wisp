//! Every run of the Antigravity CLI (`agy`) goes through here.
//!
//! When agy's Google login runs out, each run prints "Authentication required",
//! opens the Google sign-in page in the browser through macOS `open`, and then
//! waits 60 s for a login nobody is there to give. Wisp reads the limits every
//! two minutes, so that was a sign-in window every two minutes.
//!
//! agy has no flag or setting to keep it from opening the browser, so it gets a
//! PATH whose `open` does nothing, and the run is stopped the moment it asks for
//! a login. The caller gets [`LOGIN_NEEDED`] and can say so instead.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;

/// What every agy call returns when the login has run out. The window checks
/// for this exact text to stop asking, so keep the two in step (`main.ts`).
pub const LOGIN_NEEDED: &str = "Antigravity je odhlášený. Spusť v terminálu agy a přihlas se.";

pub fn bin() -> PathBuf {
    PathBuf::from(format!("{}/.local/bin/agy", std::env::var("HOME").unwrap_or_default()))
}

/// agy's own words when it wants a login. It prints them on stderr; stdout holds
/// the model's answer, which may quote the same words.
fn wants_login(line: &str) -> bool {
    line.contains("Authentication required") || line.contains("authentication timed out")
}

/// A folder whose only file is an `open` that does nothing, put first in PATH.
fn no_browser_dir() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("dispecink-agy-noopen");
    let open = dir.join("open");
    if !open.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&open, "#!/bin/sh\nexit 0\n").ok()?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).ok()?;
    }
    Some(dir)
}

/// `agy`, ready for its arguments and then [`output`].
pub fn command() -> Command {
    without_browser(Command::new(bin()))
}

fn without_browser(mut cmd: Command) -> Command {
    if let Some(dir) = no_browser_dir() {
        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        cmd.env("PATH", format!("{}:{path}", dir.display()));
    }
    cmd
}

/// Like `Command::output`, but a run that asks for a login is stopped at once
/// and comes back as `Err(LOGIN_NEEDED)`.
pub fn output(mut cmd: Command) -> Result<Output, String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel::<()>();
    let reader = |pipe: Box<dyn Read + Send>, tx: mpsc::Sender<()>, watch: bool| {
        thread::spawn(move || {
            let mut all = Vec::new();
            let mut line = Vec::new();
            let mut r = BufReader::new(pipe);
            while matches!(r.read_until(b'\n', &mut line), Ok(n) if n > 0) {
                if watch && wants_login(&String::from_utf8_lossy(&line)) {
                    let _ = tx.send(());
                }
                all.append(&mut line);
            }
            all
        })
    };
    let out = reader(Box::new(child.stdout.take().ok_or("agy bez výstupu")?), tx.clone(), false);
    let err = reader(Box::new(child.stderr.take().ok_or("agy bez výstupu")?), tx, true);
    // Ok: a reader saw the login prompt. Err: both pipes closed, the run is over.
    if rx.recv().is_ok() {
        // SIGTERM lets agy end its wait for the login cleanly ("authentication interrupted").
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        let _ = child.wait();
        return Err(LOGIN_NEEDED.into());
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    Ok(Output { status, stdout, stderr })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_the_login_prompt() {
        assert!(wants_login("Authentication required. Please visit the URL to log in:"));
        assert!(wants_login("Error: authentication timed out."));
        assert!(!wants_login("Gemini Models\tWeekly Limit Remaining\t61%\t2026-11-25T07:15:09Z"));
    }

    /// A stand-in agy that asks for a login and then waits: it has to be stopped
    /// at once, and the `open` it would call must be the one that does nothing.
    #[test]
    fn stops_at_the_login_prompt_without_a_browser() {
        let dir = std::env::temp_dir().join(format!("dispecink-agy-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("agy");
        let which = dir.join("which-open");
        let script = format!(
            "#!/bin/sh\ncommand -v open > {}\necho 'Authentication required. Please visit the URL to log in:' >&2\nsleep 30\n",
            which.display()
        );
        std::fs::write(&fake, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let got = output(without_browser(Command::new(&fake)));
        assert_eq!(got.err().as_deref(), Some(LOGIN_NEEDED));
        assert!(started.elapsed().as_secs() < 10, "the run was not stopped at the prompt");
        let open = std::fs::read_to_string(&which).unwrap();
        assert!(open.trim().ends_with("dispecink-agy-noopen/open"), "agy would call {open}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An answer that quotes the login prompt is an answer, not a login request.
    #[test]
    fn ignores_the_prompt_quoted_in_an_answer() {
        let dir = std::env::temp_dir().join(format!("dispecink-agy-quote-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("agy");
        let script = "#!/bin/sh\necho '{\"response\":\"The error says Authentication required, authentication timed out.\"}'\n";
        std::fs::write(&fake, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let got = output(without_browser(Command::new(&fake))).unwrap();
        assert!(String::from_utf8_lossy(&got.stdout).contains("Authentication required"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real agy with an empty HOME, so it is logged out without touching the
    /// real login: no browser may open, and the answer must come in seconds.
    /// cargo test --lib agy::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_logged_out() {
        let home = std::env::temp_dir().join(format!("dispecink-agy-nohome-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let mut cmd = command();
        cmd.args(["-p", "/usage", "--print-timeout", "60s"]).current_dir(&home).env("HOME", &home);
        let started = std::time::Instant::now();
        let got = output(cmd);
        println!("{:?} after {:?}", got.as_ref().err(), started.elapsed());
        assert_eq!(got.err().as_deref(), Some(LOGIN_NEEDED));
        assert!(started.elapsed().as_secs() < 20);
        let _ = std::fs::remove_dir_all(&home);
    }
}
