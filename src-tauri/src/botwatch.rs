//! A watch on job-mail's Telegram bot (launchd com.erikkarasek.job-mail-bot). It
//! long-polls Telegram, so while it lives it always holds a connection. Alive but
//! without one for three minutes while Telegram answers us means it's stuck:
//! restart it and say so. A dead bot is launchd's job (KeepAlive), not ours.

use serde_json::json;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const LABEL: &str = "com.erikkarasek.job-mail-bot";
const MISSES: u32 = 3;

fn bot_pid() -> Option<u32> {
    let out = Command::new("/bin/launchctl").args(["list", LABEL]).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("\"PID\""))?;
    line.split('=').nth(1)?.trim().trim_end_matches(';').trim().parse().ok()
}

fn connected(pid: u32) -> bool {
    Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), "-iTCP", "-sTCP:ESTABLISHED"])
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().count() > 1)
        // lsof failing says nothing about the bot.
        .unwrap_or(true)
}

fn telegram_reachable() -> bool {
    let Ok(mut addrs) = ("api.telegram.org", 443).to_socket_addrs() else { return false };
    addrs.any(|a| TcpStream::connect_timeout(&a, Duration::from_secs(4)).is_ok())
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut misses = 0;
        loop {
            std::thread::sleep(Duration::from_secs(60));
            let stuck = bot_pid().is_some_and(|pid| !connected(pid)) && telegram_reachable();
            misses = if stuck { misses + 1 } else { 0 };
            if misses >= MISSES {
                misses = 0;
                let target = format!("gui/{}/{LABEL}", unsafe { libc::getuid() });
                let ok = Command::new("/bin/launchctl").args(["kickstart", "-k", &target]).status().is_ok_and(|s| s.success());
                let text = if ok {
                    "Telegram bot job-mailu 3 minuty nedržel spojení, restartoval jsem ho."
                } else {
                    "Telegram bot job-mailu se zasekl a restart se nepovedl."
                };
                let _ = app.emit_to("main", "notify", json!({ "title": "Wisp", "text": text, "urgent": !ok }));
            }
        }
    });
}
