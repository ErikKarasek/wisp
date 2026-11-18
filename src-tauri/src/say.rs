//! Wisp says the crew's status out loud (issue #25). macOS's own `say` with a Czech system
//! voice: free, offline, and the same voices AVSpeechSynthesizer uses.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// What is being said right now, so a second request cuts it off instead of talking over it.
static SPEAKING: Mutex<Option<Child>> = Mutex::new(None);

/// The first Czech voice `say -v ?` lists ("Zuzana  cs_CZ  # Ahoj! Já jsem Zuzana.").
fn czech_voice() -> Option<String> {
    let out = Command::new("/usr/bin/say").args(["-v", "?"]).output().ok()?;
    pick_czech(&String::from_utf8_lossy(&out.stdout))
}

fn pick_czech(list: &str) -> Option<String> {
    list.lines().find_map(|line| {
        let (head, _) = line.split_once('#').unwrap_or((line, ""));
        let mut words: Vec<&str> = head.split_whitespace().collect();
        if words.pop()? != "cs_CZ" || words.is_empty() {
            return None;
        }
        Some(words.join(" "))
    })
}

/// `say` runs `[[slnc 500]]`-style embedded commands found in its input, and agent names come
/// from Paperclip, so brackets and braces are dropped before anything is spoken.
fn plain_speech(text: &str) -> String {
    text.chars().map(|c| if matches!(c, '[' | ']' | '{' | '}') { ' ' } else { c }).collect()
}

pub fn speak(text: &str) -> Result<(), String> {
    let voice = czech_voice().ok_or("Na Macu chybí český hlas. Přidej ho v Nastavení → Přístupnost → Mluvený obsah.")?;
    let mut now = SPEAKING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut old) = now.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let child = Command::new("/usr/bin/say")
        .args(["-v", &voice, "--", &plain_speech(text)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    *now = Some(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{pick_czech, plain_speech};

    #[test]
    fn drops_embedded_speech_commands() {
        assert!(!plain_speech("Agent [[slnc 5000]] selhal").contains("[["));
        assert!(!plain_speech("[[[volm 0.0]]] {x}").contains(['[', ']', '{', '}']));
        assert_eq!(plain_speech("Dispečer selhal"), "Dispečer selhal");
    }

    #[test]
    fn finds_the_czech_voice() {
        let list = "Alex                en_US    # Most people recognize me by my voice.\n\
                    Eddy (Czech (Czechia)) cs_CZ # Ahoj! Já jsem Eddy.\n\
                    Zuzana              cs_CZ    # Ahoj! Já jsem Zuzana.\n";
        assert_eq!(pick_czech(list).as_deref(), Some("Eddy (Czech (Czechia))"));
        assert_eq!(pick_czech("Alex  en_US  # Hi\n"), None);
    }
}
