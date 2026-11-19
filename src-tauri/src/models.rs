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
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
