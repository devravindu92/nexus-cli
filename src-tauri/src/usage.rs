//! Resource use of each terminal's process tree and of NEXUS itself.
//!
//! Sampled only when the UI asks (the dashboard, while it is visible), so
//! there is no background cost. Nothing here is stored or logged.
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// Longest command line shown for "what is running".
const COMMAND_CHARS: usize = 96;

#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Resident memory in bytes.
    pub memory: u64,
    /// Percent of one CPU core since the previous sample.
    pub cpu: f32,
    pub name: String,
    pub cmd: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeUsage {
    pub memory_bytes: u64,
    pub cpu_percent: f32,
    pub process_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub session_id: String,
    pub pid: u32,
    #[serde(flatten)]
    pub usage: TreeUsage,
    /// Command line of the program in control of the terminal right now.
    pub foreground: Option<String>,
    /// The session's own root program is in the foreground (for a shell:
    /// sitting at its prompt, nothing else running in front).
    pub at_root: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// NEXUS itself, excluding the terminals' processes.
    pub app: TreeUsage,
    /// Whether `app` includes the web view's helper processes.
    pub app_includes_webview: bool,
    pub sessions: Vec<SessionUsage>,
}

/// Sum a process and everything below it.
pub fn tree_usage(procs: &[Proc], root: u32) -> TreeUsage {
    let mut children: HashMap<u32, Vec<&Proc>> = HashMap::new();
    for p in procs {
        if let Some(parent) = p.parent {
            children.entry(parent).or_default().push(p);
        }
    }
    let mut usage = TreeUsage::default();
    let Some(root_proc) = procs.iter().find(|p| p.pid == root) else {
        return usage;
    };
    let mut stack = vec![root_proc];
    let mut seen = std::collections::HashSet::new();
    while let Some(p) = stack.pop() {
        if !seen.insert(p.pid) {
            continue; // PID reuse can make the parent links cyclic
        }
        usage.memory_bytes += p.memory;
        usage.cpu_percent += p.cpu;
        usage.process_count += 1;
        if let Some(kids) = children.get(&p.pid) {
            stack.extend(kids.iter().copied());
        }
    }
    usage
}

/// Short, single-line description of a process for display.
pub fn describe(p: &Proc) -> String {
    let mut parts: Vec<String> = p.cmd.clone();
    match parts.first_mut() {
        Some(first) => {
            // `/usr/local/bin/node` -> `node`; login shells show as `-zsh`.
            let base = first
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(first)
                .trim_start_matches('-')
                .to_string();
            *first = if base.is_empty() { p.name.clone() } else { base };
        }
        None => parts.push(p.name.clone()),
    }
    let line = parts.join(" ").replace(['\n', '\r', '\t'], " ");
    if line.chars().count() > COMMAND_CHARS {
        let cut: String = line.chars().take(COMMAND_CHARS - 1).collect();
        format!("{cut}…")
    } else {
        line
    }
}

/// PID that macOS holds responsible for `pid` (how Activity Monitor groups an
/// app's helper processes). The web view's processes are started by launchd,
/// not by NEXUS, so the parent chain does not find them.
#[cfg(target_os = "macos")]
fn responsible_pid(pid: u32) -> Option<u32> {
    extern "C" {
        fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    }
    let r = unsafe { responsibility_get_pid_responsible_for_pid(pid as i32) };
    u32::try_from(r).ok().filter(|r| *r > 0)
}

pub struct UsageSampler {
    system: System,
}

impl Default for UsageSampler {
    fn default() -> Self {
        UsageSampler {
            system: System::new(),
        }
    }
}

impl UsageSampler {
    fn refresh(&mut self) -> Vec<Proc> {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_cpu()
                .with_cmd(UpdateKind::Always)
                .without_tasks(),
        );
        self.system
            .processes()
            .iter()
            .map(|(pid, p)| Proc {
                pid: pid.as_u32(),
                parent: p.parent().map(Pid::as_u32),
                memory: p.memory(),
                cpu: p.cpu_usage(),
                name: p.name().to_string_lossy().into_owned(),
                cmd: p
                    .cmd()
                    .iter()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect(),
            })
            .collect()
    }

    /// `sessions`: (session id, root PID, foreground PID if known).
    pub fn snapshot(&mut self, sessions: &[(String, u32, Option<u32>)]) -> UsageSnapshot {
        let procs = self.refresh();
        let own = std::process::id();

        let mut session_usage = Vec::with_capacity(sessions.len());
        let mut terminals = TreeUsage::default();
        for (id, root, foreground) in sessions {
            let usage = tree_usage(&procs, *root);
            terminals.memory_bytes += usage.memory_bytes;
            terminals.cpu_percent += usage.cpu_percent;
            terminals.process_count += usage.process_count;
            let fg_pid = foreground.unwrap_or(*root);
            session_usage.push(SessionUsage {
                session_id: id.clone(),
                pid: *root,
                usage,
                foreground: procs.iter().find(|p| p.pid == fg_pid).map(describe),
                at_root: fg_pid == *root,
            });
        }

        // NEXUS = its own process tree minus the terminals it started...
        let whole = tree_usage(&procs, own);
        let mut app = TreeUsage {
            memory_bytes: whole.memory_bytes.saturating_sub(terminals.memory_bytes),
            cpu_percent: (whole.cpu_percent - terminals.cpu_percent).max(0.0),
            process_count: whole.process_count.saturating_sub(terminals.process_count),
        };
        // ...plus, on macOS, the web view helpers the OS attributes to it.
        #[allow(unused_mut)]
        let mut app_includes_webview = !cfg!(target_os = "macos");
        #[cfg(target_os = "macos")]
        {
            // An installed app is its own responsible process. Started from a
            // terminal (development), the terminal is, so there only WebKit
            // helpers are taken.
            let responsible = responsible_pid(own).unwrap_or(own);
            for p in &procs {
                if p.parent == Some(1)
                    && p.pid != own
                    && p.pid != responsible
                    && (responsible == own || p.name.starts_with("com.apple.WebKit"))
                    && responsible_pid(p.pid) == Some(responsible)
                {
                    app.memory_bytes += p.memory;
                    app.cpu_percent += p.cpu;
                    app.process_count += 1;
                    app_includes_webview = true;
                }
            }
        }

        UsageSnapshot {
            app,
            app_includes_webview,
            sessions: session_usage,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, mb: u64, cpu: f32, cmd: &[&str]) -> Proc {
        Proc {
            pid,
            parent: Some(parent),
            memory: mb * 1024 * 1024,
            cpu,
            name: cmd.first().unwrap_or(&"proc").to_string(),
            cmd: cmd.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn sums_a_tree_and_ignores_other_processes() {
        let procs = vec![
            p(10, 1, 5, 0.0, &["-zsh"]),
            p(11, 10, 200, 40.0, &["node", "server.js"]),
            p(12, 11, 50, 10.0, &["esbuild"]),
            p(20, 1, 900, 99.0, &["unrelated"]),
        ];
        let usage = tree_usage(&procs, 10);
        assert_eq!(usage.memory_bytes, 255 * 1024 * 1024);
        assert_eq!(usage.process_count, 3);
        assert!((usage.cpu_percent - 50.0).abs() < 0.01);
        assert_eq!(tree_usage(&procs, 999), TreeUsage::default());
    }

    #[test]
    fn survives_a_parent_cycle() {
        let procs = vec![p(1, 2, 1, 0.0, &["a"]), p(2, 1, 1, 0.0, &["b"])];
        assert_eq!(tree_usage(&procs, 1).process_count, 2);
    }

    #[test]
    fn describes_commands_briefly() {
        assert_eq!(describe(&p(1, 0, 0, 0.0, &["/usr/local/bin/node", "server.js"])), "node server.js");
        assert_eq!(describe(&p(1, 0, 0, 0.0, &["-zsh"])), "zsh");
        let mut bare = p(1, 0, 0, 0.0, &[]);
        bare.name = "kernel_task".into();
        assert_eq!(describe(&bare), "kernel_task");
        let long = "x".repeat(300);
        let text = describe(&p(1, 0, 0, 0.0, &["tool", &long]));
        assert_eq!(text.chars().count(), COMMAND_CHARS);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn samples_this_process() {
        let me = std::process::id();
        let snap = UsageSampler::default().snapshot(&[("self".into(), me, None)]);
        let s = &snap.sessions[0];
        assert!(s.usage.memory_bytes > 0);
        assert!(s.usage.process_count >= 1);
        assert!(s.at_root);
        assert!(s.foreground.is_some());
    }
}
