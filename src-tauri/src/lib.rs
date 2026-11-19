//! NEXUS desktop core.
mod agent;
mod commands;
mod db;
mod models;
mod platform;
mod project;
mod pty;
mod remote;
mod usage;

use commands::AppState;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent};

/// `nexus agent-hook <adapter>`: see [`agent::run_hook`].
pub fn run_agent_hook(adapter_id: &str) {
    agent::run_hook(adapter_id);
}

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

/// Desktop notification when an agent starts needing the user (FR-067), but
/// only while NEXUS is not the focused window: otherwise the state label in
/// the app already says it. Each kind can be turned off in Settings.
fn notify_attention(
    handle: &tauri::AppHandle,
    db: &db::Db,
    session_id: &str,
    state: Option<agent::AgentState>,
) {
    use tauri_plugin_notification::NotificationExt;
    let (pref, what) = match state {
        Some(agent::AgentState::Permission) => ("notifyPermission", "needs your permission"),
        Some(agent::AgentState::Completed) => ("notifyCompleted", "finished its turn"),
        _ => return,
    };
    let focused = handle
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    let prefs = db.prefs_all().unwrap_or_default();
    if prefs.get(pref).map(|v| v == "off").unwrap_or(false) {
        return;
    }
    let Ok(session) = db.session_get(session_id) else {
        return;
    };
    let workspace = db
        .workspace_get(&session.workspace_id)
        .map(|w| w.name)
        .unwrap_or_default();
    let _ = handle
        .notification()
        .builder()
        .title(format!("{} {what}", session.name))
        .body(format!("In {workspace}"))
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(&data_dir.join("database.sqlite"))?;
            // No local process survives an app exit: be truthful about it.
            db.mark_orphans_recoverable()?;
            let db = Arc::new(db);
            let agents = agent::AgentMonitor::new(data_dir.join("agent-events"));
            {
                // Agent signals -> database (conversation ID) and UI (state).
                let db = db.clone();
                let monitor = agents.clone();
                let handle = app.handle().clone();
                agents.start(Box::new(move |id, signal, state_changed| {
                    let mut changed = state_changed;
                    if let Some(agent_session_id) = &signal.agent_session_id {
                        changed |= db
                            .session_set_agent_session(id, agent_session_id)
                            .unwrap_or(false);
                    }
                    if signal.resumable {
                        changed |= db.session_set_agent_resumable(id).unwrap_or(false);
                    }
                    if state_changed {
                        notify_attention(&handle, &db, id, signal.state);
                    }
                    if changed {
                        if let Ok(session) = db.session_get(id) {
                            let _ = handle.emit(
                                commands::EVENT_SESSION_CHANGED,
                                commands::decorate(&monitor, session),
                            );
                        }
                    }
                }));
            }
            app.manage(AppState {
                db,
                pty: pty::SessionManager::new(),
                agents,
                usage: Default::default(),
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
            commands::custom_agent_save,
            commands::custom_agent_remove,
            commands::host_list,
            commands::host_save,
            commands::host_remove,
            commands::host_test,
            commands::host_metrics,
            commands::host_tmux_sessions,
            commands::host_disclosure,
            commands::project_config_get,
            commands::project_config_start,
            commands::project_config_untrust,
            commands::settings_export,
            commands::settings_import,
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
            commands::usage_snapshot,
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
