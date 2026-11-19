# NEXUS

One calm workspace for every terminal, agent and project. A local-first desktop app (Tauri 2 + Rust + React + xterm.js) for organising shells and AI coding agents by project.

NEXUS is a working codename. The full product spec is in [docs/PRD.md](docs/PRD.md).

## Download

Installers for macOS, Linux and Windows are built by GitHub Actions on every push and published under **Releases** (newest pre-release at the top).

### macOS

1. Download the `.dmg` (universal: Apple Silicon and Intel), open it and drag **NEXUS** to Applications.
2. The build is not notarised by Apple yet, so clear the quarantine flag once:

   ```bash
   xattr -cr /Applications/NEXUS.app
   ```

   Until you do, macOS either reports that NEXUS "is damaged and can't be opened" or the app closes the moment it starts. Running it straight from the mounted disk image does the same; copy it to Applications first.

3. Open NEXUS and add a project folder.

## What works today

This is the first slice of Phase 1 (local terminal workspace).

- Workspaces from project folders: rename, pin, tag, accent colour, remove (files untouched).
- Real terminals (PTY) with tabs and horizontal/vertical splits, drag to resize, drag tabs to reorder.
- Shell detection: zsh, bash, fish, nushell, PowerShell, cmd, Git Bash and WSL distributions.
- Agent launch profiles: Claude Code, Codex, Gemini CLI, OpenCode, Cursor Agent, Copilot CLI, Aider, Goose. They use the CLI's own sign-in; NEXUS never asks for API keys.
- Run any command directly (argument array, no shell string).
- Per-session name, colour and font size, searchable scrollback, dark/light/system theme, global font size.
- A confirmation before a multi-line paste reaches a terminal (Always / If unsafe / Never, in Settings).
- A "Locate folder…" action when a project folder has moved.
- SQLite persistence of workspaces, sessions and layouts; the last workspace and layout come back after a restart.
- Truthful session states: Running, Exited (with code), Recoverable, Restored. Local processes end when the app quits; NEXUS says so and offers to start a new process from the saved settings.
- Recently closed sessions (searchable) with restore, dashboard, activity feed, command palette, git branch display.

Not built yet: agent attention detection (shown as Unknown), agent conversation resume, remote hosts and SSH, project config file and trust flow, notifications, multi-window, auto-update, signing/notarisation, web and cloud sync.

## Shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Command palette | ⌘K | Ctrl+Shift+K |
| New terminal tab | ⌘T | Ctrl+Shift+T |
| Split right / down | ⌘D / ⌘⇧D | Ctrl+Shift+D / Ctrl+Shift+E |
| Close session | ⌘W | Ctrl+Shift+W |
| Next / previous pane | ⌘] / ⌘[ | Ctrl+Shift+] / [ |
| Switch tab | ⌘1–9 | Alt+1–9 |
| Find in scrollback | ⌘F | Ctrl+Shift+F |
| Reopen closed session | ⌘⇧T | Ctrl+Shift+R |

## Develop

Requires Node 22+, Rust stable and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

```bash
npm run tauri build
```

```bash
cd src-tauri && cargo test
```

## Layout

- `src-tauri/src/pty.rs` — local terminal runtime (PTY ownership, output replay, exit reporting)
- `src-tauri/src/db.rs` — SQLite schema, migrations and queries
- `src-tauri/src/platform.rs` — shell and agent discovery, login-shell PATH, git branch
- `src-tauri/src/commands.rs` — the typed commands the UI may call (the only path to process execution)
- `src/` — React UI; `src/lib/layout.ts` is the pane/tab model, `src/lib/terminals.ts` owns xterm instances
