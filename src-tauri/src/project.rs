//! Portable project configuration: `.nexus/workspace.json` (versioned).
//!
//! The file lives in the repository, so anyone who can change the repository
//! can change it. It is therefore untrusted: NEXUS only ever *reads* it,
//! shows exactly what it would start, and starts nothing until the user has
//! approved that exact content. Any edit to the file withdraws the approval.
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

pub const CONFIG_REL_PATH: &str = ".nexus/workspace.json";
pub const SUPPORTED_VERSION: u32 = 1;
const MAX_BYTES: u64 = 256 * 1024;
const MAX_SESSIONS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSession {
    pub name: String,
    /// "shell" | "command" | "agent"
    pub kind: String,
    /// For "command": program followed by its arguments.
    #[serde(default)]
    pub command: Vec<String>,
    /// For "agent": an agent profile ID such as "claude" or "codex".
    #[serde(default)]
    pub agent: Option<String>,
    /// Extra arguments for an agent.
    #[serde(default)]
    pub args: Vec<String>,
    /// Folder relative to the project root.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectConfig {
    pub version: u32,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub sessions: Vec<ProjectSession>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigStatus {
    pub exists: bool,
    pub path: String,
    pub config: Option<ProjectConfig>,
    /// Why the file cannot be used, in plain words.
    pub error: Option<String>,
    /// The user approved exactly this content.
    pub trusted: bool,
    /// The user approved an earlier version; the file has changed since.
    pub changed_since_trust: bool,
}

/// A relative path that stays inside the project.
fn safe_relative(path: &str) -> bool {
    let p = Path::new(path);
    !path.trim().is_empty()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

pub fn validate(config: &ProjectConfig) -> Result<(), String> {
    if config.version != SUPPORTED_VERSION {
        return Err(format!(
            "This file is version {}, and this build of NEXUS understands version {SUPPORTED_VERSION}.",
            config.version
        ));
    }
    if config.sessions.len() > MAX_SESSIONS {
        return Err(format!("At most {MAX_SESSIONS} sessions are allowed."));
    }
    for (i, s) in config.sessions.iter().enumerate() {
        let at = format!("sessions[{i}]");
        if s.name.trim().is_empty() {
            return Err(format!("{at}: name is empty."));
        }
        match s.kind.as_str() {
            "shell" => {
                if !s.command.is_empty() || s.agent.is_some() {
                    return Err(format!("{at}: a shell takes no command or agent."));
                }
            }
            "command" => {
                if s.command.first().map(|p| p.trim().is_empty()).unwrap_or(true) {
                    return Err(format!("{at}: command needs a program."));
                }
            }
            "agent" => {
                if s.agent.as_deref().map(|a| a.trim().is_empty()).unwrap_or(true) {
                    return Err(format!("{at}: agent needs a profile such as \"claude\"."));
                }
            }
            other => return Err(format!("{at}: unknown kind \"{other}\".")),
        }
        if let Some(cwd) = &s.cwd {
            if !safe_relative(cwd) {
                return Err(format!(
                    "{at}: cwd must be a folder inside the project (no absolute paths or \"..\")."
                ));
            }
        }
    }
    Ok(())
}

/// Read the file as text. `Ok(None)` when the project has no config.
pub fn read_raw(root: &str) -> Result<Option<String>, String> {
    let path = Path::new(root).join(CONFIG_REL_PATH);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read the file: {e}")),
    };
    if meta.len() > MAX_BYTES {
        return Err("The file is too large to be a workspace config.".into());
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Could not read the file: {e}"))
}

pub fn parse(raw: &str) -> Result<ProjectConfig, String> {
    let config: ProjectConfig =
        serde_json::from_str(raw).map_err(|e| format!("Not a valid workspace config: {e}"))?;
    validate(&config)?;
    Ok(config)
}

/// `trusted_raw` is the exact text the user approved earlier, if any.
pub fn status(root: &str, trusted_raw: Option<&str>) -> ProjectConfigStatus {
    let path = Path::new(root).join(CONFIG_REL_PATH).to_string_lossy().into_owned();
    let raw = match read_raw(root) {
        Ok(Some(raw)) => raw,
        Ok(None) => return ProjectConfigStatus { path, ..Default::default() },
        Err(error) => {
            return ProjectConfigStatus { exists: true, path, error: Some(error), ..Default::default() }
        }
    };
    let trusted = trusted_raw == Some(raw.as_str());
    match parse(&raw) {
        Ok(config) => ProjectConfigStatus {
            exists: true,
            path,
            config: Some(config),
            error: None,
            trusted,
            changed_since_trust: trusted_raw.is_some() && !trusted,
        },
        Err(error) => ProjectConfigStatus {
            exists: true,
            path,
            error: Some(error),
            changed_since_trust: trusted_raw.is_some() && !trusted,
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{
        "version": 1,
        "sessions": [
            {"name": "Dev server", "kind": "command", "command": ["npm", "run", "dev"], "cwd": "web"},
            {"name": "Claude", "kind": "agent", "agent": "claude"},
            {"name": "Shell", "kind": "shell"}
        ]
    }"#;

    #[test]
    fn accepts_a_valid_file() {
        let c = parse(GOOD).unwrap();
        assert_eq!(c.sessions.len(), 3);
        assert_eq!(c.sessions[0].command, vec!["npm", "run", "dev"]);
    }

    #[test]
    fn rejects_escapes_unknown_fields_and_versions() {
        assert!(parse(r#"{"version": 2}"#).unwrap_err().contains("version 2"));
        let escape = r#"{"version":1,"sessions":[{"name":"x","kind":"shell","cwd":"../.."}]}"#;
        assert!(parse(escape).unwrap_err().contains("inside the project"));
        let absolute = r#"{"version":1,"sessions":[{"name":"x","kind":"shell","cwd":"/etc"}]}"#;
        assert!(parse(absolute).is_err());
        let env = r#"{"version":1,"sessions":[{"name":"x","kind":"shell","env":{"TOKEN":"s"}}]}"#;
        assert!(parse(env).is_err(), "unknown fields such as env must be rejected, not ignored");
        let empty = r#"{"version":1,"sessions":[{"name":"x","kind":"command"}]}"#;
        assert!(parse(empty).is_err());
    }

    #[test]
    fn trust_is_tied_to_exact_content() {
        let dir = std::env::temp_dir().join(format!("nexus-proj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".nexus")).unwrap();
        let root = dir.to_string_lossy().into_owned();
        assert!(!status(&root, None).exists);
        std::fs::write(dir.join(CONFIG_REL_PATH), GOOD).unwrap();
        let s = status(&root, None);
        assert!(s.exists && !s.trusted && s.config.is_some());
        assert!(status(&root, Some(GOOD)).trusted);
        std::fs::write(dir.join(CONFIG_REL_PATH), GOOD.replace("npm", "curl")).unwrap();
        let changed = status(&root, Some(GOOD));
        assert!(!changed.trusted && changed.changed_since_trust);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
