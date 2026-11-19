//! Remote development hosts over the system OpenSSH client.
//!
//! NEXUS runs `ssh` as a subprocess rather than embedding an SSH library, so
//! the user's own `~/.ssh/config`, known_hosts, agent, jump hosts and
//! interactive prompts (password, passphrase, host-key confirmation) all
//! behave exactly as they do in a terminal. NEXUS never sees, stores or
//! passes a password or key, never edits SSH files and never relaxes
//! host-key checking.
//!
//! Durable sessions use tmux on the host: the process belongs to the remote
//! tmux server, so it survives a dropped connection or NEXUS quitting. It
//! does not survive a reboot of the host, and NEXUS says so.
use crate::platform;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    /// Free-form label such as "dev", "staging", "customer-x".
    pub environment: String,
    /// Hostname, IP address or an alias from the user's SSH config.
    pub target: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    /// Explicit opt-in only: lets the host use the local SSH agent's keys.
    pub agent_forwarding: bool,
    pub tags: Vec<String>,
    pub disabled: bool,
    pub metrics_enabled: bool,
    pub metrics_interval_secs: u32,
    /// Result of the last connection test; `None` = never tested.
    pub has_tmux: Option<bool>,
    pub created_at: i64,
    pub last_connected_at: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
}

fn safe_token(value: &str, extra: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c) || extra.contains(c))
}

impl RemoteHost {
    /// Reject anything that could be read by `ssh` as an option or smuggle
    /// extra arguments. Values are passed as separate argv entries, so this
    /// is defence in depth, not quoting.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("Give the machine a name.".into());
        }
        if !safe_token(&self.target, ":") {
            return Err("Host must be a hostname, IP address or SSH config alias.".into());
        }
        if let Some(user) = &self.user {
            if !safe_token(user, "") {
                return Err("User name contains characters SSH would not accept.".into());
            }
        }
        if let Some(jump) = &self.proxy_jump {
            if !safe_token(jump, ":@,[]") {
                return Err("Jump host must look like [user@]host[:port], comma-separated.".into());
            }
        }
        if let Some(identity) = &self.identity_file {
            if identity.trim().is_empty()
                || identity.starts_with('-')
                || identity.chars().any(|c| c.is_control())
            {
                return Err("Identity file must be a path to a private key file.".into());
            }
        }
        if !(10..=3600).contains(&self.metrics_interval_secs) {
            return Err("Metrics interval must be between 10 seconds and 1 hour.".into());
        }
        Ok(())
    }

    pub fn destination(&self) -> String {
        match &self.user {
            Some(user) => format!("{user}@{}", self.target),
            None => self.target.clone(),
        }
    }

    /// Options derived from the profile, without the destination.
    pub fn connection_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = self.port {
            args.extend(["-p".to_string(), port.to_string()]);
        }
        if let Some(identity) = &self.identity_file {
            args.extend(["-i".to_string(), expand_home(identity)]);
        }
        if let Some(jump) = &self.proxy_jump {
            args.extend(["-J".to_string(), jump.clone()]);
        }
        if self.agent_forwarding {
            args.push("-A".to_string());
        }
        args
    }
}

fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => std::path::Path::new(&platform::home_dir())
            .join(rest)
            .to_string_lossy()
            .into_owned(),
        None => path.to_string(),
    }
}

/// POSIX single-quote a string for the remote shell.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A remote directory, keeping `~` meaningful.
fn quote_dir(dir: &str) -> String {
    if dir == "~" {
        "\"$HOME\"".to_string()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("\"$HOME\"/{}", sh_quote(rest))
    } else {
        sh_quote(dir)
    }
}

/// tmux session name for a NEXUS session: stable, so reconnecting finds the
/// same remote session instead of starting a duplicate.
pub fn tmux_name(session_id: &str) -> String {
    let short: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!("nexus-{short}")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tmux {
    /// Create the named session, or attach if it already exists.
    CreateOrAttach,
    /// Attach only. Fails (exit 3) when the session is gone, so a reconnect
    /// can never silently start a different process.
    AttachOnly,
}

pub struct RemoteLaunch<'a> {
    /// Empty = the user's login shell.
    pub program: &'a str,
    pub args: &'a [String],
    /// Empty = the login directory.
    pub cwd: &'a str,
    pub tmux: Option<(String, Tmux)>,
}

/// The command line the host runs, or `None` for a plain login shell.
///
/// The outer layer is POSIX `sh`, whatever the user's shell is. Programs and
/// tmux are started through the user's login shell so their PATH applies.
pub fn remote_command(launch: &RemoteLaunch) -> Option<String> {
    const LOGIN: &str = "\"${SHELL:-sh}\"";
    let program_line = (!launch.program.is_empty()).then(|| {
        let mut line = format!("exec {}", sh_quote(launch.program));
        for arg in launch.args {
            line.push(' ');
            line.push_str(&sh_quote(arg));
        }
        line
    });
    let cd = (!launch.cwd.is_empty()).then(|| format!("cd -- {} && ", quote_dir(launch.cwd)));

    let body = match &launch.tmux {
        None => {
            if program_line.is_none() && cd.is_none() {
                return None;
            }
            let run = match &program_line {
                Some(line) => format!("exec {LOGIN} -lc {}", sh_quote(line)),
                None => format!("exec {LOGIN} -l"),
            };
            format!("{}{run}", cd.unwrap_or_default())
        }
        Some((name, Tmux::CreateOrAttach)) => {
            let mut tmux = format!("exec tmux new-session -A -s {}", sh_quote(name));
            if let Some(line) = &program_line {
                tmux.push(' ');
                tmux.push_str(&sh_quote(line));
            }
            format!("{}exec {LOGIN} -lc {}", cd.unwrap_or_default(), sh_quote(&tmux))
        }
        Some((name, Tmux::AttachOnly)) => {
            let target = sh_quote(&format!("={name}"));
            format!(
                "{LOGIN} -lc {has} >/dev/null 2>&1 || {{ printf '%s\\n' {msg}; exit 3; }}; exec {LOGIN} -lc {attach}",
                has = sh_quote(&format!("tmux has-session -t {target}")),
                msg = sh_quote(
                    "NEXUS: the remote tmux session no longer exists (it ended, or the host restarted). Nothing was started."
                ),
                attach = sh_quote(&format!("exec tmux attach-session -t {target}")),
            )
        }
    };
    Some(format!("exec sh -c {}", sh_quote(&body)))
}

/// Full argv (after `ssh`) for an interactive session.
pub fn interactive_args(host: &RemoteHost, launch: &RemoteLaunch) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ];
    args.extend(host.connection_args());
    match remote_command(launch) {
        Some(command) => {
            args.push("-t".to_string());
            args.push(host.destination());
            args.push(command);
        }
        None => args.push(host.destination()),
    }
    args
}

// ---- non-interactive probes --------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ProbeStatus {
    Ok,
    /// Could not reach the machine at all.
    Unreachable,
    /// Reached it, but it needs a password, passphrase or other prompt.
    NeedsInteraction,
    /// The host key is not in known_hosts yet.
    HostKeyUnknown,
    /// The host key differs from the one in known_hosts. Never bypassed.
    HostKeyChanged,
    Error,
}

struct BatchOutput {
    stdout: String,
    stderr: String,
    success: bool,
    timed_out: bool,
}

/// Run one bounded, non-interactive command on the host. `BatchMode` means
/// ssh never prompts: it fails instead, and the failure is classified.
fn run_batch(host: &RemoteHost, script: &str, timeout: Duration) -> Result<BatchOutput, String> {
    let ssh = platform::which("ssh")
        .ok_or("The OpenSSH client (`ssh`) was not found on this computer.")?;
    let mut cmd = Command::new(ssh);
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"])
        .args(host.connection_args())
        .arg(host.destination())
        .arg(format!("exec sh -c {}", sh_quote(script)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not run ssh: {e}"))?;
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok(BatchOutput {
        stdout: out_thread.join().unwrap_or_default(),
        stderr: err_thread.join().unwrap_or_default(),
        success: status.map(|s| s.success()).unwrap_or(false),
        timed_out,
    })
}

fn classify(output: &BatchOutput) -> (ProbeStatus, String) {
    let err = output.stderr.trim();
    let lower = err.to_lowercase();
    if output.timed_out {
        return (ProbeStatus::Unreachable, "The connection timed out.".into());
    }
    if lower.contains("remote host identification has changed") {
        return (
            ProbeStatus::HostKeyChanged,
            "The host key has CHANGED since you last connected. This can mean the machine was rebuilt, or that someone is intercepting the connection. NEXUS will not connect until you have checked with whoever runs the machine and fixed known_hosts yourself.".into(),
        );
    }
    if lower.contains("host key verification failed") {
        return (
            ProbeStatus::HostKeyUnknown,
            "This machine's host key is not trusted yet. Open a terminal session to it: SSH will show the key fingerprint for you to check and accept.".into(),
        );
    }
    if lower.contains("permission denied") || lower.contains("no more authentication methods") {
        return (
            ProbeStatus::NeedsInteraction,
            "The machine is reachable but needs a password or key passphrase. That works in a terminal session, where SSH can ask you; background checks and metrics need key or agent sign-in.".into(),
        );
    }
    let last = err.lines().last().unwrap_or("").trim().to_string();
    if lower.contains("could not resolve")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("no route to host")
        || lower.contains("network is unreachable")
        || lower.contains("connection closed")
        || lower.contains("connection reset")
    {
        return (ProbeStatus::Unreachable, last);
    }
    (
        ProbeStatus::Error,
        if last.is_empty() { "ssh failed without a message.".into() } else { last },
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTest {
    pub status: ProbeStatus,
    pub message: String,
    pub os: Option<String>,
    pub has_tmux: Option<bool>,
}

/// What the connection test runs on the host. Shown to the user.
pub const TEST_SCRIPT: &str =
    "echo NEXUS_OK; uname -s; \"${SHELL:-sh}\" -lc 'command -v tmux' >/dev/null 2>&1 && echo NEXUS_TMUX; true";

pub fn test(host: &RemoteHost) -> HostTest {
    let output = match run_batch(host, TEST_SCRIPT, Duration::from_secs(15)) {
        Ok(o) => o,
        Err(message) => {
            return HostTest { status: ProbeStatus::Error, message, os: None, has_tmux: None }
        }
    };
    let mut lines = output.stdout.lines().map(str::trim);
    if output.success && lines.any(|l| l == "NEXUS_OK") {
        let rest: Vec<&str> = output
            .stdout
            .lines()
            .map(str::trim)
            .skip_while(|l| *l != "NEXUS_OK")
            .skip(1)
            .collect();
        let has_tmux = rest.contains(&"NEXUS_TMUX");
        HostTest {
            status: ProbeStatus::Ok,
            message: if has_tmux {
                "Connected. tmux is installed, so durable sessions are available.".into()
            } else {
                "Connected. tmux is not installed on this machine, so sessions end when the connection drops. Install tmux there to enable durable sessions.".into()
            },
            os: rest.first().filter(|l| **l != "NEXUS_TMUX").map(|l| l.to_string()),
            has_tmux: Some(has_tmux),
        }
    } else {
        let (status, message) = classify(&output);
        HostTest { status, message, os: None, has_tmux: None }
    }
}

/// End a durable session on the host. Best effort.
pub fn kill_tmux(host: &RemoteHost, name: &str) -> Result<(), String> {
    let script = format!(
        "\"${{SHELL:-sh}}\" -lc {}",
        sh_quote(&format!("tmux kill-session -t {}", sh_quote(&format!("={name}"))))
    );
    let output = run_batch(host, &script, Duration::from_secs(15))?;
    if output.success {
        Ok(())
    } else {
        Err(classify(&output).1)
    }
}

/// Names of NEXUS-created tmux sessions that exist on the host right now.
pub fn list_tmux(host: &RemoteHost) -> Result<Vec<String>, String> {
    let script = "\"${SHELL:-sh}\" -lc 'tmux list-sessions -F \"#{session_name}\"' 2>/dev/null; true";
    let output = run_batch(host, script, Duration::from_secs(15))?;
    if !output.success {
        return Err(classify(&output).1);
    }
    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("nexus-"))
        .map(str::to_string)
        .collect())
}

/// What the metrics check runs on the host: read-only, unprivileged, bounded.
/// Shown to the user in the host dialog.
pub const METRICS_SCRIPT: &str = r#"echo "os $(uname -s)"
if [ -r /proc/loadavg ]; then echo "load $(cut -d' ' -f1 /proc/loadavg)"; else echo "load $(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"; fi
echo "cpus $(getconf _NPROCESSORS_ONLN 2>/dev/null)"
[ -r /proc/meminfo ] && awk '/^MemTotal:/{print "memtotal "$2} /^MemAvailable:/{print "memavail "$2}' /proc/meminfo
[ -r /proc/uptime ] && echo "uptime $(cut -d. -f1 /proc/uptime)"
df -Pk / 2>/dev/null | awk 'NR==2{print "disk "$2" "$3}'
true"#;

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    pub host_id: String,
    /// How the numbers were collected. Always stated, never implied.
    pub source: String,
    pub collected_at: i64,
    pub status: Option<ProbeStatus>,
    pub error: Option<String>,
    pub os: Option<String>,
    /// 1-minute load average.
    pub load1: Option<f64>,
    pub cpus: Option<u32>,
    pub mem_total_kb: Option<u64>,
    pub mem_available_kb: Option<u64>,
    pub disk_total_kb: Option<u64>,
    pub disk_used_kb: Option<u64>,
    pub uptime_secs: Option<u64>,
}

pub fn parse_metrics(host_id: &str, stdout: &str, now: i64) -> HostMetrics {
    let mut m = HostMetrics {
        host_id: host_id.to_string(),
        source: "ssh command".into(),
        collected_at: now,
        status: Some(ProbeStatus::Ok),
        ..Default::default()
    };
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        match (parts.next(), parts.next(), parts.next()) {
            (Some("os"), Some(v), _) => m.os = Some(v.to_string()),
            (Some("load"), Some(v), _) => m.load1 = v.trim_end_matches(',').parse().ok(),
            (Some("cpus"), Some(v), _) => m.cpus = v.parse().ok(),
            (Some("memtotal"), Some(v), _) => m.mem_total_kb = v.parse().ok(),
            (Some("memavail"), Some(v), _) => m.mem_available_kb = v.parse().ok(),
            (Some("uptime"), Some(v), _) => m.uptime_secs = v.parse().ok(),
            (Some("disk"), Some(total), Some(used)) => {
                m.disk_total_kb = total.parse().ok();
                m.disk_used_kb = used.parse().ok();
            }
            _ => {}
        }
    }
    m
}

pub fn metrics(host: &RemoteHost, now: i64) -> HostMetrics {
    match run_batch(host, METRICS_SCRIPT, Duration::from_secs(15)) {
        Ok(output) if output.success => parse_metrics(&host.id, &output.stdout, now),
        Ok(output) => {
            let (status, message) = classify(&output);
            HostMetrics {
                host_id: host.id.clone(),
                source: "ssh command".into(),
                collected_at: now,
                status: Some(status),
                error: Some(message),
                ..Default::default()
            }
        }
        Err(message) => HostMetrics {
            host_id: host.id.clone(),
            source: "ssh command".into(),
            collected_at: now,
            status: Some(ProbeStatus::Error),
            error: Some(message),
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn host() -> RemoteHost {
        RemoteHost {
            id: "h1".into(),
            name: "DEV-01".into(),
            environment: "dev".into(),
            target: "dev.example.com".into(),
            port: Some(2222),
            user: Some("deploy".into()),
            identity_file: None,
            proxy_jump: Some("bastion.example.com".into()),
            agent_forwarding: false,
            tags: vec![],
            disabled: false,
            metrics_enabled: true,
            metrics_interval_secs: 60,
            has_tmux: None,
            created_at: 0,
            last_connected_at: None,
            last_checked_at: None,
            last_error: None,
        }
    }

    #[test]
    fn rejects_option_injection() {
        let mut h = host();
        assert!(h.validate().is_ok());
        h.target = "-oProxyCommand=evil".into();
        assert!(h.validate().is_err());
        h = host();
        h.user = Some("root -oX".into());
        assert!(h.validate().is_err());
        h = host();
        h.proxy_jump = Some("-J x".into());
        assert!(h.validate().is_err());
        h = host();
        h.target = "host; rm -rf /".into();
        assert!(h.validate().is_err());
    }

    #[test]
    fn builds_argv_without_weakening_host_keys() {
        let h = host();
        let launch = RemoteLaunch { program: "", args: &[], cwd: "", tmux: None };
        let args = interactive_args(&h, &launch);
        assert_eq!(args.last().unwrap(), "deploy@dev.example.com");
        assert!(args.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(args.windows(2).any(|w| w == ["-J", "bastion.example.com"]));
        assert!(!args.contains(&"-A".to_string()));
        assert!(!args.iter().any(|a| a.contains("StrictHostKeyChecking")));
    }

    #[test]
    fn quotes_remote_commands() {
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        let args = vec!["--msg".to_string(), "a b; rm -rf /".to_string()];
        let launch = RemoteLaunch { program: "claude", args: &args, cwd: "~/my app", tmux: None };
        let cmd = remote_command(&launch).unwrap();
        // The dangerous argument only ever appears inside quotes.
        assert!(cmd.starts_with("exec sh -c '"));
        assert!(!cmd.contains(" rm -rf / "));
        assert!(cmd.contains("$HOME"));
    }

    #[test]
    fn attach_only_never_creates() {
        let launch = RemoteLaunch {
            program: "",
            args: &[],
            cwd: "",
            tmux: Some((tmux_name("0b1c2d3e-aaaa-bbbb"), Tmux::AttachOnly)),
        };
        let cmd = remote_command(&launch).unwrap();
        assert!(cmd.contains("has-session"));
        assert!(cmd.contains("attach-session"));
        assert!(!cmd.contains("new-session"));
        assert_eq!(tmux_name("0b1c2d3e-aaaa-bbbb"), "nexus-0b1c2d3eaaaa");
    }

    #[test]
    fn parses_metrics_and_leaves_gaps_empty() {
        let m = parse_metrics(
            "h1",
            "os Linux\nload 0.42\ncpus 8\nmemtotal 16000000\nmemavail 9000000\nuptime 86400\ndisk 100000 40000\n",
            5,
        );
        assert_eq!(m.load1, Some(0.42));
        assert_eq!(m.cpus, Some(8));
        assert_eq!(m.disk_used_kb, Some(40000));
        assert_eq!(m.source, "ssh command");
        let partial = parse_metrics("h1", "os Darwin\nload 1.5,\ncpus 10\n", 5);
        assert_eq!(partial.load1, Some(1.5));
        assert_eq!(partial.mem_total_kb, None);
    }

    /// Runs the generated remote command lines through a local `sh`, exactly
    /// as sshd would hand them to the login shell, against a real tmux.
    /// This covers quoting and the create / reattach / attach-only rules;
    /// it does not cover the SSH connection itself. Skipped without tmux.
    #[cfg(unix)]
    #[test]
    fn tmux_commands_behave_as_promised() {
        if crate::platform::which("tmux").is_none() {
            return;
        }
        let tmux_bin = crate::platform::which("tmux").unwrap();
        let sessions = || -> Vec<String> {
            let out = Command::new(&tmux_bin)
                .args(["list-sessions", "-F", "#{session_name}"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            out.lines().filter(|l| l.starts_with("nexus-")).map(str::to_string).collect()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let name = tmux_name(&id);
        let dir = std::env::temp_dir().join(format!("nexus it's a dir {}", &id[..8]));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().into_owned();
        let mgr = crate::pty::SessionManager::new();
        let spawn = |mode: Tmux, exit: std::sync::mpsc::Sender<Option<i64>>| {
            let cmd = remote_command(&RemoteLaunch {
                program: "",
                args: &[],
                cwd: &dir_str,
                tmux: Some((name.clone(), mode)),
            })
            .unwrap();
            mgr.spawn(
                &id,
                crate::pty::SpawnSpec {
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), cmd],
                    cwd: "/".into(),
                    env: vec![("TERM".into(), "xterm-256color".into())],
                    env_remove: vec!["TMUX".into()],
                    cols: 100,
                    rows: 30,
                },
                Box::new(move |c| {
                    let _ = exit.send(c);
                }),
            )
            .unwrap();
        };
        let wait_for = |needle: &str| {
            let (tx, rx) = std::sync::mpsc::channel();
            mgr.subscribe(&id, Box::new(move |b| tx.send(b.to_vec()).is_ok()));
            let mut acc = String::new();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !acc.contains(needle) && Instant::now() < deadline {
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
                    acc.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            assert!(acc.contains(needle), "wanted {needle:?} in {acc:?}");
        };

        // Create: lands in the requested folder (with a quote and spaces).
        let (tx, _rx) = std::sync::mpsc::channel();
        spawn(Tmux::CreateOrAttach, tx);
        std::thread::sleep(Duration::from_millis(1200));
        mgr.write(&id, b"NEXUS_MARK=kept; echo \"in-$(basename \"$PWD\" | cut -c1-9)-$NEXUS_MARK\"\n").unwrap();
        wait_for("in-nexus it'-kept");
        assert!(sessions().contains(&name));

        // The client goes away (connection lost): the session survives.
        mgr.kill(&id);
        std::thread::sleep(Duration::from_millis(400));
        let raw = Command::new(&tmux_bin).args(["list-sessions"]).output().unwrap();
        assert!(
            sessions().contains(&name),
            "session gone after client kill; list-sessions said: {:?} / {:?}",
            String::from_utf8_lossy(&raw.stdout),
            String::from_utf8_lossy(&raw.stderr)
        );

        // Reattach: the same shell (its variable is still set), no duplicate.
        let (tx, _rx) = std::sync::mpsc::channel();
        spawn(Tmux::AttachOnly, tx);
        std::thread::sleep(Duration::from_millis(1200));
        mgr.write(&id, b"echo again-$NEXUS_MARK\n").unwrap();
        wait_for("again-kept");
        assert_eq!(sessions().iter().filter(|s| **s == name).count(), 1);
        mgr.kill(&id);

        // Once it is gone, attach-only exits 3 and starts nothing.
        let _ = Command::new(&tmux_bin).args(["kill-session", "-t", &format!("={name}")]).status();
        let (tx, rx) = std::sync::mpsc::channel();
        spawn(Tmux::AttachOnly, tx);
        assert_eq!(rx.recv_timeout(Duration::from_secs(15)).unwrap(), Some(3));
        assert!(!sessions().contains(&name));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A program with awkward arguments reaches the far side intact.
    #[cfg(unix)]
    #[test]
    fn program_arguments_survive_the_remote_shell() {
        let args = vec!["a b".to_string(), "it's; echo INJECTED".to_string(), "$HOME".to_string()];
        let cmd = remote_command(&RemoteLaunch { program: "printf", args: &[vec!["[%s]".to_string()], args].concat(), cwd: "", tmux: None }).unwrap();
        let out = Command::new("/bin/sh").args(["-c", &cmd]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "[a b][it's; echo INJECTED][$HOME]");
    }

    /// Against a real SSH server. NOT run in CI or by default: set
    /// `NEXUS_TEST_SSH=<ssh alias or host>` for a machine you can reach with
    /// key or agent sign-in (no prompt) and that has tmux.
    #[test]
    fn live_host_probes() {
        let Ok(target) = std::env::var("NEXUS_TEST_SSH") else {
            return;
        };
        let mut h = host();
        h.target = target;
        h.port = None;
        h.user = None;
        h.proxy_jump = None;
        let t = test(&h);
        assert_eq!(t.status, ProbeStatus::Ok, "{}", t.message);
        let m = metrics(&h, 1);
        assert_eq!(m.status, Some(ProbeStatus::Ok), "{:?}", m.error);
        assert!(m.cpus.unwrap_or(0) > 0, "{m:?}");
        assert!(list_tmux(&h).is_ok());
    }

    #[test]
    fn classifies_failures() {
        let out = |stderr: &str| BatchOutput {
            stdout: String::new(),
            stderr: stderr.into(),
            success: false,
            timed_out: false,
        };
        assert_eq!(classify(&out("Host key verification failed.")).0, ProbeStatus::HostKeyUnknown);
        assert_eq!(
            classify(&out("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed.")).0,
            ProbeStatus::HostKeyChanged
        );
        assert_eq!(classify(&out("x@y: Permission denied (publickey,password).")).0, ProbeStatus::NeedsInteraction);
        assert_eq!(classify(&out("ssh: connect to host x port 22: Connection refused")).0, ProbeStatus::Unreachable);
    }
}
