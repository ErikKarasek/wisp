//! What is playing in Spotify or Music, and the play / pause / skip buttons.
//! Through AppleScript, the way both apps offer it. A player that isn't
//! running is never started just by asking: `is running` is checked first.
//! macOS asks once for permission to control each player.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub app: String,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork_url: Option<String>,
    pub position: f64,
    pub duration: f64,
}

const PLAYERS: &[&str] = &["Spotify", "Music"];

fn osascript(script: &str) -> Option<String> {
    let out = Command::new("/usr/bin/osascript").args(["-e", script]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn running(app: &str) -> bool {
    osascript(&format!("application \"{app}\" is running")).as_deref() == Some("true")
}

fn read(app: &str) -> Option<NowPlaying> {
    // One line, fields separated by a character that never appears in titles.
    let sep = "\u{1f}";
    let script = if app == "Spotify" {
        format!(
            r#"tell application "Spotify"
  if player state is stopped then return "stopped"
  set t to current track
  return (player state as text) & "{sep}" & (name of t) & "{sep}" & (artist of t) & "{sep}" & (album of t) & "{sep}" & (artwork url of t) & "{sep}" & (player position as text) & "{sep}" & ((duration of t) / 1000 as text)
end tell"#
        )
    } else {
        format!(
            r#"tell application "Music"
  if player state is stopped then return "stopped"
  set t to current track
  return (player state as text) & "{sep}" & (name of t) & "{sep}" & (artist of t) & "{sep}" & (album of t) & "{sep}" & "" & "{sep}" & (player position as text) & "{sep}" & (duration of t as text)
end tell"#
        )
    };
    let out = osascript(&script)?;
    if out == "stopped" {
        return None;
    }
    let f: Vec<&str> = out.split(sep).collect();
    if f.len() < 7 {
        return None;
    }
    let num = |s: &str| s.replace(',', ".").parse::<f64>().unwrap_or(0.0);
    Some(NowPlaying {
        app: app.to_string(),
        playing: f[0] == "playing",
        title: f[1].to_string(),
        artist: f[2].to_string(),
        album: f[3].to_string(),
        artwork_url: Some(f[4].to_string()).filter(|u| u.starts_with("https://")),
        position: num(f[5]),
        duration: num(f[6]),
    })
}

/// The player that is playing, or else the one that is paused on a track.
pub fn now_playing() -> Option<NowPlaying> {
    let found: Vec<NowPlaying> = PLAYERS.iter().filter(|a| running(a)).filter_map(|a| read(a)).collect();
    let mut found = found.into_iter();
    let first = found.next()?;
    if first.playing {
        return Some(first);
    }
    Some(found.find(|n| n.playing).unwrap_or(first))
}

pub fn control(app: &str, action: &str) -> Result<(), String> {
    if !PLAYERS.contains(&app) {
        return Err("Neznámý přehrávač".into());
    }
    let verb = match action {
        "playpause" => "playpause",
        "next" => "next track",
        "previous" => "previous track",
        _ => return Err("Neznámá akce".into()),
    };
    osascript(&format!("tell application \"{app}\" to {verb}")).map(|_| ()).ok_or_else(|| "Přehrávač neodpověděl".into())
}

