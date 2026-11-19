//! OS-specific discovery: shells, agent CLIs and the user's real PATH.
use crate::models::{AgentProfile, ShellProfile};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub fn home_dir() -> String {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var).unwrap_or_else(|_| if cfg!(windows) { "C:\\".into() } else { "/".into() })
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Resolve `name` against a PATH-style string (honouring PATHEXT on Windows).
pub fn which_in(name: &str, path_var: &str) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.components().count() > 1 {
        return is_executable(direct).then(|| direct.to_path_buf());
    }
    let exts: Vec<String> = if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        std::iter::once(String::new())
            .chain(pathext.split(';').map(|s| s.to_string()))
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn which(name: &str) -> Option<PathBuf> {
    which_in(name, effective_path())
}

/// Run a command and capture stdout, giving up after `timeout`.
fn output_with_timeout(mut cmd: std::process::Command, timeout: std::time::Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let result = rx.recv_timeout(timeout).ok();
    if result.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

/// GUI apps on macOS (and some Linux launchers) start with a minimal PATH, so
/// tools installed via Homebrew, npm, cargo etc. are invisible. Ask the
/// user's login shell for its PATH once, with a hard timeout.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| Path::new(s).is_file())?;
    let mut cmd = std::process::Command::new(shell);
    cmd.args([
        "-l",
        "-i",
        "-c",
        "echo __NEXUS_PATH_BEGIN__; printenv PATH; echo __NEXUS_PATH_END__",
    ]);
    let out = output_with_timeout(cmd, std::time::Duration::from_secs(5))?;
    let text = String::from_utf8_lossy(&out);
    let mut lines = text.lines().skip_while(|l| l.trim() != "__NEXUS_PATH_BEGIN__");
    lines.next()?;
    let path = lines.next()?.trim().to_string();
    (!path.is_empty() && path != "__NEXUS_PATH_END__").then_some(path)
}

/// PATH used to locate and run tools: login-shell PATH, the inherited PATH and
/// a few well-known install locations, de-duplicated in that order.
pub fn effective_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = Vec::new();
        let mut push_all = |value: &str| {
            for d in std::env::split_paths(value) {
                if !d.as_os_str().is_empty() && !dirs.contains(&d) {
                    dirs.push(d);
                }
            }
        };
        #[cfg(unix)]
        if let Some(p) = login_shell_path() {
            push_all(&p);
        }
        if let Ok(p) = std::env::var("PATH") {
            push_all(&p);
        }
        let home = PathBuf::from(home_dir());
        if cfg!(unix) {
            let extra: Vec<PathBuf> = vec![
                "/opt/homebrew/bin".into(),
                "/usr/local/bin".into(),
                home.join(".local/bin"),
                home.join(".cargo/bin"),
                home.join(".bun/bin"),
                home.join(".npm-global/bin"),
                home.join(".claude/local"),
                "/usr/bin".into(),
                "/bin".into(),
            ];
            let joined = std::env::join_paths(extra).unwrap_or_default();
            push_all(&joined.to_string_lossy());
        }
        std::env::join_paths(dirs)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| std::env::var("PATH").unwrap_or_default())
    })
}

/// Environment applied on top of the inherited one for every terminal.
pub fn terminal_env() -> Vec<(String, String)> {
    let mut env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM_PROGRAM".to_string(), "NEXUS".to_string()),
        ("TERM_PROGRAM_VERSION".to_string(), env!("CARGO_PKG_VERSION").to_string()),
        ("PATH".to_string(), effective_path().to_string()),
    ];
    // GUI launches often have no locale, which breaks Unicode in TUIs.
    if cfg!(unix) && std::env::var("LANG").is_err() && std::env::var("LC_ALL").is_err() {
        env.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
    }
    env
}

// ---- shells ---------------------------------------------------------------

#[cfg(unix)]
pub fn detect_shells() -> Vec<ShellProfile> {
    let user_shell = std::env::var("SHELL").unwrap_or_default();
    let user_base = Path::new(&user_shell)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let known: &[(&str, &str, &[&str])] = &[
        ("zsh", "Zsh", &["-l"]),
        ("bash", "Bash", &["-l"]),
        ("fish", "Fish", &["-l"]),
        ("nu", "Nushell", &["-l"]),
        ("pwsh", "PowerShell", &["-NoLogo"]),
        ("sh", "sh", &[]),
    ];
    let etc_shells = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let mut out: Vec<ShellProfile> = Vec::new();
    for (id, label, args) in known {
        let program = if *id == user_base && is_executable(Path::new(&user_shell)) {
            Some(PathBuf::from(&user_shell))
        } else {
            etc_shells
                .lines()
                .map(str::trim)
                .filter(|l| !l.starts_with('#'))
                .map(Path::new)
                .find(|p| p.file_name().map(|n| n == *id).unwrap_or(false) && is_executable(p))
                .map(Path::to_path_buf)
                .or_else(|| which(id))
        };
        if let Some(program) = program {
            out.push(ShellProfile {
                id: id.to_string(),
                name: label.to_string(),
                program: program.to_string_lossy().into_owned(),
                args: args.iter().map(|s| s.to_string()).collect(),
                is_default: *id == user_base,
            });
        }
    }
    if !out.iter().any(|s| s.is_default) {
        if let Some(first) = out.first_mut() {
            first.is_default = true;
        }
    }
    out
}

#[cfg(windows)]
pub fn detect_shells() -> Vec<ShellProfile> {
    let mut out: Vec<ShellProfile> = Vec::new();
    let mut add = |id: &str, name: &str, program: PathBuf, args: &[&str]| {
        out.push(ShellProfile {
            id: id.to_string(),
            name: name.to_string(),
            program: program.to_string_lossy().into_owned(),
            args: args.iter().map(|s| s.to_string()).collect(),
            is_default: false,
        });
    };
    if let Some(p) = which("pwsh") {
        add("pwsh", "PowerShell 7", p, &["-NoLogo"]);
    }
    if let Some(p) = which("powershell") {
        add("powershell", "Windows PowerShell", p, &["-NoLogo"]);
    }
    if let Some(p) = which("cmd") {
        add("cmd", "Command Prompt", p, &[]);
    }
    for candidate in [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            add("git-bash", "Git Bash", p, &["--login", "-i"]);
            break;
        }
    }
    if let Some(wsl) = which("wsl") {
        let mut cmd = std::process::Command::new(&wsl);
        cmd.args(["-l", "-q"]);
        if let Some(bytes) = output_with_timeout(cmd, std::time::Duration::from_secs(4)) {
            // wsl.exe prints UTF-16LE.
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            for line in String::from_utf16_lossy(&units).lines() {
                let distro = line.trim().trim_matches('\u{feff}').trim_matches('\0');
                if distro.is_empty() || distro.contains(' ') && distro.to_lowercase().contains("windows subsystem") {
                    continue;
                }
                add(
                    &format!("wsl:{distro}"),
                    &format!("WSL: {distro}"),
                    wsl.clone(),
                    &["-d", distro],
                );
            }
        }
    }
    if let Some(first) = out.first_mut() {
        first.is_default = true;
    }
    out
}

// ---- agents ---------------------------------------------------------------

/// Built-in agent launch profiles. Each uses the CLI's own authentication;
/// NEXUS never asks for or stores provider API keys.
const BUILTIN_AGENTS: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
    ("gemini", "Gemini CLI", "gemini"),
    ("opencode", "OpenCode", "opencode"),
    ("cursor-agent", "Cursor Agent", "cursor-agent"),
    ("copilot", "GitHub Copilot CLI", "copilot"),
    ("aider", "Aider", "aider"),
    ("goose", "Goose", "goose"),
];

pub fn detect_agents() -> Vec<AgentProfile> {
    BUILTIN_AGENTS
        .iter()
        .map(|(id, name, program)| {
            let resolved = which(program);
            AgentProfile {
                id: id.to_string(),
                name: name.to_string(),
                program: program.to_string(),
                args: vec![],
                available: resolved.is_some(),
                resolved_path: resolved.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

/// Turn a logical program + args into something the OS can execute directly.
/// Always an argument array - never a concatenated shell string.
pub fn resolve_launch(program: &str, args: &[String]) -> Result<(String, Vec<String>), String> {
    let resolved = which(program)
        .ok_or_else(|| format!("`{program}` is not installed or not on your PATH"))?;
    let resolved_str = resolved.to_string_lossy().into_owned();
    if cfg!(windows) {
        let ext = resolved
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext == "cmd" || ext == "bat" {
            let mut full = vec!["/d".to_string(), "/c".to_string(), resolved_str];
            full.extend(args.iter().cloned());
            return Ok(("cmd.exe".to_string(), full));
        }
    }
    Ok((resolved_str, args.to_vec()))
}

/// Current git branch (or short detached SHA) by reading `.git/HEAD`.
pub fn git_branch(root: &str) -> Option<String> {
    let mut dir = PathBuf::from(root);
    loop {
        let dot_git = dir.join(".git");
        let head_path = if dot_git.is_dir() {
            Some(dot_git.join("HEAD"))
        } else if dot_git.is_file() {
            // Worktree / submodule: "gitdir: <path>"
            let content = std::fs::read_to_string(&dot_git).ok()?;
            let gitdir = content.trim().strip_prefix("gitdir:")?.trim();
            let p = PathBuf::from(gitdir);
            Some(if p.is_absolute() { p } else { dir.join(p) }.join("HEAD"))
        } else {
            None
        };
        if let Some(head_path) = head_path {
            let head = std::fs::read_to_string(head_path).ok()?;
            let head = head.trim();
            return Some(match head.strip_prefix("ref: refs/heads/") {
                Some(branch) => branch.to_string(),
                None => head.chars().take(7).collect(),
            });
        }
        if !dir.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn finds_sh_and_detects_a_default_shell() {
        assert!(which_in("sh", "/bin:/usr/bin").is_some());
        assert!(which_in("definitely-not-a-real-tool", "/bin:/usr/bin").is_none());
        let shells = detect_shells();
        assert!(!shells.is_empty());
        assert_eq!(shells.iter().filter(|s| s.is_default).count(), 1);
    }

    #[test]
    fn unknown_program_gives_actionable_error() {
        let err = resolve_launch("definitely-not-a-real-tool", &[]).unwrap_err();
        assert!(err.contains("not installed"));
    }

    #[test]
    fn agent_profiles_cover_claude_and_codex() {
        let agents = detect_agents();
        assert!(agents.iter().any(|a| a.id == "claude"));
        assert!(agents.iter().any(|a| a.id == "codex"));
    }

    #[test]
    fn reads_git_branch() {
        let dir = std::env::temp_dir().join(format!("nexus-git-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        assert_eq!(
            git_branch(&dir.join("sub/deep").to_string_lossy()).as_deref(),
            Some("feature/x")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
