# NEXUS handoff

State of the project as of 19 November 2026, written so a new session can continue without the earlier conversation.

## Where things are

- Repo: `devravindu92/nexus-cli`, branch `claude/pensive-franklin-fbguni` (the only branch; there is no `main` yet).
- Latest installers: release `build-1` — https://github.com/devravindu92/nexus-cli/releases/tag/build-1
- The macOS build is unsigned and not notarised. After installing, run `xattr -cr /Applications/NEXUS.app` once.
- Spec: `docs/PRD.md`. What exists is the first slice of "Phase 1 — P0 desktop terminal workspace" (PRD section 14).

## What has and hasn't been verified

Verified by running the real app on Linux (Xvfb, keyboard-driven) and by 22 Rust unit tests:

- App start, onboarding, shell and agent detection
- New tab, split right, split down, PTY sizing follows the pane
- Exit code reporting, close, recently closed, restore as a new process
- Restart recovery: layout restored, sessions shown as Recoverable
- Command palette, dashboard, activity feed, dark theme
- Heavy output (1.5 million lines in about 0.5 s), truecolor

Verified on macOS 26.3 (Apple Silicon) on 19 November 2026, by driving the dev build through the accessibility API (System Events), synthetic mouse events and checking side effects (files written by the shell, SQLite rows, child processes). No screenshots were possible, so "verified" here means behaviour, not appearance:

- `cargo test` (22 tests) and `npm run build` pass locally
- Window chrome: traffic lights sit at `trafficLightPosition {16, 24}`, vertically centred on the 44 px top bar (the default position was 6 px too high); the window drags by the top bar and the sidebar header; double-click on the top bar zooms
- Menu: App / Edit / Window only; ⌘W closes the focused pane and the window stays; ⌘Q quits and no child process survives
- ⌘T, ⌘D, ⌘⇧D; PTY size follows the pane (131x43 full, 63x20 after two splits)
- ⌘V pastes into the shell; double-click selects a word and ⌘C copies it
- Native folder picker (opens as a sheet) for adding a workspace and for relinking one
- Agent and shell detection; Claude Code and Codex both start and stay running, including when the app is started with a Finder-style minimal environment (`env -i`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`), which exercises `platform.rs::login_shell_path`
- Restart recovery (sessions come back as Recoverable, tab order kept), "Start as new process", tab drag-to-reorder
- The `build-1` release `.dmg`: the app is killed at launch (exit 137) while the quarantine flag is set, and runs normally once it is cleared with `xattr -cr`. Nothing in the code is wrong; it needs signing and notarisation (step 6 below)

Still unchecked:

- How it looks on macOS: light theme, the terminal rendering of Claude Code / Codex, fonts. Needs a person or a screenshot
- IME input and wide Unicode in the terminal
- A build launched from Finder for real (only simulated with a minimal environment)
- Everything on Windows: ConPTY, WSL distro listing, `.cmd` agent shims via `cmd.exe /d /c`

## Architecture

```
src-tauri/src/
  main.rs       starts the app, or runs the `agent-hook` helper and exits
  lib.rs        app setup, state, macOS menu, agent signal handling, kills PTYs on exit
  agent.rs      AgentAdapter trait and adapters, hook helper, AgentMonitor
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
- **Agent adapters.** `agent.rs` defines `AgentAdapter` (`ADAPTER_API_VERSION` 1): `plan()` returns the extra launch arguments, `extract()` reduces a raw hook payload to event name, native session ID and sub-type, `interpret()` turns that into a state. Only Claude Code has a real adapter; the other seven are `LaunchOnly` and always show "State unknown".
- **Claude Code wiring.** A new launch adds `--session-id <uuid>` (NEXUS picks the ID, so nothing is scraped and concurrent sessions cannot mix) and `--settings '{"hooks":…}'` for that launch only; the user's own Claude settings are not touched. If the user's arguments already contain `--session-id`, `--resume`/`-r` or `--continue`/`-c`, the adapter adds no session flag. "Continue conversation" launches with `--resume <id>`; it is offered only once `agent_resumable` is set, which happens on the first `UserPromptSubmit` (resuming an empty conversation fails).
- **Signal path.** Each hook runs `nexus agent-hook claude` (the app binary; `main.rs` returns before Tauri starts, about 12 ms). It appends one line such as `{"event":"Stop","agent_session_id":"…"}` to the file named by `NEXUS_AGENT_EVENTS`, which is `agent-events/<session id>.jsonl` in the app-data dir. Prompts, tool input and output are never written. `AgentMonitor` polls those files every 250 ms, keeps the state in memory and calls back into `lib.rs`, which stores the conversation ID and emits `session-changed`. The directory is wiped at startup and each file is deleted when its process ends.
- **State mapping** (Claude Code hook → state): `SessionStart` → Waiting for input; `UserPromptSubmit`, `PreToolUse`, `PostToolUse` → Working; `Notification` with `permission_prompt` → Needs permission, with `idle_prompt` or `elicitation_dialog` → Waiting for input; `Stop` → Finished turn. `agentState` and `agentResumed` on `Session` are runtime-only and filled in by `commands::decorate`.
- **Paste guard.** `terminals.ts` listens for `paste` in the capture phase on each terminal's host element, ahead of xterm. A paste containing a line break is handed to the guard set by `App.tsx`, which shows a confirm dialog and then calls `terminals.paste(id, text, true)`. "If unsafe" skips the dialog when the program has enabled bracketed paste (`term.modes.bracketedPasteMode`).
- **Shortcuts** are handled in one capture-phase `keydown` listener in `App.tsx`. Modifier is ⌘ on macOS and Ctrl+Shift elsewhere. Full table in `README.md`.
- **Data location.** `database.sqlite` in the OS app-data dir for identifier `dev.nexus-codename.desktop` (macOS: `~/Library/Application Support/dev.nexus-codename.desktop/`). Delete it to reset.

## Requirement coverage

Done (PRD P0 unless noted): FR-002, 003, 004, 010–014, 020–025, 027–029, 040–044, 060–064, 110–112 (dashboard), 130, 131, 150; multi-line paste confirmation (PRD 7.4) with an Always / If unsafe / Never policy in Settings; P1 extras: FR-133 (find in scrollback), FR-140 branch name only, FR-017 (missing folder shown, "Locate folder…" relinks it and moves session folders that were inside the old root).

Partial:

- FR-026 / FR-151: per-session name, colour and font size (session menu; `session.font_size`, migration 2). No per-session font family, cursor or theme.
- FR-025: resize by mouse and keyboard, reorder tabs by drag. No pane reordering or moving a pane between tabs.
- FR-001: builds exist but are unsigned.
- FR-045 / FR-065 / FR-066 / FR-069: done for Claude Code only (versioned adapter, session ID, continue conversation, state from hooks). Codex and the other six agents launch but have no state or resume wiring.

Not started:

- P0 leftovers: secret redaction in logs (SEC-004; there is no logging yet).
- Agents: notifications (FR-067), custom agent profiles (FR-068).
- Project config `.nexus/workspace.json` and the trust flow (FR-152–156).
- Remote: hosts, SSH, tmux persistence, metrics (FR-080–107). `Session.host` exists and is always `"local"`.
- Keychain / secret store (SEC-001–003). Nothing stores secrets yet.
- Settings import/export, multi-window, auto-update, custom keybindings, scrollback persistence.
- Web app and cloud sync (PRD Phase 4).

## Suggested order of work

1. ~~Verify on macOS and fix what's wrong.~~ Done except the visual checks listed above.
2. ~~Finish P0: multi-line paste confirmation, relink action for a missing folder, per-session font size.~~ Done.
3. Agent awareness (PRD Phase 2, architecture gate 4). Adapter trait, Claude Code session ID / resume / hook-based state are in. Remaining:
   - Check the in-app flow by hand if the "Agent awareness check" section below still says it is open.
   - Notifications (FR-067) on the transitions to Needs permission and Finished turn while the window is not focused (`tauri-plugin-notification`).
   - Codex adapter. `codex resume <SESSION_ID>` exists (codex-cli 0.156.1) and `-c notify=[…]` should give turn-complete events with the thread ID, but it could not be spiked here: on this machine every Codex turn fails with "model is not supported when using Codex with a ChatGPT account", so no event ever fired. Do not wire it from documentation alone.
   - Custom agent profiles (FR-068).
4. Project config and trust flow.
5. Remote hosts (PRD Phase 3): do the SSH spike first (native Rust library vs. OpenSSH subprocess, PRD 9.9), then keychain, then tmux-backed sessions.
6. Signing and notarisation for macOS once an Apple Developer ID is available.

## Agent awareness check

Spiked against Claude Code 2.1.328 on macOS with real runs (`claude -p`):

- `--session-id <uuid>` is honoured and every hook reports that ID; `--resume <id>` continues the same conversation under the same ID (`SessionStart` arrives with `source: "resume"`).
- Hooks passed through `--settings` fire alongside the user's own, and the environment of the launching process reaches the hook command.
- With the real `nexus agent-hook claude` helper as the hook command, a run that used one tool produced `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd`, each as a line holding only the event name and session ID.

Open: the same thing inside the running app (state label changing in the pane header, tab and sidebar; "Continue conversation" after a restart) and the `permission_prompt` / `idle_prompt` notifications, which need an interactive session.

## Known rough edges

- Menus (new session, session options, workspace options) close on an outside click but not on Escape.
- `data-tauri-drag-region` only applies to the element that carries it, so every non-interactive child of the top bar needs the attribute.
- No frontend tests and no end-to-end tests; `layout.ts` is pure and easy to cover first.
- The replay ring can start mid escape sequence after 512 KB, so a re-attached view may show a brief glitch.
- Each PTY read is sent to the UI as its own message; no batching or backpressure.
- A hook is a process launch of the app binary. It is quick, but `PreToolUse`/`PostToolUse` fire for every tool call.
- If the app binary moves while an agent is running (an update, or macOS app translocation), that agent's hooks stop reporting and its state stays at the last value.
- The hook command is quoted for a POSIX shell; the Windows form (`"path" agent-hook claude`) is untested.
- Agent and shell detection runs on every "new session" (`detect_shells` / `detect_agents` are not cached).
- A database open failure at startup aborts the app with no dialog.
- Each CI run creates a new pre-release (`build-N`); old ones are not cleaned up.
- The rules of the PRD's module layout (`domain/`, `ports/`, `adapters/`) are not followed yet; the Rust code is five flat modules. Introduce the ports when the second implementation of something arrives (SSH transport, agent adapters).
