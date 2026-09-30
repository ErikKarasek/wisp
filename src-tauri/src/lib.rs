mod calendar;
mod cloudflare;
mod github;
mod launchd;
mod media;
mod notch;
mod paperclip;
mod store;
mod telegram;
mod usage;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalPosition, Manager, RunEvent, WindowEvent, Wry};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri_plugin_autostart::MacosLauncher;

const TRAY_ID: &str = "main";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

// ---------- launchd ----------

#[tauri::command]
async fn list_jobs() -> Result<Vec<launchd::Job>, String> {
    blocking(launchd::list).await
}

#[tauri::command]
async fn job_log(label: String, lines: usize) -> Result<String, String> {
    blocking(move || launchd::log(&label, lines)).await?
}

#[tauri::command]
async fn job_action(label: String, action: String) -> Result<(), String> {
    blocking(move || match action.as_str() {
        "run" => launchd::run(&label, false),
        "restart" => launchd::run(&label, true),
        "pause" => launchd::pause(&label),
        "resume" => launchd::resume(&label),
        other => Err(format!("Neznámá akce {other}")),
    })
    .await?
}

#[tauri::command]
async fn job_create(spec: launchd::JobSpec) -> Result<String, String> {
    blocking(move || launchd::create(&spec)).await?
}

#[tauri::command]
async fn job_update(label: String, spec: launchd::JobSpec) -> Result<(), String> {
    blocking(move || launchd::update(&label, &spec)).await?
}

#[tauri::command]
async fn job_delete(label: String) -> Result<(), String> {
    blocking(move || launchd::delete(&label)).await?
}

// ---------- Paperclip ----------

#[tauri::command]
async fn paperclip_snapshot() -> serde_json::Value {
    paperclip::snapshot().await
}

#[tauri::command]
async fn paperclip_request(method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    paperclip::request(&method, &path, body).await
}

#[tauri::command]
async fn paperclip_action(kind: String, id: String) -> Result<(), String> {
    paperclip::action(&kind, &id).await
}

// ---------- Cloudflare ----------

#[tauri::command]
async fn cloudflare_snapshot() -> serde_json::Value {
    let token = blocking(|| store::secret_get("cloudflare")).await.ok().flatten();
    cloudflare::snapshot(token).await
}

// ---------- GitHub ----------

#[tauri::command]
async fn github_snapshot(repos: Vec<String>) -> Result<serde_json::Value, String> {
    blocking(move || github::snapshot(&repos)).await
}

#[tauri::command]
async fn github_discover() -> Result<Vec<String>, String> {
    blocking(github::discover).await?
}

#[tauri::command]
async fn github_action(repo: String, workflow_id: i64, action: String) -> Result<(), String> {
    blocking(move || github::action(&repo, workflow_id, &action)).await?
}

// ---------- settings ----------

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn config_load(app: AppHandle) -> Result<serde_json::Value, String> {
    store::load(config_dir(&app)?)
}

#[tauri::command]
fn config_save(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    store::save(config_dir(&app)?, &value)
}

#[tauri::command]
async fn secret_set(name: String, value: String) -> Result<(), String> {
    blocking(move || store::secret_set(&name, &value)).await?
}

#[tauri::command]
async fn secret_delete(name: String) -> Result<(), String> {
    blocking(move || store::secret_delete(&name)).await?
}

#[tauri::command]
async fn secret_exists(name: String) -> Result<bool, String> {
    blocking(move || store::secret_get(&name).is_some()).await
}

#[tauri::command]
fn history_load(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(store::history_load(config_dir(&app)?))
}

#[tauri::command]
fn history_append(app: AppHandle, entries: Vec<serde_json::Value>) -> Result<(), String> {
    store::history_append(config_dir(&app)?, entries)
}

// ---------- Telegram ----------

async fn telegram_token() -> Result<String, String> {
    blocking(|| store::secret_get("telegram"))
        .await?
        .ok_or_else(|| "Chybí token Telegram bota.".to_string())
}

#[tauri::command]
async fn telegram_send(chat: String, text: String) -> Result<(), String> {
    telegram::send(&telegram_token().await?, &chat, &text).await
}

#[tauri::command]
async fn telegram_bot() -> Result<serde_json::Value, String> {
    telegram::bot_info(&telegram_token().await?).await
}

#[tauri::command]
async fn telegram_chats() -> Result<Vec<serde_json::Value>, String> {
    telegram::recent_chats(&telegram_token().await?).await
}

// ---------- tray ----------

fn tray_menu(app: &AppHandle, lines: &[String]) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for (i, line) in lines.iter().enumerate() {
        menu.append(&MenuItem::with_id(app, format!("line-{i}"), line, false, None::<&str>)?)?;
    }
    if !lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "open", "Otevřít Dispečink", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Ukončit", true, None::<&str>)?)?;
    Ok(menu)
}

/// The page draws the tray face (the mascot wearing the worst state) and sends
/// it here with the lines for the tray menu.
#[tauri::command]
fn set_tray(app: AppHandle, png: Vec<u8>, tooltip: String, lines: Vec<String>, template: bool) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("Ikona v liště chybí")?;
    let icon = Image::from_bytes(&png).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    tray.set_icon_as_template(template).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    let menu = tray_menu(&app, &lines).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Text next to the menu-bar icon: the Claude and ChatGPT limits. Empty hides it.
#[tauri::command]
fn set_tray_title(app: AppHandle, title: String) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("Ikona v liště chybí")?;
    tray.set_title(if title.is_empty() { None } else { Some(title) }).map_err(|e| e.to_string())
}

// ---------- menu-bar panel and notch ----------

/// When the panel last hid itself. Clicking the tray icon while the panel is
/// open first takes its focus (which hides it) and then arrives as a click that
/// would open it straight back; a click right after a hide therefore does nothing.
static PANEL_HIDDEN_AT: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Show or hide the panel, centred under the tray icon and kept on screen.
fn toggle_panel(app: &AppHandle, icon: tauri::Rect) {
    let Some(panel) = app.get_webview_window("panel") else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        PANEL_HIDDEN_AT.store(now_millis(), Ordering::Relaxed);
        return;
    }
    if now_millis().saturating_sub(PANEL_HIDDEN_AT.load(Ordering::Relaxed)) < 250 {
        return;
    }
    let scale = panel.scale_factor().unwrap_or(1.0);
    let pos = icon.position.to_logical::<f64>(scale);
    let size = icon.size.to_logical::<f64>(scale);
    let panel_size = panel
        .outer_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalSize::new(340.0, 440.0));
    let mut x = pos.x + size.width / 2.0 - panel_size.width / 2.0;
    if let Ok(Some(monitor)) = panel.current_monitor() {
        let area = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let origin = monitor.position().to_logical::<f64>(monitor.scale_factor());
        let right = origin.x + area.width - panel_size.width - 8.0;
        x = x.clamp(origin.x + 8.0, right.max(origin.x + 8.0));
    }
    let _ = panel.set_position(LogicalPosition::new(x, pos.y + size.height + 6.0));
    let _ = panel.show();
    let _ = panel.set_focus();
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(p) = app.get_webview_window("panel") {
        let _ = p.hide();
    }
    show_main(&app);
}

// ---------- music and calendar (for the notch) ----------

#[tauri::command]
async fn media_now() -> Result<Option<media::NowPlaying>, String> {
    blocking(media::now_playing).await
}

#[tauri::command]
async fn media_control(app: String, action: String) -> Result<(), String> {
    blocking(move || media::control(&app, &action)).await?
}

#[tauri::command]
fn calendar_status() -> &'static str {
    calendar::status()
}

#[tauri::command]
async fn calendar_request() -> Result<bool, String> {
    blocking(calendar::request).await
}

#[tauri::command]
async fn calendar_events(from_ms: f64, to_ms: f64) -> Result<Vec<calendar::Event>, String> {
    blocking(move || calendar::between(from_ms, to_ms)).await
}

#[tauri::command]
fn notch_set_wing(width: f64) {
    notch::set_wing(width);
}

#[tauri::command]
fn notch_set_close_delay(millis: u64) {
    notch::set_close_delay(millis);
}

#[tauri::command]
async fn claude_usage() -> Result<usage::Usage, String> {
    blocking(usage::claude_usage).await?
}

#[tauri::command]
async fn chatgpt_usage() -> Result<usage::GptUsage, String> {
    usage::chatgpt_usage().await
}

/// The codex binary Paperclip installed for itself, newest version first. The
/// Codex CLI engine needs its full path: it isn't on any PATH.
#[tauri::command]
fn codex_command() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let root = std::path::Path::new(&home).join(".paperclip/cli/installs/npm");
    let mut versions: Vec<_> = std::fs::read_dir(root).ok()?.flatten().map(|e| e.path()).collect();
    // 2026.1001.0 is newer than 2026.916.1, so compare the numbers, not the text.
    versions.sort_by_key(|v| {
        let name = v.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        name.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>()
    });
    versions
        .into_iter()
        .rev()
        .map(|v| v.join("node_modules/.bin/codex"))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn github_prs(repos: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    blocking(move || github::pull_requests(&repos)).await
}

#[tauri::command]
async fn github_pr_diff(repo: String, number: u64) -> Result<String, String> {
    blocking(move || github::pr_diff(&repo, number)).await?
}

#[tauri::command]
async fn github_pr_action(repo: String, number: u64, action: String) -> Result<(), String> {
    blocking(move || github::pr_action(&repo, number, &action)).await?
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn notch_set_enabled(app: AppHandle, enabled: bool) {
    notch::set_enabled(&app, enabled);
}

#[tauri::command]
fn notch_peek(app: AppHandle, millis: u64) {
    notch::peek(&app, millis.min(10_000));
}

#[tauri::command]
fn notch_set_width(app: AppHandle, width: f64) {
    notch::set_width(&app, width);
}

#[tauri::command]
fn notch_geometry() -> notch::Geometry {
    notch::current_geometry()
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // The notch's mirror is the only thing that may use the camera; macOS
        // still asks the user once.
        .on_permission_request(|webview, kind| match kind {
            tauri::webview::PermissionKind::Camera if webview.label() == notch::LABEL => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let handle = app.handle();
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Dispečink")
                .menu(&tray_menu(handle, &[])?)
                // Left click opens the panel; the menu stays on right click.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                        toggle_panel(tray.app_handle(), rect);
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            notch::setup(handle);
            Ok(())
        })
        // Closing the window only hides it; the tray keeps watching.
        .on_window_event(|window, event| match (window.label(), event) {
            // Clicking anywhere else dismisses the panel, the way a menu does.
            ("panel", WindowEvent::Focused(false)) => {
                let _ = window.hide();
                PANEL_HIDDEN_AT.store(now_millis(), Ordering::Relaxed);
            }
            // Closing the main window only hides it; the tray and notch keep watching.
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_jobs,
            job_log,
            job_action,
            job_create,
            job_update,
            job_delete,
            paperclip_snapshot,
            paperclip_action,
            paperclip_request,
            show_main_window,
            quit_app,
            claude_usage,
            codex_command,
            set_tray_title,
            chatgpt_usage,
            github_prs,
            github_pr_diff,
            github_pr_action,
            media_now,
            media_control,
            calendar_status,
            calendar_request,
            calendar_events,
            notch_set_enabled,
            notch_peek,
            notch_geometry,
            notch_set_width,
            notch_set_close_delay,
            notch_set_wing,
            cloudflare_snapshot,
            github_snapshot,
            github_discover,
            github_action,
            config_load,
            config_save,
            secret_set,
            secret_delete,
            secret_exists,
            history_load,
            history_append,
            telegram_send,
            telegram_chats,
            telegram_bot,
            set_tray
        ])
        .build(tauri::generate_context!())
        .expect("Dispečink se nepodařilo spustit");

    app.run(|app, event| {
        // Clicking the Dock icon brings the hidden window back.
        if let RunEvent::Reopen { .. } = event {
            show_main(app);
        }
    });
}
