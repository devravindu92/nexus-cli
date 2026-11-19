# NEXUS handoff

State of the project as of 19 November 2026 (after the second cloud session, which followed the local macOS session), written so a new session can continue without the earlier conversation. `CLAUDE.md` has the short rules; this file has the detail.

## Where things are

- Repo: `devravindu92/nexus-cli`, branch `claude/pensive-franklin-fbguni` (the only branch; there is no `main` yet).
- Every push that touches non-Markdown files builds installers and publishes a pre-release `build-N`. `build-3` is the last build the owner tested on macOS (commit `9525a5f`); everything under "Added in the second cloud session" below is newer and has not been opened on a Mac. List builds with `gh release list`.
- The macOS build is unsigned and not notarised. It must be copied to Applications and cleared with `xattr -cr /Applications/NEXUS.app`, otherwise macOS kills it at launch.
- Spec: `docs/PRD.md`. What exists: PRD Phase 1 (local terminal workspace), Phase 2 for Claude Code (agent awareness, notifications, project config and trust), Phase 3 (remote machines over SSH with tmux persistence and metrics) apart from the items under "Requirement coverage", and a resource-use view the owner asked for. Phase 4 (web app and cloud sync) is not started.

## What the owner cares about

Said during the macOS session, in addition to the PRD:

- **Low memory use.** NEXUS itself should stay light, and the user must be able to see what every terminal costs and close the ones they don't need. The dashboard's Resource use panel is the first version; see "Memory baseline" for the current numbers and where to cut.
- They install the release builds to try them, so a broken or confusing first launch matters (see the quarantine note above).

## Continuing in a cloud (Linux) session

- Linux build prerequisites are the ones CI installs: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`, plus Node 22+ and Rust stable.
- There is no display. The earlier cloud session ran the real app under Xvfb and drove it by keyboard; that works for anything that does not need a person's eyes.
- Verifiable there: `cargo test`, `npm run build`, the app under Xvfb, and everything in `agent.rs`, `usage.rs`, `db.rs`, `pty.rs` through unit tests. `usage.rs` uses `sysinfo`, which works on Linux; on Linux the web view runs as child processes of the app, so "NEXUS itself" includes it without the macOS-only call.
- Not verifiable there: anything macOS- or Windows-specific (window chrome, menus, Finder launch, signing, ConPTY). Write it, say clearly in this file that it is unchecked, and leave it for a local session.
- Agent work needs the real CLI. If `claude` is installed and signed in, the spike commands under "Agent awareness check" can be repeated (each run spends a little of the account's usage). If it is not, stay within what the unit tests cover and do not change the hook mapping from documentation alone.
- A NEXUS started from inside a Claude Code session inherits that session's environment. Terminals strip it (`platform::terminal_env_remove`), but keep it in mind when something behaves differently "inside Claude Code" than from a normal launch.

## What has and hasn't been verified

Verified by running the real app on Linux (Xvfb, keyboard-driven) and by 26 Rust unit tests:

- App start, onboarding, shell and agent detection
- New tab, split right, split down, PTY sizing follows the pane
- Exit code reporting, close, recently closed, restore as a new process
- Restart recovery: layout restored, sessions shown as Recoverable
- Command palette, dashboard, activity feed, dark theme
- Heavy output (1.5 million lines in about 0.5 s), truecolor

Verified on macOS 26.3 (Apple Silicon) on 19 November 2026, by driving the dev build through the accessibility API (System Events), synthetic mouse events and checking side effects (files written by the shell, SQLite rows, child processes). No screenshots were possible, so "verified" here means behaviour, not appearance:

- `cargo test` (26 tests) and `npm run build` pass locally
- Window chrome: traffic lights sit at `trafficLightPosition {16, 24}`, vertically centred on the 44 px top bar (the default position was 6 px too high); the window drags by the top bar and the sidebar header; double-click on the top bar zooms
- Menu: App / Edit / Window only; ⌘W closes the focused pane and the window stays; ⌘Q quits and no child process survives
- ⌘T, ⌘D, ⌘⇧D; PTY size follows the pane (131x43 full, 63x20 after two splits)
- ⌘V pastes into the shell; double-click selects a word and ⌘C copies it
- Native folder picker (opens as a sheet) for adding a workspace and for relinking one
- Agent and shell detection; Claude Code and Codex both start and stay running, including when the app is started with a Finder-style minimal environment (`env -i`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`), which exercises `platform.rs::login_shell_path`
- Restart recovery (sessions come back as Recoverable, tab order kept), "Start as new process", tab drag-to-reorder
- The `build-1` release `.dmg`: the app is killed at launch (exit 137) while the quarantine flag is set, and runs normally once it is cleared with `xattr -cr`. Nothing in the code is wrong; it needs signing and notarisation (last step below)

- A release bundle opened with `open NEXUS.app` (a real LaunchServices launch, not from a shell) starts and shows the dashboard
- The three P0 additions in the running app: the multi-line paste dialog holds the text until confirmed and a single line pastes straight through; per-session font size is saved and resizes the PTY grid (131x43 → 106x38 at 16 px); "Locate folder…" relinks a missing workspace
- The Resource use panel against `ps`: per-session memory, NEXUS's own row including the WebKit helpers

### Added in the second cloud session (Linux only)

Verified by running the real app under Xvfb and by unit tests (41 Rust tests):

- Database migration from schema 1 straight to 4 on an existing database.
- Remote machine dialog: add, save, the sidebar and dashboard lists. A real `ssh` probe to a closed port is reported as "Unreachable" with SSH's own message, in the dashboard and the sidebar.
- A remote session to an unreachable machine ends as "Disconnected", keeps SSH's error text in the pane, and offers "Connect again (new process)".
- The tmux command lines NEXUS generates, run through a local `sh` against a real tmux 3.4 (`remote::tests::tmux_commands_behave_as_promised`): create in a folder whose name contains a quote and spaces; the session survives the client being killed; reattach reaches the same shell (a variable set earlier is still there) without a duplicate; attach-only exits 3 and creates nothing once the session is gone.
- Argument quoting through the remote shell layers (`program_arguments_survive_the_remote_shell`).
- Project config: banner, review dialog, "Trust and start" starts the listed sessions in the right folders; after editing the file the banner says it changed and nothing can be started without a new review.
- Custom agent added from Settings; settings export through the native save dialog; import/export merge logic by unit test.
- A process that exits at once (for example a failing `ssh`) is shown as exited with its output, not as running.
- Closing a session sends no input to it (`pty::tests::closing_a_session_sends_no_input`; the test fails on the old writer with `[10, 4]`).

**Not verified, and why:**

- **No real SSH connection has ever succeeded from NEXUS.** The cloud environment refused to let a local SSH server be started, so everything past "ssh could not connect" is unproven end to end: a successful connection test, metrics from a live machine, an interactive remote shell, tmux over SSH, password / passphrase / host-key prompts inside the pane, jump hosts, key files, agent forwarding. The pieces are covered separately (argv building, quoting, tmux behaviour, output parsing, failure classification), but the first real connection should be watched. `NEXUS_TEST_SSH=<host or alias> cargo test live_host_probes` runs the probes against a machine you can reach without a prompt; that test has never been run either.
- Metrics parsing was checked against Linux-style output only. On a macOS remote, load and CPU count should appear and memory should read "unavailable".
- Desktop notifications: the code path runs only when a Claude Code session changes state while the window is unfocused, which could not be produced here (no signed-in agent, no notification service). Never seen on any platform. macOS will ask for notification permission on first use.
- The settings import button was not exercised through the native open dialog (the scripted dialog mangled the typed path); only the merge logic is tested.
- Everything new on macOS and Windows: it compiles in CI, nothing more. On Windows the system `ssh.exe` is used and tmux quoting assumes a POSIX shell on the *remote* side, which holds for Linux/macOS hosts only.
- Light theme for the new screens.

Still unchecked:

- How it looks on macOS: light theme, the terminal rendering of Claude Code / Codex, fonts. The owner was asked to look and had not answered when the session ended
- IME input and wide Unicode in the terminal
- Everything on Windows: ConPTY, WSL distro listing, `.cmd` agent shims via `cmd.exe /d /c`

## Architecture

```
src-tauri/src/
  main.rs       starts the app, or runs the `agent-hook` helper and exits
  lib.rs        app setup, state, macOS menu, agent signal handling, kills PTYs on exit
  agent.rs      AgentAdapter trait and adapters, hook helper, AgentMonitor
  usage.rs      memory / CPU per session process tree and for NEXUS itself (sysinfo)
  remote.rs     RemoteHost, ssh argv, remote command lines, tmux modes, connection test, metrics
  project.rs    .nexus/workspace.json: parse, validate, trust status
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
                       Palette, Modal (input / confirm / closed sessions / settings), Welcome,
                       Remote (machine dialog, remote-session dialog), Project (banner, review)
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
- **Resource use.** `usage_snapshot` is called by the dashboard every 3 s while it is mounted and the window is visible; nothing is sampled otherwise. For each live session it sums the root PID (`pty.rs` keeps it) and all descendants, and names the terminal's foreground process (`MasterPty::process_group_leader`, Unix only). "NEXUS itself" is the app's own tree minus the terminals, plus on macOS the WebKit helper processes the OS holds it responsible for (`responsibility_get_pid_responsible_for_pid`, a private libSystem call; when it finds nothing the row says the web view is not counted). The agent row shows the user's command, not the session and hook flags NEXUS appends.
- **Terminal environment.** `platform::terminal_env_remove()` drops the variables that mark a process as living inside another Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …). Without that, a NEXUS started from a Claude Code terminal made every Claude Code inside it a "child session" that keeps no transcript, so resume failed with "No conversation found".
- **Paste guard.** `terminals.ts` listens for `paste` in the capture phase on each terminal's host element, ahead of xterm. A paste containing a line break is handed to the guard set by `App.tsx`, which shows a confirm dialog and then calls `terminals.paste(id, text, true)`. "If unsafe" skips the dialog when the program has enabled bracketed paste (`term.modes.bracketedPasteMode`).
- **Remote sessions.** `session.host` is `"local"` or a `remote_host.id`; `session.persistence` is `""` or `"tmux"`. For a remote session `program` / `args` / `cwd` describe what runs *on the host* (empty program = its login shell) and `commands::start_remote_process` wraps them: `ssh [-p] [-i] [-J] [-A] -o ServerAliveInterval=30 -t dest 'exec sh -c …'`. The outer layer is POSIX `sh` so it works whatever the remote login shell is; the program and tmux are then started through `"$SHELL" -lc` so the user's PATH applies. No agent adapter is attached to remote agents (hooks would run on the wrong machine), so they show "State unknown".
- **Durable sessions.** The tmux session is named `nexus-<first 12 hex of the session id>`. A first start uses `tmux new-session -A` (create, or attach if it exists). "Reattach" passes `resume = true` to `session_start`, which uses attach-only and exits 3 with a message if the session is gone. `session_close` only detaches unless `end_remote` is set, in which case `tmux kill-session` runs over a second, non-interactive ssh. ssh exits 255 when the connection fails or drops; the UI maps that to "Disconnected" (plain) or "Detached" (tmux).
- **Probes.** `remote::run_batch` runs ssh with `BatchMode=yes` and `ConnectTimeout=8` under a 15 s kill timer, so it can never prompt or hang; `classify` turns stderr into Unreachable / NeedsInteraction / HostKeyUnknown / HostKeyChanged. The exact test and metrics scripts are constants, shown to the user in the machine dialog. Metrics are requested by the dashboard on each machine's own interval while it is mounted and visible; nothing polls otherwise.
- **No secret store.** Passwords and passphrases are typed into the pane when ssh asks; NEXUS stores only the *path* of an identity file. That satisfies SEC-001 by not holding secrets at all, and is why there is no keychain adapter. If a feature ever needs to hold a secret, that is when to add one.
- **Project config.** `project.rs` reads the file fresh every time. Trust is the exact file text stored in `project_trust`; `project_config_start` re-reads the file, compares it with what the UI reviewed (or with the stored text) and refuses on any difference. `deny_unknown_fields` means a file with `env` or anything else unsupported is invalid as a whole.
- **Finished output.** When a process ends on its own, `pty.rs` keeps its replay ring in `finished` until the session is closed or started again, so the pane can still show why a command failed. In memory only, at most 512 KB per exited session.
- **Terminal writer.** `pty::input_writer` duplicates the PTY handle instead of using `take_writer`, whose Unix writer types newline + Ctrl-D into the terminal when dropped. Through ssh or tmux that reached the far side on every close.
- **Shortcuts** are handled in one capture-phase `keydown` listener in `App.tsx`. Modifier is ⌘ on macOS and Ctrl+Shift elsewhere. Full table in `README.md`.
- **Data location.** `database.sqlite` in the OS app-data dir for identifier `dev.nexus-codename.desktop` (macOS: `~/Library/Application Support/dev.nexus-codename.desktop/`). Delete it to reset.

## Web companion (PRD Phase 4, first slice)

What exists is the PRD's "cloud metadata mode" only, one-way: desktops publish, the browser reads.

- **Server:** `cloud/` — Node 22, plain `node:http`, one dependency (`pg`), Postgres. `server.js` (routes), `sanitize.js` (the allow-list of what may be stored), `public/` (the web page: vanilla JS, no build step, all server text inserted with `textContent`). Schema is created at boot with `CREATE TABLE IF NOT EXISTS`; there is no migration tool yet.
- **Deployed** on the owner's EasyDev project `demo` as app `nexus-cloud` with database `nexus-db`: https://nexus-cloud-demo.apps.162-35-14-226.sslip.io. To redeploy, get an upload link for the app from EasyDev and run its "folder" command inside `cloud/`. Pushing to GitHub does not deploy it, and changes under `cloud/` do not trigger installer builds.
- **Accounts:** email + password (scrypt), session cookie (HttpOnly, Secure, SameSite=Strict, 14 days), and a required custom header on every state-changing request. Sign-up needs the `SIGNUP_CODE` secret set on the app, so strangers cannot create accounts on the owner's server. There is no email verification and no password reset (no mail service).
- **Devices:** the signed-in user gets a one-time pairing code on the web (8 characters, 10 minutes, single use) and types it into the desktop, which receives a device token. Tokens and session tokens are stored hashed. Revoking a device on the web clears its token and deletes what it published; the next upload gets 401 and the desktop pauses itself with a message.
- **Sync:** the desktop sends its whole published state with a revision number (`PUT /api/sync/state`); the server keeps it only if the revision is newer, so retries and late arrivals are harmless. There is no outbox, no per-record revision, no tombstones and no conflict handling, because nothing can be edited on the web yet. The desktop checks every 30 s while linked and uploads only when the state changed or 2 minutes passed (which is also how the web shows a computer as online).
- **Desktop:** `cloud.rs`, Settings → Web companion. Token in the OS keychain via the `keyring` crate; HTTP via `ureq` (both new dependencies, used only by this feature). The user can see the exact JSON that is sent, choose workspaces, leave out machine names, pause, delete their synced data, and unlink.

Verified: the server's routes with curl against the live deployment (sign-up code, pairing, single-use codes, the allow-list dropping secret-looking fields, revision rules, revocation, account deletion, security headers); the web page in Chromium with sample data including HTML in names; the desktop sync client against the live server (`cloud::tests::live_sync_against_a_server`, token supplied directly); the Settings section in the running app, including the refusal to link when no keychain is available.

**Not verified:** storing and reading the token in a real keychain. The Linux test machine had none that worked, so a link from the app has never completed on any platform; on macOS expect a keychain prompt the first time. The 30-second background loop was not observed uploading in a running app.

Not built (PRD 5.7): live terminal access from the browser and the session broker, the remote connector, two-way sync with conflicts, editing from the web, session expiry controls beyond the fixed 14 days, step-up confirmation, multi-user sharing. Rate limits are in memory, so they reset on restart and assume one instance.

## Requirement coverage

Done (PRD P0 unless noted): FR-002, 003, 004, 010–014, 020–025, 027–029, 040–044, 060–064, dashboard 110–112, 130, 131, 150; multi-line paste confirmation (PRD 7.4). P1/P2 done: FR-005 / FR-157 (settings export and import), FR-017 (relink), FR-018 / FR-093 (remote folder per workspace and machine), FR-050 in part (scrollback size setting), FR-067 / FR-120–123 (notifications with per-kind switches; see "Not verified"), FR-068 (custom agents), FR-080–083, FR-085, FR-087–092, FR-094–098, FR-101–105 (remote machines; see "Not verified"), FR-084 (agent forwarding, opt-in with a warning), FR-086 (host keys: left entirely to OpenSSH, changed keys reported and never bypassed), FR-133, FR-152–156 (project config and trust), dashboard FR-113–117 in part.

Partial:

- FR-026 / FR-151: per-session name, colour and font size. No per-session font family, cursor or theme.
- FR-025: resize by mouse and keyboard, reorder tabs by drag. No pane reordering or moving a pane between tabs.
- FR-001: builds exist but are unsigned.
- FR-045 / FR-065 / FR-066 / FR-069: Claude Code only. Codex and the others launch but have no state or resume.
- FR-097: agents can be launched on a remote machine, with no state and no resume.
- FR-124: a notification does not take you to the session when clicked (the desktop notification plugin has no click callback).
- FR-140: branch name only, no working-tree status.
- FR-154: the file is validated by the Rust types; no JSON Schema file is published.
- FR-155: startup sessions are reviewed before they run; there is no diff view of what changed since the last approval.
- Resource use (owner request): dashboard table per running session plus NEXUS itself. No history, alerts or per-pane display.

Not started:

- SEC-004 secret redaction in logs (there is still no logging), diagnostic export.
- FR-006 multi-window, FR-007 auto-update, FR-030 duplicate session, FR-031 drag between workspaces, FR-032 custom keybindings, FR-046 scrollback persistence, FR-051.
- FR-099 / FR-100 remote companion, FR-106 / FR-107 extra metrics and alerts, FR-141 / FR-143 / FR-145 port detection and forwarding, FR-142 open in editor.
- The rest of the web side (see "Web companion" above for what exists): live terminal access, two-way sync, the remote connector.

## Suggested order of work

1. **Try a real remote machine from a Mac** (see "Not verified"): connection test, a shell, a durable session (disconnect Wi-Fi, reattach), close with "Detach" and with "End remote session", a password-protected key, a machine with a new host key. Fix what turns up. This is the largest unproven area.
2. Check a notification actually appears on macOS, and the new screens in light theme.
3. Memory (owner priority). Scrollback now defaults to 5,000 lines (was 10,000) and is a setting. Still to do: profile the app process, and consider disposing xterm instances of workspaces that are not on screen.
4. Codex adapter, once a Codex CLI that can complete a turn is available to spike against. Do not wire it from documentation alone.
5. Smaller PRD items from "Not started": duplicate session, open in editor, working-tree status, custom keybindings.
6. Signing and notarisation for macOS once an Apple Developer ID is available; auto-update depends on it.
7. Web companion: link a real Mac first (keychain path is unverified), then decide whether live terminal access is wanted at all; it is the part with the largest security surface.
8. Business and release decisions: see the research document the owner has (open-source the app, paid hosted companion, signing and update process). The repository still has no licence file, SECURITY.md or updater.

## Agent awareness check

Spiked against Claude Code 2.1.328 on macOS with real runs (`claude -p`):

- `--session-id <uuid>` is honoured and every hook reports that ID; `--resume <id>` continues the same conversation under the same ID (`SessionStart` arrives with `source: "resume"`).
- Hooks passed through `--settings` fire alongside the user's own, and the environment of the launching process reaches the hook command.
- With the real `nexus agent-hook claude` helper as the hook command, a run that used one tool produced `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd`, each as a line holding only the event name and session ID.

Checked inside the running app on macOS: a Claude Code session started from NEXUS gets `--session-id` and the hooks; the label goes Waiting for input → Finished turn after a prompt, in the pane header, tab and sidebar; after ⌘Q and a relaunch, "Continue conversation" starts `claude --resume <id>`, the hook reports `source: "resume"` and the pane shows "Conversation continued".

Open: the Working and Needs permission labels were not observed live (the test prompt finished too quickly and used no tool), nor were the `permission_prompt` / `idle_prompt` notifications.

## Memory baseline

Release build on macOS 26.3 (Apple Silicon), opened from the bundle, dashboard showing, no terminal running: about 300 MB in total, of which about 125 MB is the app process and the rest is the WebKit helper processes. Not yet profiled. The second cloud session did not measure memory on macOS; on Linux (debug build, Xvfb, one terminal) the main process was about 157 MB, which is not comparable with the figure above. It added: a scrollback setting defaulting to 5,000 lines, up to 512 KB of kept output per exited session until it is closed, and no new background polling (machine metrics run only while the dashboard is open). Things to look at first if this needs to come down: each xterm keeps its scrollback in the web view, every session keeps a 512 KB replay ring in the core, and terminals of hidden tabs and workspaces stay alive.

## Known rough edges

- `tauri-plugin-notification` was added for FR-067. It is the only new dependency of the second cloud session.
- A remote host that is removed leaves its sessions' rows deleted but tmux sessions on the machine running; there is no list of orphaned `nexus-*` tmux sessions in the UI (`host_tmux_sessions` exists in the backend, unused).
- Imported preferences only take effect after a restart.
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
- The rules of the PRD's module layout (`domain/`, `ports/`, `adapters/`) are not followed yet; the Rust code is flat modules. Introduce the ports when the second implementation of something arrives (SSH transport, agent adapters).
