//! Agent adapters (PRD 9.2, FR-065/066/069).
//!
//! An adapter knows how to launch one agent CLI, how to ask it to continue an
//! earlier conversation, and how to read the CLI's own documented signals.
//! Nothing here looks at terminal text: when an agent gives no reliable
//! signal its state stays unknown.
//!
//! Signals travel through a per-session events file. The agent CLI runs
//! `nexus agent-hook <adapter>` for its hook events; that helper appends one
//! small JSON line (event name and IDs only - never prompts, tool input or
//! output) and [`AgentMonitor`] tails the file.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Bumped when the [`AgentAdapter`] contract changes incompatibly (FR-069).
pub const ADAPTER_API_VERSION: u32 = 1;

/// Environment variable naming the events file for one NEXUS session.
pub const EVENTS_ENV: &str = "NEXUS_AGENT_EVENTS";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    /// The agent is processing a prompt or running tools.
    Working,
    /// The agent is idle and expects the user to type.
    Waiting,
    /// The agent is blocked on a permission decision.
    Permission,
    /// The agent finished its turn.
    Completed,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Waiting => "waiting",
            AgentState::Permission => "permission",
            AgentState::Completed => "completed",
        }
    }
}

/// What the hook helper records. Deliberately tiny: no user content.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HookEvent {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    /// Sub-type where the CLI gives one (e.g. the notification type).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// What an adapter concluded from one event.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentSignal {
    pub state: Option<AgentState>,
    pub agent_session_id: Option<String>,
    /// The conversation now has content, so asking the CLI to resume it works.
    pub resumable: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    /// Can continue an earlier conversation by its native session ID.
    pub resume: bool,
    /// Reports working / waiting / permission state through a supported signal.
    pub state: bool,
}

pub struct LaunchContext<'a> {
    /// Arguments the user or profile supplied; adapters must not fight them.
    pub user_args: &'a [String],
    /// `Some(id)` asks the CLI to continue that conversation.
    pub resume: Option<&'a str>,
    /// Shell command that runs the hook helper, when signals are wanted.
    pub hook_command: Option<&'a str>,
}

#[derive(Debug, Default, PartialEq)]
pub struct LaunchPlan {
    /// Appended after the user's arguments.
    pub args: Vec<String>,
    /// Native session ID this launch will use, when known up front.
    pub agent_session_id: Option<String>,
    /// True when the plan asks the CLI to continue an earlier conversation.
    pub resumes: bool,
}

pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn program(&self) -> &'static str;
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities::default()
    }
    fn plan(&self, _ctx: &LaunchContext) -> LaunchPlan {
        LaunchPlan::default()
    }
    /// Reduce the CLI's raw hook payload to the fields NEXUS may keep.
    fn extract(&self, _payload: &serde_json::Value) -> Option<HookEvent> {
        None
    }
    fn interpret(&self, _event: &HookEvent) -> AgentSignal {
        AgentSignal::default()
    }
}

// ---- Claude Code ------------------------------------------------------------

/// Claude Code: `--session-id` lets NEXUS choose the conversation ID up front
/// (no scraping, no cross-session mix-ups), `--resume <id>` continues it, and
/// `--settings` adds hooks for this launch only without touching the user's
/// own configuration.
pub struct ClaudeCode;

const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SessionEnd",
];

/// Flags that mean the user is choosing the conversation themselves.
const CLAUDE_SESSION_FLAGS: &[&str] = &["--session-id", "--resume", "-r", "--continue", "-c"];

impl AgentAdapter for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn name(&self) -> &'static str {
        "Claude Code"
    }
    fn program(&self) -> &'static str {
        "claude"
    }
    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            resume: true,
            state: true,
        }
    }

    fn plan(&self, ctx: &LaunchContext) -> LaunchPlan {
        let mut plan = LaunchPlan::default();
        let user_picks_session = ctx.user_args.iter().any(|a| {
            CLAUDE_SESSION_FLAGS
                .iter()
                .any(|f| a == f || a.starts_with(&format!("{f}=")))
        });
        if !user_picks_session {
            match ctx.resume {
                Some(id) => {
                    plan.args.extend(["--resume".to_string(), id.to_string()]);
                    plan.agent_session_id = Some(id.to_string());
                    plan.resumes = true;
                }
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    plan.args.extend(["--session-id".to_string(), id.clone()]);
                    plan.agent_session_id = Some(id);
                }
            }
        }
        if let Some(command) = ctx.hook_command {
            let entry = serde_json::json!([{ "hooks": [{ "type": "command", "command": command }] }]);
            let hooks: serde_json::Map<String, serde_json::Value> = CLAUDE_HOOK_EVENTS
                .iter()
                .map(|e| (e.to_string(), entry.clone()))
                .collect();
            plan.args.push("--settings".to_string());
            plan.args
                .push(serde_json::json!({ "hooks": hooks }).to_string());
        }
        plan
    }

    fn extract(&self, payload: &serde_json::Value) -> Option<HookEvent> {
        let text = |key: &str| payload.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let event = text("hook_event_name")?;
        let detail = match event.as_str() {
            "Notification" => text("notification_type"),
            "SessionStart" => text("source"),
            _ => None,
        };
        Some(HookEvent {
            event,
            agent_session_id: text("session_id"),
            detail,
        })
    }

    fn interpret(&self, event: &HookEvent) -> AgentSignal {
        let detail = event.detail.as_deref().unwrap_or("");
        let (state, resumable) = match event.event.as_str() {
            "SessionStart" => (Some(AgentState::Waiting), detail == "resume"),
            "UserPromptSubmit" => (Some(AgentState::Working), true),
            "PreToolUse" | "PostToolUse" => (Some(AgentState::Working), false),
            "Notification" => match detail {
                "permission_prompt" => (Some(AgentState::Permission), false),
                "idle_prompt" | "elicitation_dialog" => (Some(AgentState::Waiting), false),
                _ => (None, false),
            },
            "Stop" => (Some(AgentState::Completed), false),
            _ => (None, false),
        };
        AgentSignal {
            state,
            agent_session_id: event.agent_session_id.clone(),
            resumable,
        }
    }
}

// ---- launch-only adapters -----------------------------------------------------

/// An agent NEXUS can start but has no verified signal or resume wiring for.
/// Its state is always unknown.
pub struct LaunchOnly {
    pub id: &'static str,
    pub name: &'static str,
    pub program: &'static str,
}

impl AgentAdapter for LaunchOnly {
    fn id(&self) -> &'static str {
        self.id
    }
    fn name(&self) -> &'static str {
        self.name
    }
    fn program(&self) -> &'static str {
        self.program
    }
}

static ADAPTERS: &[&dyn AgentAdapter] = &[
    &ClaudeCode,
    &LaunchOnly { id: "codex", name: "Codex", program: "codex" },
    &LaunchOnly { id: "gemini", name: "Gemini CLI", program: "gemini" },
    &LaunchOnly { id: "opencode", name: "OpenCode", program: "opencode" },
    &LaunchOnly { id: "cursor-agent", name: "Cursor Agent", program: "cursor-agent" },
    &LaunchOnly { id: "copilot", name: "GitHub Copilot CLI", program: "copilot" },
    &LaunchOnly { id: "aider", name: "Aider", program: "aider" },
    &LaunchOnly { id: "goose", name: "Goose", program: "goose" },
];

/// Built-in adapters. Each uses the CLI's own authentication; NEXUS never
/// asks for or stores provider API keys.
pub fn adapters() -> &'static [&'static dyn AgentAdapter] {
    ADAPTERS
}

pub fn adapter(id: &str) -> Option<&'static dyn AgentAdapter> {
    ADAPTERS.iter().copied().find(|a| a.id() == id)
}

// ---- hook helper (runs inside the agent's process tree) ----------------------

/// Shell command an agent CLI can run to report a hook event.
pub fn hook_command(exe: &Path, adapter_id: &str) -> String {
    let exe = exe.to_string_lossy();
    if cfg!(windows) {
        format!("\"{exe}\" agent-hook {adapter_id}")
    } else {
        format!("'{}' agent-hook {adapter_id}", exe.replace('\'', "'\\''"))
    }
}

/// Entry point for `nexus agent-hook <adapter>`. Reads the CLI's payload from
/// stdin and appends the reduced event to the file named by [`EVENTS_ENV`].
/// Prints nothing (hook stdout can be fed back into the agent) and never
/// fails the hook.
pub fn run_hook(adapter_id: &str) {
    let Ok(path) = std::env::var(EVENTS_ENV) else {
        return;
    };
    let Some(adapter) = adapter(adapter_id) else {
        return;
    };
    let mut raw = Vec::new();
    if std::io::stdin()
        .take(4 * 1024 * 1024)
        .read_to_end(&mut raw)
        .is_err()
    {
        return;
    }
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(event) = adapter.extract(&payload) else {
        return;
    };
    let Ok(mut line) = serde_json::to_string(&event) else {
        return;
    };
    line.push('\n');
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        // One small write per event: appends from concurrent hooks stay whole.
        let _ = file.write_all(line.as_bytes());
    }
}

// ---- monitor ------------------------------------------------------------------

/// Runtime-only view of one agent session. Never persisted.
#[derive(Debug, Clone, Default)]
pub struct AgentRuntime {
    pub state: Option<AgentState>,
    /// This run asked the CLI to continue an earlier conversation.
    pub resumed: bool,
}

struct Tracked {
    adapter: &'static dyn AgentAdapter,
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    runtime: AgentRuntime,
}

/// Called with the NEXUS session ID, the signal, and whether the state changed.
type SignalFn = Box<dyn Fn(&str, &AgentSignal, bool) + Send + Sync>;

struct MonitorInner {
    dir: PathBuf,
    tracked: Mutex<HashMap<String, Tracked>>,
    on_signal: Mutex<Option<SignalFn>>,
}

/// Tails the per-session events files and keeps the latest agent state.
#[derive(Clone)]
pub struct AgentMonitor {
    inner: Arc<MonitorInner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl AgentMonitor {
    /// `dir` holds the events files; anything left from an earlier run is stale.
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        AgentMonitor {
            inner: Arc::new(MonitorInner {
                dir,
                tracked: Mutex::new(HashMap::new()),
                on_signal: Mutex::new(None),
            }),
        }
    }

    /// Start the polling thread. `on_signal` runs for every interpreted event,
    /// after the runtime state has been updated.
    pub fn start(&self, on_signal: SignalFn) {
        *lock(&self.inner.on_signal) = Some(on_signal);
        let monitor = self.clone();
        let _ = std::thread::Builder::new()
            .name("agent-monitor".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                monitor.poll();
            });
    }

    /// Begin tracking a session and return the events file its hooks write to.
    pub fn track(&self, session_id: &str, adapter: &'static dyn AgentAdapter, resumed: bool) -> PathBuf {
        let path = self.inner.dir.join(format!("{session_id}.jsonl"));
        let _ = std::fs::remove_file(&path);
        lock(&self.inner.tracked).insert(
            session_id.to_string(),
            Tracked {
                adapter,
                path: path.clone(),
                offset: 0,
                partial: Vec::new(),
                runtime: AgentRuntime {
                    state: None,
                    resumed,
                },
            },
        );
        path
    }

    pub fn untrack(&self, session_id: &str) {
        if let Some(t) = lock(&self.inner.tracked).remove(session_id) {
            let _ = std::fs::remove_file(t.path);
        }
    }

    pub fn runtime(&self, session_id: &str) -> Option<AgentRuntime> {
        lock(&self.inner.tracked)
            .get(session_id)
            .map(|t| t.runtime.clone())
    }

    /// Read whatever the hooks appended since the last poll.
    pub fn poll(&self) {
        let mut signals: Vec<(String, AgentSignal, bool)> = Vec::new();
        {
            let mut tracked = lock(&self.inner.tracked);
            for (id, t) in tracked.iter_mut() {
                let Ok(mut file) = std::fs::File::open(&t.path) else {
                    continue;
                };
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                if len <= t.offset || file.seek(SeekFrom::Start(t.offset)).is_err() {
                    continue;
                }
                let mut fresh = Vec::new();
                if file.read_to_end(&mut fresh).is_err() {
                    continue;
                }
                t.offset += fresh.len() as u64;
                t.partial.extend(fresh);
                while let Some(end) = t.partial.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = t.partial.drain(..=end).collect();
                    let Ok(event) = serde_json::from_slice::<HookEvent>(&line) else {
                        continue;
                    };
                    let signal = t.adapter.interpret(&event);
                    let changed = signal.state.is_some() && signal.state != t.runtime.state;
                    if let Some(state) = signal.state {
                        t.runtime.state = Some(state);
                    }
                    signals.push((id.clone(), signal, changed));
                }
            }
        }
        if signals.is_empty() {
            return;
        }
        if let Some(cb) = lock(&self.inner.on_signal).as_ref() {
            for (id, signal, changed) in &signals {
                cb(id, signal, *changed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(event: &str, detail: Option<&str>) -> HookEvent {
        HookEvent {
            event: event.into(),
            agent_session_id: Some("abc".into()),
            detail: detail.map(str::to_string),
        }
    }

    #[test]
    fn claude_new_launch_picks_an_id_and_adds_hooks() {
        let plan = ClaudeCode.plan(&LaunchContext {
            user_args: &[],
            resume: None,
            hook_command: Some("'/Applications/NEXUS.app/x' agent-hook claude"),
        });
        assert_eq!(plan.args[0], "--session-id");
        assert_eq!(Some(plan.args[1].clone()), plan.agent_session_id);
        assert!(uuid::Uuid::parse_str(&plan.args[1]).is_ok());
        assert!(!plan.resumes);
        assert_eq!(plan.args[2], "--settings");
        let settings: serde_json::Value = serde_json::from_str(&plan.args[3]).unwrap();
        for event in CLAUDE_HOOK_EVENTS {
            assert_eq!(
                settings["hooks"][event][0]["hooks"][0]["command"],
                "'/Applications/NEXUS.app/x' agent-hook claude"
            );
        }
    }

    #[test]
    fn claude_resume_and_user_chosen_sessions() {
        let plan = ClaudeCode.plan(&LaunchContext {
            user_args: &[],
            resume: Some("11111111-2222-3333-4444-555555555555"),
            hook_command: None,
        });
        assert_eq!(plan.args, ["--resume", "11111111-2222-3333-4444-555555555555"]);
        assert!(plan.resumes);

        // The user asked for `claude --continue`: do not add a second session flag.
        let user = vec!["--continue".to_string()];
        let plan = ClaudeCode.plan(&LaunchContext {
            user_args: &user,
            resume: Some("11111111-2222-3333-4444-555555555555"),
            hook_command: None,
        });
        assert!(plan.args.is_empty());
        assert_eq!(plan.agent_session_id, None);
    }

    #[test]
    fn claude_extract_keeps_no_user_content() {
        let payload = serde_json::json!({
            "session_id": "abc",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "my secret prompt",
            "cwd": "/somewhere",
            "transcript_path": "/somewhere/t.jsonl",
        });
        let event = ClaudeCode.extract(&payload).unwrap();
        let line = serde_json::to_string(&event).unwrap();
        assert_eq!(line, r#"{"event":"UserPromptSubmit","agent_session_id":"abc"}"#);
    }

    #[test]
    fn claude_states_come_from_hook_events() {
        let state = |e: &str, d: Option<&str>| ClaudeCode.interpret(&ev(e, d)).state;
        assert_eq!(state("SessionStart", Some("startup")), Some(AgentState::Waiting));
        assert_eq!(state("UserPromptSubmit", None), Some(AgentState::Working));
        assert_eq!(state("PostToolUse", None), Some(AgentState::Working));
        assert_eq!(state("Notification", Some("permission_prompt")), Some(AgentState::Permission));
        assert_eq!(state("Notification", Some("idle_prompt")), Some(AgentState::Waiting));
        assert_eq!(state("Notification", Some("auth_success")), None);
        assert_eq!(state("Stop", None), Some(AgentState::Completed));
        assert_eq!(state("SomethingNew", None), None);
        assert!(ClaudeCode.interpret(&ev("UserPromptSubmit", None)).resumable);
        assert!(ClaudeCode.interpret(&ev("SessionStart", Some("resume"))).resumable);
        assert!(!ClaudeCode.interpret(&ev("SessionStart", Some("startup"))).resumable);
    }

    #[test]
    fn launch_only_agents_stay_unknown() {
        let codex = adapter("codex").unwrap();
        assert!(!codex.capabilities().state && !codex.capabilities().resume);
        assert_eq!(
            codex.plan(&LaunchContext { user_args: &[], resume: Some("x"), hook_command: Some("h") }),
            LaunchPlan::default()
        );
        assert_eq!(codex.interpret(&ev("Stop", None)), AgentSignal::default());
    }

    #[test]
    fn monitor_tails_each_session_separately() {
        let dir = std::env::temp_dir().join(format!("nexus-agent-{}", uuid::Uuid::new_v4()));
        let monitor = AgentMonitor::new(dir.clone());
        let seen: Arc<Mutex<Vec<(String, Option<AgentState>)>>> = Arc::default();
        let sink = seen.clone();
        *lock(&monitor.inner.on_signal) = Some(Box::new(move |id, s, _changed| {
            lock(&sink).push((id.to_string(), s.state));
        }));
        let a = monitor.track("a", &ClaudeCode, false);
        let b = monitor.track("b", &ClaudeCode, true);
        let append = |p: &Path, text: &str| {
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap();
            f.write_all(text.as_bytes()).unwrap();
        };
        append(&a, "{\"event\":\"UserPromptSubmit\"}\n{\"event\":\"Notif");
        append(&b, "{\"event\":\"Stop\"}\n");
        monitor.poll();
        assert_eq!(monitor.runtime("a").unwrap().state, Some(AgentState::Working));
        assert_eq!(monitor.runtime("b").unwrap().state, Some(AgentState::Completed));
        assert!(monitor.runtime("b").unwrap().resumed);
        // The half-written line completes on the next poll.
        append(&a, "ication\",\"detail\":\"permission_prompt\"}\nnot json\n");
        monitor.poll();
        assert_eq!(monitor.runtime("a").unwrap().state, Some(AgentState::Permission));
        assert_eq!(lock(&seen).len(), 3);
        monitor.untrack("a");
        assert!(monitor.runtime("a").is_none());
        assert!(!a.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hook_command_is_quoted() {
        let cmd = hook_command(Path::new("/Apps/My NEXUS/nexus"), "claude");
        if cfg!(windows) {
            assert_eq!(cmd, "\"/Apps/My NEXUS/nexus\" agent-hook claude");
        } else {
            assert_eq!(cmd, "'/Apps/My NEXUS/nexus' agent-hook claude");
        }
    }
}
