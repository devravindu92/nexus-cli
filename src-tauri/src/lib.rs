//! NEXUS desktop core.
mod commands;
mod db;
mod models;
mod platform;
mod pty;

use commands::AppState;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Manager, RunEvent};

/// macOS needs an application menu for standard shortcuts (copy/paste, quit).
/// "Close Window" is deliberately absent so Cmd+W reaches the app and closes
/// the focused pane instead of the whole window.
fn build_macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "NEXUS")
        .item(&PredefinedMenuItem::about(app, Some("About NEXUS"), None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(&data_dir.join("database.sqlite"))?;
            // No local process survives an app exit: be truthful about it.
            db.mark_orphans_recoverable()?;
            app.manage(AppState {
                db: Arc::new(db),
                pty: pty::SessionManager::new(),
            });
            // Resolve the login-shell PATH off the main thread.
            std::thread::spawn(|| {
                platform::effective_path();
            });
            if cfg!(target_os = "macos") {
                let menu = build_macos_menu(app.handle())?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::shells_list,
            commands::agents_list,
            commands::workspace_list,
            commands::workspace_create,
            commands::workspace_update,
            commands::workspace_remove,
            commands::workspace_relink,
            commands::workspace_git_branch,
            commands::session_create,
            commands::session_start,
            commands::session_list,
            commands::session_list_closed,
            commands::session_update,
            commands::session_close,
            commands::session_forget,
            commands::terminal_subscribe,
            commands::terminal_write,
            commands::terminal_resize,
            commands::layout_get,
            commands::layout_save,
            commands::prefs_get,
            commands::pref_set,
            commands::activity_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building NEXUS");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.pty.kill_all();
            }
        }
    });
}
