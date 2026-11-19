//! Optional web companion: publish workspace and session *metadata* to a
//! NEXUS cloud server the user has chosen and linked this computer to.
//!
//! Off unless the user links. Nothing here runs, and no network request is
//! made, on an unlinked install. What is sent is built by [`build_state`]
//! and nothing else: names and states. Never commands, arguments, folders of
//! sessions, environment values, terminal output, key paths or credentials.
//! The cloud cannot send anything back that NEXUS acts on.
//!
//! The device token is the one secret NEXUS holds. It lives in the OS
//! keychain only; if no keychain is available, linking is refused.
use crate::agent::AgentMonitor;
use crate::db::Db;
use crate::models::now_ms;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

const KEYCHAIN_SERVICE: &str = "dev.nexus-codename.desktop";
const KEYCHAIN_ACCOUNT: &str = "web-companion-device-token";

pub const PREF_URL: &str = "cloudUrl";
pub const PREF_DEVICE: &str = "cloudDeviceName";
pub const PREF_PAUSED: &str = "cloudPaused";
pub const PREF_LAST_SYNC: &str = "cloudLastSyncAt";
pub const PREF_LAST_ERROR: &str = "cloudLastError";
pub const PREF_WORKSPACES: &str = "cloudWorkspaces";
pub const PREF_HOSTS: &str = "cloudIncludeHosts";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("The system keychain is not available: {e}"))
}

fn token_store(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| {
        format!("Could not save to the system keychain, so this computer was not linked: {e}")
    })
}

fn token_load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the system keychain: {e}")),
    }
}

fn token_delete() {
    if let Ok(entry) = entry() {
        let _ = entry.delete_credential();
    }
}

/// Only HTTPS, except a server on this same computer for development.
pub fn validate_url(input: &str) -> Result<String, String> {
    let url = input.trim().trim_end_matches('/');
    let rest = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://") {
        let host = rest.split([':', '/']).next().unwrap_or("");
        if host != "localhost" && host != "127.0.0.1" {
            return Err("The server address must start with https://".into());
        }
        rest
    } else {
        return Err("The server address must start with https://".into());
    };
    if rest.is_empty() || rest.contains(['@', '?', '#', ' ']) || rest.contains('/') {
        return Err("Enter just the server address, like https://nexus.example.com".into());
    }
    Ok(url.to_string())
}

/// Exactly what would be uploaded. Also shown to the user on request.
pub fn build_state(db: &Db, agents: &AgentMonitor) -> Result<Value, String> {
    let prefs = db.prefs_all()?;
    let selected: Option<Vec<String>> = prefs
        .get(PREF_WORKSPACES)
        .and_then(|v| serde_json::from_str(v).ok());
    let include = |id: &str| selected.as_ref().map(|s| s.iter().any(|x| x == id)).unwrap_or(true);
    let home = crate::platform::home_dir();
    let hosts = db.host_list()?;
    let agent_profiles = crate::platform::detect_agents_static();

    let workspaces: Vec<Value> = db
        .workspace_list()?
        .into_iter()
        .filter(|w| include(&w.id))
        .map(|w| {
            json!({
                "id": w.id,
                "name": w.name,
                "path": w.root_path.replacen(&home, "~", 1),
                "accent": w.accent,
                "tags": w.tags,
                "pinned": w.pinned,
            })
        })
        .collect();
    let sessions: Vec<Value> = db
        .session_list_open()?
        .into_iter()
        .filter(|s| include(&s.workspace_id))
        .map(|s| crate::commands::decorate(agents, s))
        .map(|s| {
            let remote = s.host != "local";
            let host = hosts
                .iter()
                .find(|h| h.id == s.host)
                .map(|h| h.name.clone())
                .unwrap_or_else(|| if remote { "Remote".into() } else { "Local".into() });
            let agent = (s.kind == "agent").then(|| {
                agent_profiles
                    .iter()
                    .find(|(id, _)| Some(*id) == s.profile_id.as_deref())
                    .map(|(_, name)| name.to_string())
                    .unwrap_or_else(|| "Custom agent".into())
            });
            json!({
                "id": s.id,
                "workspaceId": s.workspace_id,
                "name": s.name,
                "kind": s.kind,
                "agent": agent,
                "host": host,
                "remote": remote,
                "durable": s.persistence == "tmux",
                "state": s.state,
                "agentState": s.agent_state,
                "exitCode": s.exit_code,
                "createdAt": s.created_at,
            })
        })
        .collect();
    let hosts_out: Vec<Value> = if prefs.get(PREF_HOSTS).map(|v| v == "off").unwrap_or(false) {
        vec![]
    } else {
        hosts
            .iter()
            .map(|h| {
                json!({
                    "id": h.id,
                    "name": h.name,
                    "environment": h.environment,
                    "target": h.target,
                    "tags": h.tags,
                    "reachable": h.last_checked_at.map(|_| h.last_error.is_none()),
                    "checkedAt": h.last_checked_at,
                })
            })
            .collect()
    };
    let activity: Vec<Value> = db
        .activity_list(30)?
        .into_iter()
        .filter(|a| a.workspace_id.as_deref().map(include).unwrap_or(true))
        .map(|a| json!({ "ts": a.ts, "kind": a.kind, "message": a.message }))
        .collect();
    Ok(json!({ "workspaces": workspaces, "sessions": sessions, "hosts": hosts_out, "activity": activity }))
}

// ---- HTTP ---------------------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .into()
}

enum Call<'a> {
    Get,
    Delete,
    Post(&'a Value),
    Put(&'a Value),
}

/// Returns (status, body). Network failures are `Err`.
fn call(url: &str, token: Option<&str>, call: Call) -> Result<(u16, Value), String> {
    let agent = agent();
    let auth = token.map(|t| format!("Bearer {t}"));
    let result = match call {
        Call::Get => {
            let mut r = agent.get(url);
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.call()
        }
        Call::Delete => {
            let mut r = agent.delete(url);
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.call()
        }
        Call::Post(body) => {
            let mut r = agent.post(url);
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.send_json(body)
        }
        Call::Put(body) => {
            let mut r = agent.put(url);
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r.send_json(body)
        }
    };
    let mut response = result.map_err(|e| format!("Could not reach the server: {e}"))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_json::<Value>().unwrap_or(Value::Null);
    Ok((status, body))
}

fn server_error(status: u16, body: &Value) -> String {
    body.get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("The server answered with status {status}."))
}

// ---- state shared with the background loop -------------------------------------

#[derive(Default)]
pub struct Cloud {
    /// Token read from the keychain once per run, so the OS does not prompt
    /// on every sync. Never written anywhere else.
    token: Mutex<Option<String>>,
    last_sent: Mutex<Option<(String, i64)>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub linked: bool,
    pub url: Option<String>,
    pub device_name: Option<String>,
    pub paused: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Cloud {
    pub fn status(&self, db: &Db) -> Result<CloudStatus, String> {
        let prefs = db.prefs_all()?;
        let url = prefs.get(PREF_URL).filter(|u| !u.is_empty()).cloned();
        Ok(CloudStatus {
            linked: url.is_some(),
            url,
            device_name: prefs.get(PREF_DEVICE).cloned(),
            paused: prefs.get(PREF_PAUSED).map(|v| v == "on").unwrap_or(false),
            last_sync_at: prefs.get(PREF_LAST_SYNC).and_then(|v| v.parse().ok()),
            last_error: prefs.get(PREF_LAST_ERROR).filter(|e| !e.is_empty()).cloned(),
        })
    }

    fn token(&self) -> Result<String, String> {
        if let Some(t) = lock(&self.token).clone() {
            return Ok(t);
        }
        let t = token_load()?.ok_or("This computer's link is missing from the keychain. Unlink and link again.")?;
        *lock(&self.token) = Some(t.clone());
        Ok(t)
    }

    /// Exchange a one-time pairing code from the web page for a device token.
    pub fn link(&self, db: &Db, url: &str, code: &str, name: &str) -> Result<(), String> {
        let url = validate_url(url)?;
        // Check the keychain works before using up the code.
        token_load()?;
        let body = json!({ "code": code, "name": name, "platform": std::env::consts::OS });
        let (status, reply) = call(&format!("{url}/api/devices/claim"), None, Call::Post(&body))?;
        if status != 201 {
            return Err(server_error(status, &reply));
        }
        let token = reply.get("token").and_then(Value::as_str).ok_or("The server sent no token.")?;
        if let Err(err) = token_store(token) {
            // Do not leave a device registered that this computer cannot use.
            let _ = call(&format!("{url}/api/sync/me"), Some(token), Call::Delete);
            return Err(err);
        }
        *lock(&self.token) = Some(token.to_string());
        *lock(&self.last_sent) = None;
        db.pref_set(PREF_URL, &url)?;
        db.pref_set(PREF_DEVICE, reply.get("name").and_then(Value::as_str).unwrap_or(name))?;
        db.pref_set(PREF_PAUSED, "off")?;
        db.pref_set(PREF_LAST_ERROR, "")?;
        Ok(())
    }

    /// Remove this computer from the account and forget the token. The local
    /// side is always cleared, even if the server cannot be reached.
    pub fn unlink(&self, db: &Db) -> Result<(), String> {
        let prefs = db.prefs_all()?;
        if let (Some(url), Ok(token)) = (prefs.get(PREF_URL), self.token()) {
            let _ = call(&format!("{url}/api/sync/me"), Some(&token), Call::Delete);
        }
        token_delete();
        *lock(&self.token) = None;
        *lock(&self.last_sent) = None;
        for key in [PREF_URL, PREF_DEVICE, PREF_LAST_SYNC, PREF_LAST_ERROR] {
            db.pref_set(key, "")?;
        }
        Ok(())
    }

    pub fn delete_remote_data(&self, db: &Db) -> Result<(), String> {
        let url = db.prefs_all()?.get(PREF_URL).cloned().filter(|u| !u.is_empty()).ok_or("Not linked.")?;
        let (status, reply) = call(&format!("{url}/api/sync/state"), Some(&self.token()?), Call::Delete)?;
        *lock(&self.last_sent) = None;
        if status == 200 { Ok(()) } else { Err(server_error(status, &reply)) }
    }

    /// Upload the current state if it changed, or if the server has not heard
    /// from this computer for a while (so it can show it as online).
    /// `force` uploads regardless. Returns whether anything was sent.
    pub fn sync(&self, db: &Db, agents: &AgentMonitor, force: bool) -> Result<bool, String> {
        let status = self.status(db)?;
        let Some(url) = status.url else {
            return Ok(false);
        };
        if status.paused && !force {
            return Ok(false);
        }
        let state = build_state(db, agents)?;
        let text = state.to_string();
        let now = now_ms();
        if !force {
            if let Some((sent, at)) = lock(&self.last_sent).as_ref() {
                if *sent == text && now - *at < 120_000 {
                    return Ok(false);
                }
            }
        }
        let result = self.token().and_then(|token| {
            let body = json!({ "revision": now, "state": state });
            let (code, reply) = call(&format!("{url}/api/sync/state"), Some(&token), Call::Put(&body))?;
            match code {
                200 => Ok(()),
                401 => Err("This computer's access was revoked on the web. Unlink it here, then link again if you want to resume.".to_string()),
                _ => Err(server_error(code, &reply)),
            }
        });
        match &result {
            Ok(()) => {
                *lock(&self.last_sent) = Some((text, now));
                db.pref_set(PREF_LAST_SYNC, &now.to_string())?;
                db.pref_set(PREF_LAST_ERROR, "")?;
            }
            Err(err) => {
                db.pref_set(PREF_LAST_ERROR, err)?;
                // A revoked device stops trying until the user acts.
                if err.contains("revoked") {
                    db.pref_set(PREF_PAUSED, "on")?;
                }
            }
        }
        result.map(|_| true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Session, Workspace};

    #[test]
    fn only_https_or_this_computer() {
        assert_eq!(validate_url(" https://nexus.example.com/ ").unwrap(), "https://nexus.example.com");
        assert!(validate_url("http://localhost:8080").is_ok());
        assert!(validate_url("http://nexus.example.com").is_err());
        assert!(validate_url("https://user:pw@host").is_err());
        assert!(validate_url("https://host/path").is_err());
        assert!(validate_url("ftp://host").is_err());
        assert!(validate_url("http://localhost.evil.com").is_err());
    }

    /// Against a real NEXUS cloud server. Not run by default: set
    /// `NEXUS_TEST_CLOUD=<https url>` and `NEXUS_TEST_CLOUD_CODE=<pairing code>`.
    /// Supplies the token directly, so it covers the HTTP client and the sync
    /// rules but not the keychain.
    #[test]
    fn live_sync_against_a_server() {
        let (Ok(url), Ok(code)) = (std::env::var("NEXUS_TEST_CLOUD"), std::env::var("NEXUS_TEST_CLOUD_CODE")) else {
            return;
        };
        let url = validate_url(&url).unwrap();
        let body = json!({ "code": code, "name": "sync test", "platform": std::env::consts::OS });
        let (status, reply) = call(&format!("{url}/api/devices/claim"), None, Call::Post(&body)).unwrap();
        assert_eq!(status, 201, "{reply}");
        let token = reply["token"].as_str().unwrap().to_string();

        let db = Db::open_in_memory().unwrap();
        let agents = AgentMonitor::new(std::env::temp_dir().join("nexus-cloud-live"));
        db.pref_set(PREF_URL, &url).unwrap();
        let cloud = Cloud::default();
        *lock(&cloud.token) = Some(token.clone());

        assert_eq!(cloud.sync(&db, &agents, false), Ok(true), "first sync uploads");
        assert_eq!(cloud.sync(&db, &agents, false), Ok(false), "unchanged state is not re-sent");
        assert!(cloud.status(&db).unwrap().last_sync_at.is_some());
        let (status, me) = call(&format!("{url}/api/sync/me"), Some(&token), Call::Get).unwrap();
        assert_eq!(status, 200);
        assert!(me["revision"].as_i64().unwrap() > 0);
        cloud.delete_remote_data(&db).unwrap();

        // Paused: nothing is sent unless asked for explicitly.
        db.pref_set(PREF_PAUSED, "on").unwrap();
        *lock(&cloud.last_sent) = None;
        assert_eq!(cloud.sync(&db, &agents, false), Ok(false));
        db.pref_set(PREF_PAUSED, "off").unwrap();

        // Access removed on the server side: the next sync says so and pauses.
        let (status, _) = call(&format!("{url}/api/sync/me"), Some(&token), Call::Delete).unwrap();
        assert_eq!(status, 200);
        let err = cloud.sync(&db, &agents, true).unwrap_err();
        assert!(err.contains("revoked"), "{err}");
        let after = cloud.status(&db).unwrap();
        assert!(after.paused && after.last_error.is_some());

        // A server that is not there is an error, not a hang or a panic.
        db.pref_set(PREF_URL, "http://127.0.0.1:9").unwrap();
        db.pref_set(PREF_PAUSED, "off").unwrap();
        assert!(cloud.sync(&db, &agents, true).unwrap_err().contains("Could not reach"));
    }

    #[test]
    fn published_state_holds_names_and_states_only() {
        let db = Db::open_in_memory().unwrap();
        let agents = AgentMonitor::new(std::env::temp_dir().join("nexus-cloud-test"));
        let ws = |id: &str, name: &str| Workspace {
            id: id.into(),
            name: name.into(),
            root_path: format!("{}/code/{name}", crate::platform::home_dir()),
            icon: String::new(),
            accent: "#8b9cff".into(),
            description: "private note".into(),
            pinned: false,
            tags: vec![],
            created_at: 1,
            last_opened_at: 1,
            path_exists: true,
        };
        db.workspace_insert(&ws("w1", "shared")).unwrap();
        db.workspace_insert(&ws("w2", "private")).unwrap();
        let session = |id: &str, w: &str| Session {
            id: id.into(),
            workspace_id: w.into(),
            name: format!("sess-{id}"),
            kind: "command".into(),
            profile_id: None,
            program: "deploy-tool".into(),
            args: vec!["--token".into(), "SECRET-ARG".into()],
            cwd: "/srv/SECRET-CWD".into(),
            accent: None,
            host: "local".into(),
            state: "running".into(),
            exit_code: None,
            restored: false,
            created_at: 1,
            closed_at: None,
            font_size: None,
            agent_session_id: Some("SECRET-CONVERSATION".into()),
            agent_resumable: false,
            persistence: String::new(),
            agent_state: None,
            agent_resumed: false,
        };
        db.session_insert(&session("s1", "w1")).unwrap();
        db.session_insert(&session("s2", "w2")).unwrap();

        let all = build_state(&db, &agents).unwrap().to_string();
        assert!(all.contains("sess-s1") && all.contains("sess-s2"));
        assert!(all.contains("~/code/shared"), "home folder should be shortened: {all}");
        for secret in ["SECRET-ARG", "SECRET-CWD", "SECRET-CONVERSATION", "deploy-tool", "--token", "private note"] {
            assert!(!all.contains(secret), "leaked {secret}");
        }

        // Only the workspaces the user picked.
        db.pref_set(PREF_WORKSPACES, "[\"w1\"]").unwrap();
        let picked = build_state(&db, &agents).unwrap().to_string();
        assert!(picked.contains("sess-s1") && !picked.contains("sess-s2") && !picked.contains("private"));
    }
}
