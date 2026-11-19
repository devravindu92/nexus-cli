//! Domain models shared across the Tauri boundary.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub icon: String,
    pub accent: String,
    pub description: String,
    pub pinned: bool,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub last_opened_at: i64,
    /// Computed at read time: false when the project folder is missing/moved.
    pub path_exists: bool,
}

/// Persisted process state of a session.
///
/// * `running`      - a live process owned by this app instance.
/// * `exited`       - the process ended on its own.
/// * `recoverable`  - metadata survived an app exit, the process did not.
/// * `closed`       - closed by the user; kept in "recently closed".
///
/// `restored == true` together with `running` means "restored as a NEW
/// process" - never a reattached one. Local PTYs are ephemeral.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    /// "shell" | "agent" | "command"
    pub kind: String,
    pub profile_id: Option<String>,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub accent: Option<String>,
    pub host: String,
    pub state: String,
    pub exit_code: Option<i64>,
    pub restored: bool,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    /// Terminal font size override in px; `None` follows the global setting.
    pub font_size: Option<u16>,
    /// The agent CLI's own conversation ID, when its adapter knows it.
    pub agent_session_id: Option<String>,
    /// That conversation has content, so the CLI can be asked to continue it.
    pub agent_resumable: bool,
    /// Runtime only: latest state from the agent's own signals
    /// ("working" | "waiting" | "permission" | "completed"). `None` = unknown.
    #[serde(default)]
    pub agent_state: Option<String>,
    /// Runtime only: the running process was asked to continue an earlier
    /// conversation (agent continuation - not process reattachment).
    #[serde(default)]
    pub agent_resumed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub available: bool,
    pub resolved_path: Option<String>,
    /// The adapter can continue an earlier conversation by its native ID.
    pub can_resume: bool,
    /// The adapter reports working / waiting / permission state.
    pub reports_state: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub id: i64,
    pub ts: i64,
    pub kind: String,
    pub message: String,
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub home_dir: String,
    /// Version of the agent adapter contract this build implements (FR-069).
    pub agent_adapter_api: u32,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
