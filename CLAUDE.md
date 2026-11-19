# NEXUS

Local-first desktop terminal workspace for shells and AI coding agents. Tauri 2 + Rust core + React/TypeScript UI + xterm.js. NEXUS is a codename.

- Product spec: `docs/PRD.md` (requirement IDs like FR-044 refer to it)
- Current status, what is and isn't verified, architecture notes and next steps: `docs/HANDOFF.md`. Read it before starting work and update it when you finish a chunk.

## Commands

- `npm install` — frontend dependencies
- `npm run tauri dev` — run the app with hot reload
- `npm run build` — type-check and build the frontend (must pass before committing)
- `cd src-tauri && cargo test` — Rust unit tests (must pass before committing)
- `npm run tauri build` — release bundle for the current OS (`-- --bundles app` for just the macOS `.app`)

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev patchelf`. `cd cloud && npm test` runs the server's tests. With no display, run the app under Xvfb.

## Where things live

- `src-tauri/src/commands.rs` — every command the UI may call
- `src-tauri/src/pty.rs` — PTYs and child processes; `db.rs` — SQLite and migrations
- `src-tauri/src/agent.rs` — agent adapters, the `agent-hook` helper, state monitor
- `src-tauri/src/usage.rs` — memory / CPU per session and for the app
- `src-tauri/src/remote.rs` — remote machines over the system `ssh`, tmux-backed durable sessions, connection test and metrics
- `src-tauri/src/cloud.rs` — optional web companion: link, keychain token, what is uploaded, sync loop
- `cloud/` — the web companion server (Node 22 + Postgres, no framework) and its web page; deployed separately, see `docs/HANDOFF.md`
- `src-tauri/src/project.rs` — `.nexus/workspace.json` parsing, validation and trust status
- `src-tauri/src/platform.rs` — shell and agent detection, PATH, terminal environment
- `src/App.tsx` — app state, actions and shortcuts; `src/lib/terminals.ts` — xterm instances; `src/lib/layout.ts` — tab and split model

## Rules that come from the spec

- Never claim process persistence. A local PTY dies with the app. Workspace restoration, terminal restoration, process reattachment and agent continuation are four different things with different labels (PRD 3.3). "Continue conversation" is agent continuation in a new process.
- Session state must be truthful and text-labelled, never colour alone. Agent state comes only from the agent CLI's own documented signals (hooks, structured output). Never infer it from terminal text; with no reliable signal, show "State unknown".
- The webview never gets general process execution. Everything goes through the typed commands in `src-tauri/src/commands.rs`. Launch with argument arrays, never concatenated shell strings.
- No secrets in SQLite, project config, logs or activity. Credentials belong in the OS keychain. The web companion's device token is the one secret NEXUS holds: keychain only (`keyring` crate), and linking is refused when no keychain is available.
- What the web companion uploads is defined in one place, `cloud::build_state`, and filtered again by `cloud/sanitize.js` on the server. Names and states only: never commands, arguments, session folders, environment values, terminal output or key paths. Adding a field means changing both and their tests. The server must never be able to make the desktop do anything. The agent hook helper records event names and IDs only, never prompts, tool input or output.
- Local-first: no account needed, no telemetry, and no network calls unless the user has linked the web companion (`cloud.rs`). An unlinked install must stay silent. SSH to machines the user registered is the only other network use.
- Terminal output is not persisted. The replay buffer in `pty.rs` is in-memory only.
- Database changes are append-only migrations in `MIGRATIONS` in `db.rs`; never edit an existing entry. The schema is at version 4.
- Remote machines go through the system `ssh` client only. Never add `StrictHostKeyChecking=no` or any option that weakens host-key checking, never write to `~/.ssh`, and never store or pass a password or passphrase: SSH asks for those in the terminal. Host fields are validated against option injection in `RemoteHost::validate`; keep new fields under the same check.
- A tmux-backed session is the only kind that may be described as surviving a disconnect, and never as surviving a reboot of the host. "Reattach" must attach only (`Tmux::AttachOnly`); it must not create a session.
- `.nexus/workspace.json` is untrusted input. Nothing from it runs without the user approving that exact file content; unknown fields are rejected, not ignored.
- Do not use `MasterPty::take_writer` on Unix. Its writer types newline + Ctrl-D into the terminal when dropped, which an SSH or tmux client forwards to the far side. Use `pty::input_writer`.
- Do not change the user's own agent configuration. Per-launch flags only (for Claude Code: `--session-id`, `--resume`, `--settings`).

## Rules from the owner

- Memory use matters. Do not add background polling or per-session caches without a reason; sample on demand (the resource view only runs while the dashboard is visible). Measure before and after anything that could change the footprint and record it in `docs/HANDOFF.md`.
- Add a dependency only when it earns its place, and say why in the commit.

## Working method

- Verify behaviour before calling something done: run the app or the real CLI, not just the compiler. When that is impossible in the current environment (no macOS, no display, agent CLI not signed in), say so in `docs/HANDOFF.md` under what is unchecked.
- Do not wire an agent integration from documentation alone. Spike it against the real CLI first, as was done for Claude Code; Codex is still launch-only for that reason.
- Keep `README.md` ("What works today", shortcuts) in step with the code.

## Git and releases

- Develop on branch `claude/pensive-franklin-fbguni` unless told otherwise. Commit and push when a chunk of work is done.
- Every push that touches non-Markdown files runs `.github/workflows/build.yml`, which builds macOS/Linux/Windows installers and publishes a pre-release tagged `build-<run number>`. A Markdown-only push builds nothing.
- macOS builds are unsigned: they must be copied to Applications and cleared with `xattr -cr /Applications/NEXUS.app`, or macOS kills them at launch.
