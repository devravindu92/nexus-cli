//! Typed commands exposed to the webview. This is the *only* route from the
//! UI to process execution: there is no general-purpose shell API.
use crate::agent::{self, AgentMonitor, LaunchContext};
use crate::db::Db;
use crate::models::*;
use crate::platform;
use crate::project::{self, ProjectConfigStatus};
use crate::remote::{self, HostMetrics, HostTest, RemoteHost, RemoteLaunch, Tmux};
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
    pub agents: AgentMonitor,
    pub usage: std::sync::Mutex<crate::usage::UsageSampler>,
}

/// Add the runtime-only agent fields to a session read from the database.
pub fn decorate(agents: &AgentMonitor, mut session: Session) -> Session {
    if session.state == "running" {
        if let Some(rt) = agents.runtime(&session.id) {
            session.agent_state = rt.state.map(|s| s.as_str().to_string());
            session.agent_resumed = rt.resumed;
        }
    }
    session
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
        agent_adapter_api: agent::ADAPTER_API_VERSION,
    }
}

#[tauri::command]
pub async fn shells_list() -> Vec<ShellProfile> {
    platform::detect_shells()
}

#[tauri::command]
pub async fn agents_list(state: State<'_, AppState>) -> CmdResult<Vec<AgentProfile>> {
    all_agents(&state.db)
}

/// Built-in adapters plus the user's own launch profiles (FR-068). Custom
/// profiles have no adapter, so they launch only and report no state.
fn all_agents(db: &Db) -> CmdResult<Vec<AgentProfile>> {
    let mut agents = platform::detect_agents();
    for (id, name, program, args) in db.custom_agents()? {
        let resolved = platform::which(&program);
        agents.push(AgentProfile {
            id,
            name,
            program,
            args,
            available: resolved.is_some(),
            resolved_path: resolved.map(|p| p.to_string_lossy().into_owned()),
            can_resume: false,
            reports_state: false,
            custom: true,
        });
    }
    Ok(agents)
}

#[tauri::command]
pub fn custom_agent_save(
    state: State<AppState>,
    id: Option<String>,
    name: String,
    program: String,
    args: Vec<String>,
) -> CmdResult<Vec<AgentProfile>> {
    let name = name.trim();
    let program = program.trim();
    if name.is_empty() || program.is_empty() {
        return Err("A custom agent needs a name and a program.".into());
    }
    let id = match id {
        Some(id) if id.starts_with("custom:") => id,
        Some(_) => return Err("Built-in agent profiles cannot be edited.".into()),
        None => format!("custom:{}", uuid::Uuid::new_v4()),
    };
    state.db.custom_agent_save(&id, name, program, &args)?;
    all_agents(&state.db)
}

#[tauri::command]
pub fn custom_agent_remove(state: State<AppState>, id: String) -> CmdResult<Vec<AgentProfile>> {
    state.db.custom_agent_delete(&id)?;
    all_agents(&state.db)
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
            state.agents.untrack(&s.id);
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

/// Point a workspace whose folder moved at its new location (FR-017).
#[tauri::command]
pub fn workspace_relink(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    root_path: String,
) -> CmdResult<Workspace> {
    if !Path::new(&root_path).is_dir() {
        return Err(format!("`{root_path}` is not a folder"));
    }
    let ws = state.db.workspace_get(&id)?;
    if ws.root_path == root_path {
        return Ok(ws);
    }
    if let Some(other) = state
        .db
        .workspace_list()?
        .iter()
        .find(|w| w.id != id && w.root_path == root_path)
    {
        return Err(format!(
            "That folder is already the workspace “{}”",
            other.name
        ));
    }
    state.db.workspace_relink(&id, &ws.root_path, &root_path)?;
    log_activity(
        &app,
        &state.db,
        "workspace.relinked",
        &format!("Workspace “{}” now points to {}", ws.name, root_path),
        Some(&id),
        None,
    );
    state.db.workspace_get(&id)
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
    /// A registered remote machine; absent = this computer.
    pub host_id: Option<String>,
    /// "tmux" for a durable remote session.
    pub persistence: Option<String>,
}

/// Spawn the process for `session`. For agents the adapter adds its own
/// arguments (conversation ID, hooks); `resume` asks it to continue the saved
/// conversation instead of starting a new one. Returns the agent's native
/// conversation ID when the adapter fixed it up front.
fn start_process(
    app: &AppHandle,
    state: &AppState,
    session: &Session,
    cols: u16,
    rows: u16,
    resume: bool,
) -> CmdResult<Option<String>> {
    if session.host != "local" {
        return start_remote_process(app, state, session, cols, rows, resume).map(|_| None);
    }
    let mut args = session.args.clone();
    let mut env = platform::terminal_env();
    let mut agent_session_id = None;
    let adapter = (session.kind == "agent")
        .then(|| session.profile_id.as_deref().and_then(agent::adapter))
        .flatten();
    if let Some(adapter) = adapter {
        let caps = adapter.capabilities();
        let resume_id = (resume && caps.resume && session.agent_resumable)
            .then_some(session.agent_session_id.as_deref())
            .flatten();
        let hook = caps
            .state
            .then(|| std::env::current_exe().ok())
            .flatten()
            .map(|exe| agent::hook_command(&exe, adapter.id()));
        let plan = adapter.plan(&LaunchContext {
            user_args: &session.args,
            resume: resume_id,
            hook_command: hook.as_deref(),
        });
        let events = state.agents.track(&session.id, adapter, plan.resumes);
        env.push((
            agent::EVENTS_ENV.to_string(),
            events.to_string_lossy().into_owned(),
        ));
        args.extend(plan.args);
        agent_session_id = plan.agent_session_id;
    }
    let untrack_on_error = |err: String| {
        state.agents.untrack(&session.id);
        err
    };
    let (program, args) =
        platform::resolve_launch(&session.program, &args).map_err(untrack_on_error)?;
    let cwd = if Path::new(&session.cwd).is_dir() {
        session.cwd.clone()
    } else {
        platform::home_dir()
    };
    let spec = SpawnSpec {
        program,
        args,
        cwd,
        env,
        env_remove: platform::terminal_env_remove(),
        cols,
        rows,
    };
    let db = state.db.clone();
    let agents = state.agents.clone();
    let app2 = app.clone();
    let id = session.id.clone();
    let name = session.name.clone();
    let workspace_id = session.workspace_id.clone();
    state
        .pty
        .spawn(
            &session.id,
            spec,
            Box::new(move |code| {
                agents.untrack(&id);
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
        .map_err(untrack_on_error)?;
    Ok(agent_session_id)
}

/// Run the session on a remote machine through the system `ssh` client.
/// With tmux persistence and `reattach`, only an existing remote session is
/// attached; nothing new is started if it is gone.
fn start_remote_process(
    app: &AppHandle,
    state: &AppState,
    session: &Session,
    cols: u16,
    rows: u16,
    reattach: bool,
) -> CmdResult<()> {
    let host = state.db.host_get(&session.host)?;
    if host.disabled {
        return Err(format!("“{}” is disabled. Enable it in the machine's settings first.", host.name));
    }
    host.validate()?;
    let ssh = platform::which("ssh")
        .ok_or("The OpenSSH client (`ssh`) was not found on this computer.")?;
    let tmux = (session.persistence == "tmux").then(|| {
        (
            remote::tmux_name(&session.id),
            if reattach { Tmux::AttachOnly } else { Tmux::CreateOrAttach },
        )
    });
    let args = remote::interactive_args(
        &host,
        &RemoteLaunch {
            program: &session.program,
            args: &session.args,
            cwd: &session.cwd,
            tmux,
        },
    );
    let spec = SpawnSpec {
        program: ssh.to_string_lossy().into_owned(),
        args,
        cwd: platform::home_dir(),
        env: platform::terminal_env(),
        env_remove: platform::terminal_env_remove(),
        cols,
        rows,
    };
    let db = state.db.clone();
    let app2 = app.clone();
    let id = session.id.clone();
    let name = session.name.clone();
    let workspace_id = session.workspace_id.clone();
    let host_name = host.name.clone();
    let durable = session.persistence == "tmux";
    state.pty.spawn(
        &session.id,
        spec,
        Box::new(move |code| {
            if let Ok(true) = db.session_set_exited(&id, code) {
                // ssh itself exits with 255 when the connection fails or drops.
                let msg = match code {
                    Some(255) if durable => format!(
                        "“{name}” lost its connection to {host_name}; the tmux session may still be running there"
                    ),
                    Some(255) => format!("“{name}” lost its connection to {host_name}"),
                    Some(0) | None => format!("“{name}” on {host_name} ended"),
                    Some(c) => format!("“{name}” on {host_name} ended with code {c}"),
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
    let host = match input.host_id.as_deref().filter(|h| *h != "local") {
        Some(id) => Some(state.db.host_get(id)?),
        None => None,
    };
    let persistence = match (input.persistence.as_deref(), &host) {
        (Some("tmux"), Some(_)) => "tmux".to_string(),
        (Some("tmux"), None) => {
            return Err("Durable sessions need a remote machine with tmux. Local terminals end when NEXUS quits.".into())
        }
        _ => String::new(),
    };

    let (program, args, default_name, profile_id) = match input.kind.as_str() {
        // On a remote machine the login shell is whatever that machine gives
        // the user; local shell profiles do not apply.
        "shell" if host.is_some() => (String::new(), vec![], "Shell".to_string(), None),
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
            let profile = all_agents(&state.db)?
                .into_iter()
                .find(|a| a.id == pid)
                .ok_or("unknown agent profile")?;
            // Remote: the CLI has to exist on that machine, which is only
            // known once it runs there.
            if !profile.available && host.is_none() {
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
            .unwrap_or_else(|| match &host {
                Some(h) => format!("{default_name} · {}", h.name),
                None => default_name,
            }),
        kind: input.kind.clone(),
        profile_id,
        program,
        args,
        cwd: match &host {
            // A remote folder; empty means the login directory.
            Some(_) => input.cwd.map(|c| c.trim().to_string()).unwrap_or_default(),
            None => input.cwd.unwrap_or_else(|| ws.root_path.clone()),
        },
        accent: None,
        host: host.as_ref().map(|h| h.id.clone()).unwrap_or_else(|| "local".into()),
        state: "running".into(),
        exit_code: None,
        restored: false,
        created_at: now_ms(),
        closed_at: None,
        font_size: None,
        agent_session_id: None,
        agent_resumable: false,
        persistence,
        agent_state: None,
        agent_resumed: false,
    };

    // The row exists before the process starts, so an immediate exit is
    // recorded against it. A session that cannot launch is removed again.
    state.db.session_insert(&session)?;
    match start_process(
        &app,
        &state,
        &session,
        input.cols.unwrap_or(80),
        input.rows.unwrap_or(24),
        false,
    ) {
        Ok(agent_session_id) => {
            if let Some(agent_session_id) = &agent_session_id {
                state.db.session_set_agent_session(&session.id, agent_session_id)?;
            }
        }
        Err(err) => {
            let _ = state.db.session_delete(&session.id);
            return Err(err);
        }
    }
    // Re-read: the process may already have ended.
    let session = state.db.session_get(&session.id)?;
    log_activity(
        &app,
        &state.db,
        "session.started",
        &match &host {
            Some(h) => format!("“{}” started on {} for {}", session.name, h.name, ws.name),
            None => format!("“{}” started in {}", session.name, ws.name),
        },
        Some(&ws.id),
        Some(&session.id),
    );
    Ok(decorate(&state.agents, session))
}

/// Start a NEW process for an existing session record (closed, exited or
/// recoverable). This is terminal restoration, not process reattachment.
///
/// With `resume`, an agent whose adapter supports it is asked to continue its
/// saved conversation (agent continuation). That is still a new process.
#[tauri::command]
pub async fn session_start(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    resume: Option<bool>,
) -> CmdResult<Session> {
    let session = state.db.session_get(&id)?;
    if state.pty.is_live(&id) {
        return Ok(decorate(&state.agents, session));
    }
    // Reattaching to a tmux session is the one case where the same process
    // comes back, so it is not labelled as "restored as a new process".
    let reattach = session.persistence == "tmux" && resume.unwrap_or(false);
    let restored = session.state != "exited" && !reattach;
    let agent_session_id = start_process(
        &app,
        &state,
        &session,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        resume.unwrap_or(false),
    )?;
    if let Some(agent_session_id) = &agent_session_id {
        // A fresh conversation replaces the saved ID; resuming keeps it.
        state.db.session_set_agent_session(&id, agent_session_id)?;
    }
    state.db.session_set_running(&id, restored)?;
    let session = decorate(&state.agents, state.db.session_get(&id)?);
    let message = if reattach {
        format!("“{}” reattached to its remote tmux session", session.name)
    } else if session.agent_resumed {
        format!("“{}” started as a new process, continuing its conversation", session.name)
    } else {
        format!("“{}” started as a new process", session.name)
    };
    log_activity(
        &app,
        &state.db,
        "session.restored",
        &message,
        Some(&session.workspace_id),
        Some(&id),
    );
    Ok(session)
}

#[tauri::command]
pub fn session_list(state: State<AppState>) -> CmdResult<Vec<Session>> {
    Ok(state
        .db
        .session_list_open()?
        .into_iter()
        .map(|s| decorate(&state.agents, s))
        .collect())
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
    font_size: Option<u16>,
    clear_font_size: Option<bool>,
) -> CmdResult<Session> {
    let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    let accent_change = if clear_accent.unwrap_or(false) {
        Some(None)
    } else {
        accent.as_deref().map(Some)
    };
    let font_change = if clear_font_size.unwrap_or(false) {
        Some(None)
    } else {
        font_size.map(|px| Some(px.clamp(9, 28)))
    };
    state
        .db
        .session_update_meta(&id, name.as_deref(), accent_change, font_change)?;
    Ok(decorate(&state.agents, state.db.session_get(&id)?))
}

#[tauri::command]
pub fn session_close(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    end_remote: Option<bool>,
) -> CmdResult<()> {
    let session = state.db.session_get(&id)?;
    state.pty.kill(&id);
    state.agents.untrack(&id);
    // Closing a durable session only detaches by default: the work on the
    // host keeps running. Ending it is a separate, explicit choice.
    if session.persistence == "tmux" && end_remote.unwrap_or(false) {
        if let Ok(host) = state.db.host_get(&session.host) {
            let name = remote::tmux_name(&id);
            std::thread::spawn(move || {
                let _ = remote::kill_tmux(&host, &name);
            });
        }
    }
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
    state.agents.untrack(&id);
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

/// Memory and CPU of every running session's process tree, and of NEXUS
/// itself. Sampled on request only.
#[tauri::command]
pub async fn usage_snapshot(state: State<'_, AppState>) -> CmdResult<crate::usage::UsageSnapshot> {
    let sessions = state.pty.process_ids();
    let mut sampler = state.usage.lock().unwrap_or_else(|p| p.into_inner());
    Ok(sampler.snapshot(&sessions))
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

// ---- remote machines --------------------------------------------------------

#[tauri::command]
pub fn host_list(state: State<AppState>) -> CmdResult<Vec<RemoteHost>> {
    state.db.host_list()
}

/// Create (no `id`) or edit a remote machine profile. Nothing is contacted.
#[tauri::command]
pub fn host_save(app: AppHandle, state: State<AppState>, mut host: RemoteHost) -> CmdResult<RemoteHost> {
    let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    host.name = host.name.trim().to_string();
    host.target = host.target.trim().to_string();
    host.environment = host.environment.trim().to_string();
    host.user = clean(host.user);
    host.identity_file = clean(host.identity_file);
    host.proxy_jump = clean(host.proxy_jump);
    host.validate()?;
    let is_new = host.id.is_empty();
    if is_new {
        host.id = uuid::Uuid::new_v4().to_string();
        host.created_at = now_ms();
    }
    state.db.host_save(&host)?;
    if is_new {
        log_activity(
            &app,
            &state.db,
            "host.added",
            &format!("Remote machine “{}” registered", host.name),
            None,
            None,
        );
    }
    state.db.host_get(&host.id)
}

/// Forget the profile. Nothing on the machine is touched; sessions that used
/// it are closed locally (durable ones keep running on the host).
#[tauri::command]
pub fn host_remove(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<Vec<String>> {
    let host = state.db.host_get(&id)?;
    let mut closed = Vec::new();
    for s in state.db.session_list_open()? {
        if s.host == id {
            state.pty.kill(&s.id);
            state.db.session_delete(&s.id)?;
            closed.push(s.id);
        }
    }
    state.db.host_delete(&id)?;
    log_activity(
        &app,
        &state.db,
        "host.removed",
        &format!("Remote machine “{}” removed (nothing on it was changed)", host.name),
        None,
        None,
    );
    Ok(closed)
}

/// Non-interactive connection test. Works on an unsaved profile too.
#[tauri::command]
pub async fn host_test(state: State<'_, AppState>, host: RemoteHost) -> CmdResult<HostTest> {
    host.validate()?;
    let result = remote::test(&host);
    if !host.id.is_empty() && state.db.host_get(&host.id).is_ok() {
        let ok = result.status == remote::ProbeStatus::Ok;
        state.db.host_set_checked(
            &host.id,
            now_ms(),
            ok,
            (!ok).then_some(result.message.as_str()),
            result.has_tmux,
        )?;
    }
    Ok(result)
}

/// One bounded, read-only metrics check. Called by the UI on the host's own
/// interval while the dashboard is visible; nothing polls in the background.
#[tauri::command]
pub async fn host_metrics(state: State<'_, AppState>, id: String) -> CmdResult<HostMetrics> {
    let host = state.db.host_get(&id)?;
    if host.disabled || !host.metrics_enabled {
        return Err("Metrics are turned off for this machine.".into());
    }
    let metrics = remote::metrics(&host, now_ms());
    let ok = metrics.status == Some(remote::ProbeStatus::Ok);
    state
        .db
        .host_set_checked(&id, metrics.collected_at, ok, metrics.error.as_deref(), None)?;
    Ok(metrics)
}

/// NEXUS-created tmux sessions that exist on the machine right now.
#[tauri::command]
pub async fn host_tmux_sessions(state: State<'_, AppState>, id: String) -> CmdResult<Vec<String>> {
    remote::list_tmux(&state.db.host_get(&id)?)
}

/// The exact commands NEXUS runs on a machine in the background, so the UI
/// can disclose them.
#[tauri::command]
pub fn host_disclosure() -> HashMap<String, String> {
    HashMap::from([
        ("test".to_string(), remote::TEST_SCRIPT.to_string()),
        ("metrics".to_string(), remote::METRICS_SCRIPT.to_string()),
    ])
}

// ---- project configuration and trust ---------------------------------------

#[tauri::command]
pub fn project_config_get(state: State<AppState>, workspace_id: String) -> CmdResult<ProjectConfigStatus> {
    let ws = state.db.workspace_get(&workspace_id)?;
    let trusted = state.db.project_trust_get(&workspace_id)?;
    Ok(project::status(&ws.root_path, trusted.as_deref()))
}

/// Start the sessions the project config defines.
///
/// `approved` must be the config exactly as the user reviewed it. If the file
/// on disk differs by then, nothing runs. Passing `approved` records the
/// trust decision; passing none requires an earlier decision for this exact
/// content.
#[tauri::command]
pub async fn project_config_start(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
    approved: Option<project::ProjectConfig>,
) -> CmdResult<Vec<Session>> {
    let ws = state.db.workspace_get(&workspace_id)?;
    let raw = project::read_raw(&ws.root_path)?.ok_or("This project has no .nexus/workspace.json.")?;
    let config = project::parse(&raw)?;
    match approved {
        Some(reviewed) => {
            if reviewed != config {
                return Err("The project config changed while you were reviewing it. Review it again.".into());
            }
            state.db.project_trust_set(&workspace_id, &raw)?;
            log_activity(
                &app,
                &state.db,
                "project.trusted",
                &format!("Startup sessions of “{}” reviewed and trusted", ws.name),
                Some(&workspace_id),
                None,
            );
        }
        None => {
            if state.db.project_trust_get(&workspace_id)?.as_deref() != Some(raw.as_str()) {
                return Err("The project config has not been reviewed, or changed since. Review it first.".into());
            }
        }
    }
    let mut started = Vec::new();
    let mut errors = Vec::new();
    for s in &config.sessions {
        let cwd = match &s.cwd {
            Some(rel) => Path::new(&ws.root_path).join(rel).to_string_lossy().into_owned(),
            None => ws.root_path.clone(),
        };
        let input = NewSession {
            workspace_id: workspace_id.clone(),
            kind: s.kind.clone(),
            profile_id: s.agent.clone(),
            program: s.command.first().cloned(),
            args: Some(if s.kind == "command" { s.command[1..].to_vec() } else { s.args.clone() }),
            name: Some(s.name.clone()),
            cwd: Some(cwd),
            cols: None,
            rows: None,
            host_id: None,
            persistence: None,
        };
        match session_create(app.clone(), state.clone(), input).await {
            Ok(session) => started.push(session),
            Err(err) => errors.push(format!("{}: {err}", s.name)),
        }
    }
    if started.is_empty() && !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    for err in errors {
        log_activity(&app, &state.db, "project.error", &err, Some(&workspace_id), None);
    }
    Ok(started)
}

#[tauri::command]
pub fn project_config_untrust(state: State<AppState>, workspace_id: String) -> CmdResult<()> {
    state.db.project_trust_clear(&workspace_id)
}

// ---- settings export / import ----------------------------------------------

/// Portable settings: preferences, custom agents and remote machine profiles.
/// There are no credentials to leave out: NEXUS stores none.
#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    nexus_settings_version: u32,
    #[serde(default)]
    preferences: HashMap<String, String>,
    #[serde(default)]
    custom_agents: Vec<ExportedAgent>,
    #[serde(default)]
    remote_hosts: Vec<RemoteHost>,
}

#[derive(serde::Serialize, Deserialize)]
struct ExportedAgent {
    name: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

/// Preferences that describe this computer rather than the user's taste.
const LOCAL_ONLY_PREFS: &[&str] = &["lastView"];

fn is_local_only_pref(key: &str) -> bool {
    // "remoteDir:<workspace>:<host>" refers to IDs of this installation.
    LOCAL_ONLY_PREFS.contains(&key) || key.starts_with("remoteDir:")
}

fn export_settings(db: &Db) -> CmdResult<SettingsFile> {
    let mut preferences = db.prefs_all()?;
    preferences.retain(|k, _| !is_local_only_pref(k));
    Ok(SettingsFile {
        nexus_settings_version: 1,
        preferences,
        custom_agents: db
            .custom_agents()?
            .into_iter()
            .map(|(_, name, program, args)| ExportedAgent { name, program, args })
            .collect(),
        remote_hosts: db
            .host_list()?
            .into_iter()
            .map(|mut h| {
                h.last_connected_at = None;
                h.last_checked_at = None;
                h.last_error = None;
                h.has_tmux = None;
                h
            })
            .collect(),
    })
}

/// Merge: nothing existing is overwritten or removed, duplicates are skipped.
fn import_settings(db: &Db, file: SettingsFile) -> CmdResult<String> {
    if file.nexus_settings_version != 1 {
        return Err(format!(
            "Settings file version {} is not supported by this build.",
            file.nexus_settings_version
        ));
    }
    for host in &file.remote_hosts {
        host.validate().map_err(|e| format!("Machine “{}”: {e}", host.name))?;
    }
    let mut prefs = 0;
    for (key, value) in &file.preferences {
        if !is_local_only_pref(key) && key.len() <= 64 && value.len() <= 4096 {
            db.pref_set(key, value)?;
            prefs += 1;
        }
    }
    let existing_agents = db.custom_agents()?;
    let mut agents = 0;
    for a in &file.custom_agents {
        if a.name.trim().is_empty() || a.program.trim().is_empty() {
            continue;
        }
        if existing_agents.iter().any(|(_, n, p, ar)| n == &a.name && p == &a.program && ar == &a.args) {
            continue;
        }
        let id = format!("custom:{}", uuid::Uuid::new_v4());
        db.custom_agent_save(&id, a.name.trim(), a.program.trim(), &a.args)?;
        agents += 1;
    }
    let existing_hosts = db.host_list()?;
    let mut hosts = 0;
    for mut h in file.remote_hosts {
        if existing_hosts
            .iter()
            .any(|e| e.target == h.target && e.user == h.user && e.port == h.port)
        {
            continue;
        }
        h.id = uuid::Uuid::new_v4().to_string();
        h.created_at = now_ms();
        db.host_save(&h)?;
        hosts += 1;
    }
    Ok(format!(
        "Imported {prefs} preferences, {agents} custom agents and {hosts} remote machines."
    ))
}

#[tauri::command]
pub fn settings_export(state: State<AppState>, path: String) -> CmdResult<()> {
    let json = serde_json::to_string_pretty(&export_settings(&state.db)?).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Merge a settings file into this installation. Returns a short summary.
#[tauri::command]
pub fn settings_import(state: State<AppState>, path: String) -> CmdResult<String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let file: SettingsFile =
        serde_json::from_str(&raw).map_err(|e| format!("Not a NEXUS settings file: {e}"))?;
    import_settings(&state.db, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(target: &str) -> RemoteHost {
        RemoteHost {
            id: String::new(),
            name: "DEV".into(),
            environment: "dev".into(),
            target: target.into(),
            port: None,
            user: Some("me".into()),
            identity_file: Some("~/.ssh/id_ed25519".into()),
            proxy_jump: None,
            agent_forwarding: false,
            tags: vec!["x".into()],
            disabled: false,
            metrics_enabled: true,
            metrics_interval_secs: 60,
            has_tmux: Some(true),
            created_at: 1,
            last_connected_at: Some(5),
            last_checked_at: Some(5),
            last_error: Some("boom".into()),
        }
    }

    #[test]
    fn settings_round_trip_merges_without_duplicates() {
        let a = Db::open_in_memory().unwrap();
        a.pref_set("theme", "light").unwrap();
        a.pref_set("lastView", "w1").unwrap();
        a.pref_set("remoteDir:w1:h1", "~/app").unwrap();
        a.custom_agent_save("custom:1", "Mine", "my-agent", &["--fast".to_string()]).unwrap();
        let mut h = host("dev.example.com");
        h.id = "h1".into();
        a.host_save(&h).unwrap();
        a.host_set_checked("h1", 5, false, Some("boom"), Some(true)).unwrap();

        // Through JSON, as a file would be.
        let json = serde_json::to_string(&export_settings(&a).unwrap()).unwrap();
        assert!(!json.contains("lastView") && !json.contains("remoteDir") && !json.contains("boom"));

        let b = Db::open_in_memory().unwrap();
        let summary = import_settings(&b, serde_json::from_str(&json).unwrap()).unwrap();
        assert_eq!(summary, "Imported 1 preferences, 1 custom agents and 1 remote machines.");
        assert_eq!(b.prefs_all().unwrap()["theme"], "light");
        let hosts = b.host_list().unwrap();
        assert_eq!(hosts[0].target, "dev.example.com");
        assert_eq!(hosts[0].identity_file.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_ne!(hosts[0].id, "h1");
        assert_eq!(hosts[0].last_error, None);

        // Importing again adds nothing.
        let again = import_settings(&b, serde_json::from_str(&json).unwrap()).unwrap();
        assert_eq!(again, "Imported 1 preferences, 0 custom agents and 0 remote machines.");
        assert_eq!(b.host_list().unwrap().len(), 1);
        assert_eq!(b.custom_agents().unwrap().len(), 1);
    }

    #[test]
    fn import_refuses_unsafe_hosts_and_unknown_versions() {
        let db = Db::open_in_memory().unwrap();
        let bad_host = SettingsFile {
            nexus_settings_version: 1,
            preferences: HashMap::new(),
            custom_agents: vec![],
            remote_hosts: vec![host("-oProxyCommand=evil")],
        };
        assert!(import_settings(&db, bad_host).is_err());
        assert!(db.host_list().unwrap().is_empty());
        let future = SettingsFile {
            nexus_settings_version: 9,
            preferences: HashMap::new(),
            custom_agents: vec![],
            remote_hosts: vec![],
        };
        assert!(import_settings(&db, future).is_err());
    }
}
