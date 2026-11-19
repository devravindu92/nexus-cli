//! Typed commands exposed to the webview. This is the *only* route from the
//! UI to process execution: there is no general-purpose shell API.
use crate::db::Db;
use crate::models::*;
use crate::platform;
use crate::pty::{SessionManager, SpawnSpec};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub db: Arc<Db>,
    pub pty: SessionManager,
}

type CmdResult<T> = Result<T, String>;

pub const EVENT_SESSION_CHANGED: &str = "session-changed";
pub const EVENT_ACTIVITY_CHANGED: &str = "activity-changed";

const ACCENTS: &[&str] = &[
    "#8b9cff", "#5eead4", "#f0a35e", "#f472b6", "#a3e635", "#38bdf8", "#c084fc", "#facc15",
];

fn log_activity(
    app: &AppHandle,
    db: &Db,
    kind: &str,
    message: &str,
    workspace_id: Option<&str>,
    session_id: Option<&str>,
) {
    let _ = db.activity_add(kind, message, workspace_id, session_id);
    let _ = app.emit(EVENT_ACTIVITY_CHANGED, ());
}

// ---- app ------------------------------------------------------------------

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        home_dir: platform::home_dir(),
    }
}

#[tauri::command]
pub async fn shells_list() -> Vec<ShellProfile> {
    platform::detect_shells()
}

#[tauri::command]
pub async fn agents_list() -> Vec<AgentProfile> {
    platform::detect_agents()
}

// ---- workspaces -----------------------------------------------------------

#[tauri::command]
pub fn workspace_list(state: State<AppState>) -> CmdResult<Vec<Workspace>> {
    state.db.workspace_list()
}

#[tauri::command]
pub fn workspace_create(
    app: AppHandle,
    state: State<AppState>,
    root_path: String,
    name: Option<String>,
) -> CmdResult<Workspace> {
    let path = Path::new(&root_path);
    if !path.is_dir() {
        return Err(format!("`{root_path}` is not a folder"));
    }
    let existing = state.db.workspace_list()?;
    if let Some(found) = existing.iter().find(|w| w.root_path == root_path) {
        return Ok(found.clone());
    }
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| root_path.clone());
    let now = now_ms();
    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        root_path,
        icon: String::new(),
        accent: ACCENTS[existing.len() % ACCENTS.len()].to_string(),
        description: String::new(),
        pinned: false,
        tags: vec![],
        created_at: now,
        last_opened_at: now,
        path_exists: true,
    };
    state.db.workspace_insert(&ws)?;
    log_activity(
        &app,
        &state.db,
        "workspace.created",
        &format!("Workspace “{}” added", ws.name),
        Some(&ws.id),
        None,
    );
    Ok(ws)
}

#[tauri::command]
pub fn workspace_update(state: State<AppState>, workspace: Workspace) -> CmdResult<Workspace> {
    if workspace.name.trim().is_empty() {
        return Err("workspace name cannot be empty".into());
    }
    state.db.workspace_update(&workspace)?;
    state.db.workspace_get(&workspace.id)
}

/// Removes the workspace from NEXUS only. Project files are never touched.
#[tauri::command]
pub fn workspace_remove(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    let ws = state.db.workspace_get(&id)?;
    for s in state.db.session_list_open()? {
        if s.workspace_id == id {
            state.pty.kill(&s.id);
        }
    }
    state.db.workspace_delete(&id)?;
    log_activity(
        &app,
        &state.db,
        "workspace.removed",
        &format!("Workspace “{}” removed (files untouched)", ws.name),
        None,
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn workspace_git_branch(state: State<AppState>, id: String) -> CmdResult<Option<String>> {
    let ws = state.db.workspace_get(&id)?;
    Ok(platform::git_branch(&ws.root_path))
}

// ---- sessions -------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub workspace_id: String,
    /// "shell" | "agent" | "command"
    pub kind: String,
    pub profile_id: Option<String>,
    pub program: Option<String>,
    pub args: Option<Vec<String>>,
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

fn start_process(
    app: &AppHandle,
    state: &AppState,
    session: &Session,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    let (program, args) = platform::resolve_launch(&session.program, &session.args)?;
    let cwd = if Path::new(&session.cwd).is_dir() {
        session.cwd.clone()
    } else {
        platform::home_dir()
    };
    let spec = SpawnSpec {
        program,
        args,
        cwd,
        env: platform::terminal_env(),
        cols,
        rows,
    };
    let db = state.db.clone();
    let app2 = app.clone();
    let id = session.id.clone();
    let name = session.name.clone();
    let workspace_id = session.workspace_id.clone();
    state.pty.spawn(
        &session.id,
        spec,
        Box::new(move |code| {
            if let Ok(true) = db.session_set_exited(&id, code) {
                let msg = match code {
                    Some(0) | None => format!("“{name}” exited"),
                    Some(c) => format!("“{name}” exited with code {c}"),
                };
                let _ = db.activity_add("session.exited", &msg, Some(&workspace_id), Some(&id));
                let _ = app2.emit(EVENT_ACTIVITY_CHANGED, ());
                if let Ok(s) = db.session_get(&id) {
                    let _ = app2.emit(EVENT_SESSION_CHANGED, s);
                }
            }
        }),
    )
}

#[tauri::command]
pub async fn session_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: NewSession,
) -> CmdResult<Session> {
    let ws = state.db.workspace_get(&input.workspace_id)?;
    let extra_args = input.args.clone().unwrap_or_default();

    let (program, args, default_name, profile_id) = match input.kind.as_str() {
        "shell" => {
            let shells = platform::detect_shells();
            let profile = match &input.profile_id {
                Some(pid) => shells.iter().find(|s| &s.id == pid),
                None => shells.iter().find(|s| s.is_default),
            }
            .ok_or("no matching shell is installed")?
            .clone();
            (profile.program, profile.args, profile.name, Some(profile.id))
        }
        "agent" => {
            let pid = input.profile_id.clone().ok_or("agent profile is required")?;
            let profile = platform::detect_agents()
                .into_iter()
                .find(|a| a.id == pid)
                .ok_or("unknown agent profile")?;
            if !profile.available {
                return Err(format!(
                    "{} is not installed: `{}` was not found on your PATH",
                    profile.name, profile.program
                ));
            }
            let mut args = profile.args.clone();
            args.extend(extra_args);
            (profile.program, args, profile.name, Some(profile.id))
        }
        "command" => {
            let program = input
                .program
                .clone()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .ok_or("a program is required")?;
            let label = Path::new(&program)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| program.clone());
            (program, extra_args, label, None)
        }
        other => return Err(format!("unknown session kind `{other}`")),
    };

    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: ws.id.clone(),
        name: input
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or(default_name),
        kind: input.kind.clone(),
        profile_id,
        program,
        args,
        cwd: input.cwd.unwrap_or_else(|| ws.root_path.clone()),
        accent: None,
        host: "local".into(),
        state: "running".into(),
        exit_code: None,
        restored: false,
        created_at: now_ms(),
        closed_at: None,
    };

    // Start first: a session that cannot launch is never persisted.
    start_process(
        &app,
        &state,
        &session,
        input.cols.unwrap_or(80),
        input.rows.unwrap_or(24),
    )?;
    if let Err(err) = state.db.session_insert(&session) {
        state.pty.kill(&session.id);
        return Err(err);
    }
    log_activity(
        &app,
        &state.db,
        "session.started",
        &format!("“{}” started in {}", session.name, ws.name),
        Some(&ws.id),
        Some(&session.id),
    );
    Ok(session)
}

/// Start a NEW process for an existing session record (closed, exited or
/// recoverable). This is terminal restoration, not process reattachment.
#[tauri::command]
pub async fn session_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> CmdResult<Session> {
    let session = state.db.session_get(&id)?;
    if state.pty.is_live(&id) {
        return Ok(session);
    }
    let restored = session.state != "exited";
    start_process(&app, &state, &session, cols.unwrap_or(80), rows.unwrap_or(24))?;
    state.db.session_set_running(&id, restored)?;
    let session = state.db.session_get(&id)?;
    log_activity(
        &app,
        &state.db,
        "session.restored",
        &format!("“{}” started as a new process", session.name),
        Some(&session.workspace_id),
        Some(&id),
    );
    Ok(session)
}

#[tauri::command]
pub fn session_list(state: State<AppState>) -> CmdResult<Vec<Session>> {
    state.db.session_list_open()
}

#[tauri::command]
pub fn session_list_closed(
    state: State<AppState>,
    search: Option<String>,
) -> CmdResult<Vec<Session>> {
    state
        .db
        .session_list_closed(search.as_deref().unwrap_or(""), 100)
}

#[tauri::command]
pub fn session_update(
    state: State<AppState>,
    id: String,
    name: Option<String>,
    accent: Option<String>,
    clear_accent: Option<bool>,
) -> CmdResult<Session> {
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let accent_change = if clear_accent.unwrap_or(false) {
        Some(None)
    } else {
        accent.as_deref().map(Some)
    };
    state
        .db
        .session_update_meta(&id, name.as_deref(), accent_change)?;
    state.db.session_get(&id)
}

#[tauri::command]
pub fn session_close(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    let session = state.db.session_get(&id)?;
    state.pty.kill(&id);
    state.db.session_set_closed(&id, now_ms())?;
    state.db.prune_closed_sessions(200)?;
    log_activity(
        &app,
        &state.db,
        "session.closed",
        &format!("“{}” closed", session.name),
        Some(&session.workspace_id),
        Some(&id),
    );
    Ok(())
}

#[tauri::command]
pub fn session_forget(state: State<AppState>, id: String) -> CmdResult<()> {
    state.pty.kill(&id);
    state.db.session_delete(&id)
}

// ---- terminal I/O ---------------------------------------------------------

#[tauri::command]
pub fn terminal_subscribe(
    state: State<AppState>,
    id: String,
    on_output: Channel<InvokeResponseBody>,
) -> bool {
    state.pty.subscribe(
        &id,
        Box::new(move |bytes| on_output.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok()),
    )
}

#[tauri::command]
pub fn terminal_write(state: State<AppState>, id: String, data: String) -> CmdResult<()> {
    state.pty.write(&id, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    state.pty.resize(&id, cols, rows)
}

// ---- layout, preferences, activity ---------------------------------------

#[tauri::command]
pub fn layout_get(state: State<AppState>, workspace_id: String) -> CmdResult<Option<String>> {
    state.db.layout_get(&workspace_id)
}

#[tauri::command]
pub fn layout_save(state: State<AppState>, workspace_id: String, data: String) -> CmdResult<()> {
    state.db.layout_save(&workspace_id, &data, now_ms())
}

#[tauri::command]
pub fn prefs_get(state: State<AppState>) -> CmdResult<HashMap<String, String>> {
    state.db.prefs_all()
}

#[tauri::command]
pub fn pref_set(state: State<AppState>, key: String, value: String) -> CmdResult<()> {
    state.db.pref_set(&key, &value)
}

#[tauri::command]
pub fn activity_list(state: State<AppState>, limit: Option<i64>) -> CmdResult<Vec<ActivityEvent>> {
    state.db.activity_list(limit.unwrap_or(50).clamp(1, 500))
}
