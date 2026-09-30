mod launchd;
mod paperclip;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent, Wry};

const TRAY_ID: &str = "main";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

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
async fn paperclip_snapshot() -> serde_json::Value {
    paperclip::snapshot().await
}

#[tauri::command]
async fn paperclip_action(kind: String, id: String) -> Result<(), String> {
    paperclip::action(&kind, &id).await
}

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
fn set_tray(app: AppHandle, png: Vec<u8>, tooltip: String, lines: Vec<String>) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("Ikona v liště chybí")?;
    let icon = Image::from_bytes(&png).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    tray.set_icon_as_template(false).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    let menu = tray_menu(&app, &lines).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle();
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Dispečink")
                .menu(&tray_menu(handle, &[])?)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        // Closing the window only hides it; the tray keeps watching.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_jobs,
            job_log,
            job_action,
            paperclip_snapshot,
            paperclip_action,
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
