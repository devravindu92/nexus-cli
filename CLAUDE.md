# NEXUS

Local-first desktop terminal workspace for shells and AI coding agents. Tauri 2 + Rust core + React/TypeScript UI + xterm.js. NEXUS is a codename.

- Product spec: `docs/PRD.md` (requirement IDs like FR-044 refer to it)
- Current status, verified/unverified areas and next steps: `docs/HANDOFF.md` — read it before starting work, and update it when you finish a chunk.

## Commands

- `npm install` — frontend dependencies
- `npm run tauri dev` — run the app with hot reload
- `npm run build` — type-check and build the frontend (must pass before committing)
- `cd src-tauri && cargo test` — Rust unit tests (must pass before committing)
- `npm run tauri build` — release bundle for the current OS

## Rules that come from the spec

- Never claim process persistence. A local PTY dies with the app. Workspace restoration, terminal restoration, process reattachment and agent continuation are four different things with different labels (PRD 3.3).
- Session state must be truthful and text-labelled, never colour alone. If an agent's state can't be known from a reliable signal, show `Unknown`; do not guess from terminal text.
- The webview never gets general process execution. Everything goes through the typed commands in `src-tauri/src/commands.rs`. Launch with argument arrays, never concatenated shell strings.
- No secrets in SQLite, project config, logs or activity. Credentials belong in the OS keychain.
- Local-first: no account, no network calls, no telemetry.
- Terminal output is not persisted. The replay buffer in `pty.rs` is in-memory only.
- Database changes are append-only migrations in `MIGRATIONS` in `db.rs`; never edit an existing entry.

## Git and releases

- Develop on branch `claude/pensive-franklin-fbguni` unless told otherwise.
- Every push that touches non-Markdown files runs `.github/workflows/build.yml`, which builds macOS/Linux/Windows installers and publishes a pre-release tagged `build-<run number>`.
