# NEXUS handoff

State of the project as of 19 November 2026, written so a new session can continue without the earlier conversation.

## Where things are

- Repo: `devravindu92/nexus-cli`, branch `claude/pensive-franklin-fbguni` (the only branch; there is no `main` yet).
- Latest installers: release `build-1` — https://github.com/devravindu92/nexus-cli/releases/tag/build-1
- The macOS build is unsigned and not notarised. After installing, run `xattr -cr /Applications/NEXUS.app` once.
- Spec: `docs/PRD.md`. What exists is the first slice of "Phase 1 — P0 desktop terminal workspace" (PRD section 14).

## What has and hasn't been verified

Verified by running the real app on Linux (Xvfb, keyboard-driven) and by 12 Rust unit tests:

- App start, onboarding, shell and agent detection
- New tab, split right, split down, PTY sizing follows the pane
- Exit code reporting, close, recently closed, restore as a new process
- Restart recovery: layout restored, sessions shown as Recoverable
- Command palette, dashboard, activity feed, dark theme
- Heavy output (1.5 million lines in about 0.5 s), truecolor

Compiled and unit-tested in CI on macOS and Windows, but **never opened by a person on either**. Nothing below has been checked:

- macOS window chrome: `titleBarStyle: Overlay`, traffic lights over the sidebar header (80 px left padding in `.is-mac .sidebar-head`), dragging by the top bar
- macOS menu: custom menu in `lib.rs` deliberately has no "Close Window" item so ⌘W reaches the webview and closes the focused pane
- ⌘C / ⌘V in the terminal via the Edit menu
- Login-shell PATH capture on macOS (`platform.rs::login_shell_path`), which is what lets a Finder-launched app find `claude`, `codex`, `node`
- Actually launching an agent (Claude Code was detected on Linux but never started)
- The native folder picker
- Light theme, IME input, wide Unicode in the terminal
- Everything on Windows: ConPTY, WSL distro listing, `.cmd` agent shims via `cmd.exe /d /c`
- Tab drag-to-reorder

**First job for a local Mac session: run the app and go through that macOS list.**

## Architecture

```
src-tauri/src/
  lib.rs        app setup, state, macOS menu, kills PTYs on exit
  commands.rs   every command the UI can call; emits session-changed / activity-changed
  pty.rs        SessionManager: owns PTYs, reader + waiter threads, 512 KB replay ring
  db.rs         SQLite (WAL, foreign keys), migrations via PRAGMA user_version
  platform.rs   shell + agent detection, effective PATH, launch resolution, git branch
  models.rs     structs shared with the UI (camelCase over the boundary)
src/
  App.tsx              all app state, actions, keyboard shortcuts
  lib/api.ts           typed invoke wrappers, command-line parser
  lib/layout.ts        pure tab / split-tree model and reconcile()
  lib/terminals.ts     xterm instances, kept alive outside React
  lib/state.ts         context type, describeState()
  lib/themes.ts        terminal colour themes, accent palette
  components/          Sidebar, WorkspaceView (tabs, panes, new-session menu), Dashboard,
                       Palette, Modal (input / confirm / closed sessions / settings), Welcome
  styles.css           all styling, CSS variables for dark and light
```

Things worth knowing before changing code:

- **Session lifecycle.** DB states are `running`, `exited`, `recoverable`, `closed`. On startup every `running` row becomes `recoverable` (`mark_orphans_recoverable`). `session_start` spawns a new process for an existing row and sets `restored = true` unless the row was `exited`. The UI label "Restored" means running-as-a-new-process.
- **Exit vs. kill.** Each spawn gets a `run_id`. The waiter thread only reports exit if its run is still the current one, so `kill()` (which removes the map entry first) never fires `on_exit`, and a stale waiter can't mark a respawned session as exited. `session_set_exited` also only updates rows still `running`.
- **Output path.** Reader thread → replay ring + subscriber sinks. `terminal_subscribe` sends the ring then live output under one lock, over a Tauri `Channel` carrying raw bytes. The frontend subscribes once per process run (`terminals.subscribe` / `markStopped`).
- **Terminals outlive components.** `terminals.ts` keeps each xterm and its DOM node in a map and re-parents the node on mount, so tab and workspace switches keep scrollback.
- **Layout.** One JSON blob per workspace in the `layout` table, saved 250 ms after a change. `reconcile()` drops panes whose session is gone and gives unplaced sessions a tab.
- **PATH.** `effective_path()` = login-shell PATH + inherited PATH + common install dirs, computed once. It is used to find agents and is set in every spawned process's environment.
- **Shortcuts** are handled in one capture-phase `keydown` listener in `App.tsx`. Modifier is ⌘ on macOS and Ctrl+Shift elsewhere. Full table in `README.md`.
- **Data location.** `database.sqlite` in the OS app-data dir for identifier `dev.nexus-codename.desktop` (macOS: `~/Library/Application Support/dev.nexus-codename.desktop/`). Delete it to reset.

## Requirement coverage

Done (PRD P0 unless noted): FR-002, 003, 004, 010–014, 020–025, 027–029, 040–044, 060–064, 110–112 (dashboard), 130, 131, 150; P1 extras: FR-133 (find in scrollback), FR-140 branch name only, FR-017 detection only (shows "missing", no relink action).

Partial:

- FR-026 / FR-151: per-session name and colour only. No per-session font, cursor or theme.
- FR-025: resize by mouse and keyboard, reorder tabs by drag. No pane reordering or moving a pane between tabs.
- FR-001: builds exist but are unsigned.

Not started:

- P0 leftovers: multi-line paste warning (PRD 7.4), secret redaction in logs (SEC-004; there is no logging yet).
- Agents: state detection (FR-065), session ID capture and resume (FR-045, FR-066), notifications (FR-067), custom agent profiles (FR-068), versioned adapter interface (FR-069). `AgentProfile` is a plain struct today, not the `AgentAdapter` port from PRD 9.2.
- Project config `.nexus/workspace.json` and the trust flow (FR-152–156).
- Remote: hosts, SSH, tmux persistence, metrics (FR-080–107). `Session.host` exists and is always `"local"`.
- Keychain / secret store (SEC-001–003). Nothing stores secrets yet.
- Settings import/export, multi-window, auto-update, custom keybindings, scrollback persistence.
- Web app and cloud sync (PRD Phase 4).

## Suggested order of work

1. Verify on macOS (list above) and fix what's wrong.
2. Finish P0: multi-line paste confirmation, relink action for a missing folder, per-session font size.
3. Agent awareness (PRD Phase 2): turn agent profiles into an `AgentAdapter` trait; Claude Code session ID capture and resume, and state from its hooks rather than terminal text; then notifications. This is PRD architecture gate 4 — spike it before designing the UI.
4. Project config and trust flow.
5. Remote hosts (PRD Phase 3): do the SSH spike first (native Rust library vs. OpenSSH subprocess, PRD 9.9), then keychain, then tmux-backed sessions.
6. Signing and notarisation for macOS once an Apple Developer ID is available.

## Known rough edges

- No frontend tests and no end-to-end tests; `layout.ts` is pure and easy to cover first.
- The replay ring can start mid escape sequence after 512 KB, so a re-attached view may show a brief glitch.
- Each PTY read is sent to the UI as its own message; no batching or backpressure.
- Agent and shell detection runs on every "new session" (`detect_shells` / `detect_agents` are not cached).
- A database open failure at startup aborts the app with no dialog.
- Each CI run creates a new pre-release (`build-N`); old ones are not cleaned up.
- The rules of the PRD's module layout (`domain/`, `ports/`, `adapters/`) are not followed yet; the Rust code is five flat modules. Introduce the ports when the second implementation of something arrives (SSH transport, agent adapters).
