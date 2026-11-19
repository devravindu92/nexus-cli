# NEXUS
## Product Requirements Document and Solution Architecture
**Working title:** NEXUS  
**Document version:** 1.0  
**Date:** 19 November 2026  
**Status:** Draft for product and architecture review  
**Product category:** Cross-platform AI terminal workspace and remote development environment manager

---

## 1. Executive summary

NEXUS is a premium, cross-platform desktop application that brings developer terminals, AI coding agents, project workspaces, remote development machines, session history, terminal customization and development workflows into one focused workspace.

It is not intended to be a full IDE. Its primary responsibility is to make terminal-based development and multi-agent work easier to organise, observe, recover and control.

A developer should be able to open NEXUS, select a project, start several normal terminal and AI-agent sessions, connect to local or remote development machines, understand what each session is doing, and return to work after an application restart or network interruption.

The product is local-first. The desktop application and its core features must work without a NEXUS cloud account. Remote connectivity is initiated by the user's device to configured hosts. Cloud synchronisation, if introduced later, must be opt-in and must never be required for local terminal operation.

### Product promise

**One calm workspace for every terminal, agent, project and development machine.**

### Product principles

1. Terminal-first, not IDE-first.
2. Local-first and privacy-conscious by default.
3. Cross-platform behaviour with platform-specific adapters where required.
4. Session state must be explicit and truthful. A restored UI is not the same as a restored process.
5. Remote machines are first-class environments, not merely SSH connection shortcuts.
6. Secure-by-design handling of credentials, commands and project configuration.
7. Progressive disclosure: simple defaults, advanced controls when needed.
8. Extensible agent and connection integrations without coupling the core to one vendor.

---

## 2. Product goals and measurable outcomes

### 2.1 Goals

- Provide one application for local and remote terminal work.
- Organise many terminal and AI-agent sessions by project and environment.
- Support Claude Code, OpenAI Codex and other terminal-based coding agents.
- Make session state, agent attention and machine health visible.
- Restore useful workspace state after application restart or crash.
- Support durable remote processes through a remote multiplexer or equivalent session host.
- Provide high-quality terminal rendering and interaction on macOS, Linux and Windows.
- Keep the interface simpler and more approachable than traditional terminal multiplexers.

### 2.2 Success measures

The following are proposed product targets and must be validated through usability and performance testing.

| Measure | Initial target |
|---|---:|
| Cold application launch | < 3 seconds on a reference developer laptop |
| Switch between already-running sessions | < 150 ms perceived response |
| Create a local terminal session | < 1 second after shell startup |
| Create a remote session on a healthy LAN/VPN | < 3 seconds, excluding host-side setup |
| Recover workspace metadata after crash | 100% of committed metadata |
| Restore a saved layout | < 2 seconds for 20 panes, excluding process startup |
| Concurrent sessions | 30 supported in MVP validation; architecture should not impose an arbitrary low cap |
| Idle application CPU | Target < 3% on reference hardware, excluding active remote metrics polling |
| Credential exposure | No secrets in logs, project JSON, crash reports or analytics |
| Supported platforms | macOS, Ubuntu Linux, Windows 11; Windows 10 compatibility to be evaluated |

Targets are engineering goals, not guarantees until measured on named reference hardware.

---

## 3. Scope

### 3.1 In scope

- Native desktop application for macOS, Linux and Windows.
- A browser-based NEXUS Web application, delivered in Phase 2.
- Secure user sign-in, device registration and cloud synchronisation, delivered in Phase 2.
- Local project workspaces and terminal sessions.
- Multiple terminal panes, tabs and saved layouts.
- AI CLI launch profiles, detection and status indicators.
- Agent notifications and attention states.
- Session metadata, history and recovery.
- Per-user, per-project and per-session configuration.
- SSH connection profiles and remote machine management.
- Remote terminal sessions and optional persistent remote sessions.
- Remote machine status and resource monitoring.
- Git status and local development port discovery.
- Secure credential references and platform-native secret storage.
- Portable, documented project configuration.
- Extensible adapters for agents, terminal runtimes and remote providers.

### 3.2 Out of scope for initial releases

- A full source-code editor or replacement for VS Code/IntelliJ.
- Hosting or proxying AI model APIs.
- Replacing Claude Code, Codex or other agent CLIs.
- A cloud service required for Phase 1 local operation.
- Multi-user shared terminal collaboration in the initial web release.
- Browser access to a local machine when no authorised desktop connector is running.
- Unattended remote command execution without explicit user authorisation.
- Fleet orchestration of production infrastructure.
- Arbitrary remote command execution through an internet-facing NEXUS control plane.
- Built-in browser as an MVP dependency.
- Full server configuration management comparable to Ansible or an infrastructure management platform.

### 3.3 Product boundary

NEXUS manages and presents terminal sessions. It does not claim to own every process launched inside a terminal. It must distinguish:

- **Workspace restoration:** restores the UI, pane layout, project association and session metadata.
- **Terminal restoration:** recreates a terminal and shell, optionally replaying safe startup configuration.
- **Process reattachment:** reconnects to an already-running process managed by a persistent session host.
- **Agent continuation:** launches or resumes an AI agent using that agent's supported native conversation/session identifier.

These are separate capabilities and must have separate status labels and acceptance tests.

---

## 4. Users and primary use cases

### 4.1 Primary personas

**Individual software developer**
- Works across multiple repositories.
- Uses several shells, build tools and local development servers.
- Wants quick switching and reliable session recovery.

**AI-assisted developer**
- Runs multiple Claude Code, Codex, Gemini CLI or other agent sessions.
- Needs to see which agent is working, waiting for input, requesting permission or completed.
- Wants to resume conversations without losing the associated project context.

**Remote developer / platform engineer**
- Uses multiple development VMs or Linux servers.
- Connects through SSH, VPN, bastion hosts or jump hosts.
- Needs to monitor machine health and maintain long-running builds, agents and test processes.

**Technical lead**
- Needs an overview of active projects, remote environments and running work.
- Wants to understand which sessions need attention without opening each terminal.

### 4.2 Core user journeys

1. Add an existing project folder and create its first terminal.
2. Start Claude Code or Codex from a project workspace.
3. Split the workspace into several panes and run multiple agents.
4. Assign colours and labels to distinguish sessions.
5. Close and later restore a session.
6. Restart the application and recover the previous workspace layout.
7. Register a remote development server, securely configure SSH access and connect.
8. Start an agent on a remote host and detach from the connection while the process continues, when a persistent remote session host is configured.
9. View all local and remote sessions in a unified dashboard.
10. Identify a disconnected host, failed session or agent waiting for permission.

---

## 5. Functional requirements

Priority definitions:
- **P0:** required for the first usable product release.
- **P1:** important follow-up capability.
- **P2:** advanced or later capability.

### 5.1 Application foundation and onboarding

| ID | Priority | Requirement |
|---|---|---|
| FR-001 | P0 | The application shall provide installable desktop builds for macOS, Ubuntu Linux and Windows. |
| FR-002 | P0 | The application shall start and provide local terminal functionality without requiring account creation or network access. |
| FR-003 | P0 | First-run onboarding shall detect available shells and show a clear setup state. |
| FR-004 | P0 | The application shall support dark and light themes and follow system preference optionally. |
| FR-005 | P1 | The application shall support import/export of user settings. |
| FR-006 | P1 | The application shall support multiple application windows with independent workspace views. |
| FR-007 | P1 | The application shall provide an update mechanism with signed update verification. |

### 5.2 Workspace and project management

| ID | Priority | Requirement |
|---|---|---|
| FR-010 | P0 | Users shall create a workspace from an existing local project folder. |
| FR-011 | P0 | Each workspace shall have a name, root path, icon, accent colour and optional description. |
| FR-012 | P0 | Users shall create multiple terminal sessions within a workspace. |
| FR-013 | P0 | Users shall pin and favourite workspaces. |
| FR-014 | P0 | Users shall group or tag workspaces by project, customer or environment. |
| FR-015 | P1 | Workspaces shall support project-specific settings and default layouts. |
| FR-016 | P1 | Users shall be able to move, archive, remove and re-link a workspace without deleting its project files. |
| FR-017 | P1 | The application shall detect when a project folder is unavailable or has moved and provide a relink action. |
| FR-018 | P1 | A workspace may refer to a local project, a remote project path or a local project associated with a remote execution host. |

### 5.3 Terminal sessions and panes

| ID | Priority | Requirement |
|---|---|---|
| FR-020 | P0 | Users shall create, rename, close and switch terminal sessions. |
| FR-021 | P0 | Users shall launch a configured default shell or select an available shell profile. |
| FR-022 | P0 | Users shall run arbitrary user-selected CLI programs and arguments. |
| FR-023 | P0 | Each session shall retain its working directory, host, shell profile and project association. |
| FR-024 | P0 | Users shall create horizontal and vertical splits and multiple tabs. |
| FR-025 | P0 | Users shall resize, reorder and close panes using mouse and keyboard. |
| FR-026 | P0 | Users shall configure per-session name, accent colour, font, font size, cursor and colour theme. |
| FR-027 | P0 | The terminal shall support copy/paste, selection, searchable scrollback, Unicode and 24-bit true colour. |
| FR-028 | P0 | The application shall support Bash, Zsh, Fish, PowerShell and CMD where installed. |
| FR-029 | P0 | Windows users shall be able to launch native Windows shells and WSL distributions. |
| FR-030 | P1 | Users shall duplicate a session using a safe copy of its launch profile and working directory. |
| FR-031 | P1 | Users shall drag sessions between workspaces and windows. |
| FR-032 | P1 | Users shall configure custom keyboard shortcuts. |
| FR-033 | P1 | The application shall expose terminal progress and title metadata when available through supported terminal protocols. |
| FR-034 | P2 | The terminal shall support inline image protocols where compatible with the chosen engine. |

### 5.4 Session lifecycle, history and recovery

| ID | Priority | Requirement |
|---|---|---|
| FR-040 | P0 | The application shall persist workspace, pane, tab and session metadata continuously. |
| FR-041 | P0 | The application shall maintain a searchable list of recently closed sessions. |
| FR-042 | P0 | Users shall restore a closed session as a new terminal using its saved launch metadata. |
| FR-043 | P0 | On restart, the application shall restore the last open workspace and layout. |
| FR-044 | P0 | The application shall clearly indicate whether a session is running, exited, disconnected, recoverable or restored as a new process. |
| FR-045 | P1 | The application shall support agent continuation using native agent session IDs where the agent exposes a supported resume interface. |
| FR-046 | P1 | The application shall preserve scrollback where technically possible and within configured storage limits. |
| FR-047 | P1 | The application shall detect abnormal application termination and recover the last committed UI state. |
| FR-048 | P1 | The application shall support durable remote sessions through a supported host-side multiplexer or session service. |
| FR-049 | P1 | The application shall reconnect to an existing durable remote session without starting a duplicate process. |
| FR-050 | P1 | Users shall be able to configure retention limits for closed-session metadata and scrollback. |
| FR-051 | P2 | Users may export/import session metadata, excluding secrets by default. |

**Critical constraint:** A local PTY child process generally cannot be assumed to survive application exit, OS logout or reboot. The product must not promise process persistence unless a dedicated persistent process host owns that process. A remote tmux session can survive SSH client disconnection, but not necessarily host reboot. Recovery behaviour must be documented per runtime.

### 5.5 AI agent integration

Initial built-in agent profiles:
- Claude Code
- OpenAI Codex CLI
- Gemini CLI
- OpenCode
- Cursor Agent
- GitHub Copilot CLI
- Aider
- Goose

| ID | Priority | Requirement |
|---|---|---|
| FR-060 | P0 | Users shall be able to launch Claude Code and Codex using configurable command profiles. |
| FR-061 | P0 | Agent profiles shall define executable, arguments, environment overrides, working directory rules and detection strategy. |
| FR-062 | P0 | Users shall be able to run multiple instances of the same or different agents concurrently. |
| FR-063 | P0 | Agent profiles shall use the CLI's existing authentication by default. NEXUS shall not require users to paste provider API keys. |
| FR-064 | P0 | The UI shall distinguish a normal terminal from a terminal launched with a known agent profile. |
| FR-065 | P1 | The application shall detect agent state such as working, waiting for input, permission required, completed, failed or unknown when reliable signals are available. |
| FR-066 | P1 | Agent adapters shall support native conversation/session ID capture and resume where the CLI provides a documented interface. |
| FR-067 | P1 | The application shall provide completion and attention notifications. |
| FR-068 | P1 | Users shall be able to define custom agent profiles and launch arguments. |
| FR-069 | P1 | Agent integrations shall use a versioned adapter interface. |
| FR-070 | P2 | Third-party developers shall be able to add agent adapters through a documented plugin API. |

**Agent state accuracy:** Do not infer authoritative agent states from terminal text alone. Use documented CLI hooks, structured output, process metadata or explicit user-defined patterns. If confidence is insufficient, show `Unknown` rather than a misleading state.

### 5.6 Remote machine and SSH management

Remote machines are a first-class part of the product and must be represented in the same workspace/session model as local environments.

#### Remote host registration

| ID | Priority | Requirement |
|---|---|---|
| FR-080 | P0 | Users shall register remote development machines with a friendly name and environment label. |
| FR-081 | P0 | A remote host profile shall support hostname/IP, port, username and connection options. |
| FR-082 | P0 | The application shall support SSH key authentication and passphrase-protected keys. |
| FR-083 | P0 | The application shall support password authentication only through secure secret storage and shall not persist plaintext passwords. |
| FR-084 | P1 | The application shall support SSH agent forwarding only as an explicit, clearly explained opt-in. |
| FR-085 | P1 | The application shall support SSH config aliases, ProxyJump/bastion hosts and custom identity files. |
| FR-086 | P1 | The application shall verify and remember host keys using known-hosts semantics. Host-key changes shall trigger a blocking security warning. |
| FR-087 | P1 | Users shall test connectivity before saving or connecting. |
| FR-088 | P1 | Users shall group hosts by project, customer, environment, region or tags. |
| FR-089 | P1 | Users shall view last connected time, current connection state and recent connection errors. |
| FR-090 | P1 | Users shall edit, disable, duplicate and remove remote host profiles without deleting remote data. |

#### Remote sessions and projects

| ID | Priority | Requirement |
|---|---|---|
| FR-091 | P0 | Users shall open an interactive SSH terminal to a registered host. |
| FR-092 | P0 | Users shall create multiple concurrent sessions on one or more remote hosts. |
| FR-093 | P1 | Users shall associate a remote working directory with a project workspace. |
| FR-094 | P1 | Users shall choose whether a remote session is ephemeral or backed by a persistent remote multiplexer. |
| FR-095 | P1 | Where configured, NEXUS shall create, list, attach and detach named remote sessions through a host adapter. |
| FR-096 | P1 | NEXUS shall detect and explain when a remote host does not have the required multiplexer or helper installed. |
| FR-097 | P1 | Users shall be able to run remote AI agents in remote project directories. |
| FR-098 | P1 | Remote session reconnection shall not create duplicate sessions when an existing durable session can be identified. |
| FR-099 | P2 | NEXUS may provide an optional lightweight remote companion/agent for richer metrics and session lifecycle control. |
| FR-100 | P2 | Remote host bootstrap shall be explicit, reviewable and reversible where possible. No silent privileged installation. |

#### Remote machine status and metrics

| ID | Priority | Requirement |
|---|---|---|
| FR-101 | P1 | The application shall display reachability and SSH connection status. |
| FR-102 | P1 | The application shall display CPU, memory, disk and uptime when collected through an approved method. |
| FR-103 | P1 | The application shall display active NEXUS-managed sessions per host. |
| FR-104 | P1 | Users shall configure metric polling intervals and disable polling per host. |
| FR-105 | P1 | The application shall distinguish host reachability from metrics-agent availability. |
| FR-106 | P2 | The application may display network throughput and selected process information. |
| FR-107 | P2 | Users may configure low-disk, high-memory and host-unreachable alerts. |

**Remote monitoring principle:** Basic SSH connectivity should not require installing a daemon. Rich metrics may use a low-privilege, on-demand command or an optional companion agent. The product must disclose what is executed and what information is collected.

### 5.7 Web application, identity and cloud synchronisation (Phase 2)

NEXUS Web is a browser-based companion to the desktop application. It provides access to cloud-synchronised metadata and, when an authorised connector is online, interactive access to local or remote terminal sessions.

| ID | Priority | Requirement |
|---|---|---|
| FR-108 | P2 | Users shall be able to sign in to NEXUS Web using a secure identity provider. |
| FR-109 | P2 | Users shall be able to register, name, view and revoke trusted desktop and remote connector devices. |
| FR-110 | P2 | NEXUS shall synchronise selected workspace, project metadata, layouts, session metadata, host profiles without secrets, preferences and activity metadata between SQLite and the cloud database. |
| FR-111 | P2 | Users shall be able to view their synced workspaces and dashboards from a browser. |
| FR-112 | P2 | Users shall be able to view live local sessions through an authenticated, online desktop connector. |
| FR-113 | P2 | Users shall be able to view and interact with remote sessions through an authorised desktop or remote connector. |
| FR-114 | P2 | The web UI shall clearly show whether a connector is online, offline, stale or revoked. |
| FR-115 | P2 | Users shall be able to revoke a device or connector and invalidate its active access tokens. |
| FR-116 | P2 | Sync shall support offline desktop operation and reconcile changes when connectivity returns. |
| FR-117 | P2 | Sync shall detect and present conflicts for incompatible edits rather than silently overwriting important configuration. |
| FR-118 | P2 | Users shall be able to configure which workspaces and metadata are synchronised. |
| FR-119 | P2 | Terminal input/output and sensitive environment values shall not be stored in the cloud database by default. |
| FR-120 | P2 | Remote command execution initiated from the web shall be subject to explicit authorisation, device trust and auditable policy checks. |
| FR-121 | P2 | The web application shall support session access expiry, idle timeout and explicit session termination. |
| FR-122 | P2 | The system shall support secure multi-device access for one user, with device-level revocation. |

#### Web access modes

1. **Cloud metadata mode:** Works when the desktop and remote connectors are offline. Users can inspect synced projects, layouts, host inventory, session history metadata and activity summaries.
2. **Live desktop mode:** Requires the desktop application to be running and connected. The browser can request access to sessions that the desktop user has authorised for web access.
3. **Remote connector mode:** An optional connector running on an approved remote machine/network can provide access when the user's desktop is offline. This must be an explicit opt-in deployment with its own identity, permissions, updates and revocation.

The web app must never expose a raw SSH private key or cloud credential to browser JavaScript. A web terminal should connect to a brokered session stream over an authenticated, encrypted channel. The broker validates user identity, device trust, session ownership and permissions before relaying terminal data.

#### Synchronisation behaviour

- SQLite remains the desktop's fast local store and supports offline work.
- PostgreSQL is the cloud system of record for synchronised account-level metadata.
- Desktop writes are first committed locally and recorded in an outbox.
- The sync worker uploads idempotent changes and applies server changes using versioned records.
- Use stable UUIDs, per-record revisions, timestamps and tombstones.
- Define conflict policies by entity type. Preferences may use field-level merge; layouts/configuration should surface conflicts when edits cannot be safely merged.
- Runtime session state and terminal output are not synchronised as ordinary relational rows.
- Secrets remain in local OS vaults. If remote credentials are ever needed by a remote connector, use a separate secrets design with short-lived, scoped credentials and explicit user consent.
- Provide controls to pause sync, choose synced workspaces and delete cloud-synced data.

#### Important availability constraint

A browser cannot access a laptop's local PTY or filesystem merely because the user has signed in. For live access, the desktop connector must be running and reachable through an outbound authenticated connection, or an approved remote connector must be online. NEXUS must communicate this clearly in the UI.

### 5.8 Dashboard and activity centre

| ID | Priority | Requirement |
|---|---|---|
| FR-110 | P0 | The home dashboard shall show active workspaces and active sessions. |
| FR-111 | P0 | The dashboard shall show local versus remote session counts. |
| FR-112 | P0 | The dashboard shall show session states and agent attention indicators. |
| FR-113 | P1 | The dashboard shall show registered, online, offline and unreachable remote hosts. |
| FR-114 | P1 | The dashboard shall show CPU, memory and disk status for remote hosts where metrics are available. |
| FR-115 | P1 | The dashboard shall show recent activity such as session started, session ended, host connected and agent needs attention. |
| FR-116 | P1 | Users shall filter dashboard information by workspace, host, environment and state. |
| FR-117 | P1 | The dashboard shall show failed connections and recovery actions. |
| FR-118 | P2 | The dashboard may show detected development ports and build/test process summaries. |

Suggested dashboard cards:
- Active sessions
- Agents needing attention
- Local sessions
- Remote sessions
- Online remote machines
- Unreachable machines
- Recent activity
- Resource health
- Recently used workspaces

### 5.9 Notifications

| ID | Priority | Requirement |
|---|---|---|
| FR-120 | P1 | The application shall notify users when a supported agent completes. |
| FR-121 | P1 | The application shall notify users when an agent requires permission or input, when reliably detectable. |
| FR-122 | P1 | The application shall provide unread/attention indicators in the sidebar. |
| FR-123 | P1 | Users shall configure notification types and per-agent preferences. |
| FR-124 | P1 | Selecting a notification shall navigate to the relevant session. |
| FR-125 | P2 | Notifications shall support quiet hours and per-workspace overrides. |

### 5.10 Search, command palette and navigation

| ID | Priority | Requirement |
|---|---|---|
| FR-130 | P0 | The application shall provide keyboard-first navigation and a command palette. |
| FR-131 | P0 | Users shall search workspaces and active sessions. |
| FR-132 | P1 | Users shall search recently closed sessions and saved layouts. |
| FR-133 | P1 | Users shall search terminal scrollback within the active session. |
| FR-134 | P1 | Users shall invoke common actions without navigating nested settings pages. |
| FR-135 | P2 | Global search may index selected local metadata and terminal history, subject to privacy and retention settings. |

### 5.11 Development integrations

| ID | Priority | Requirement |
|---|---|---|
| FR-140 | P1 | The application shall display Git branch and working-tree status for supported repositories. |
| FR-141 | P1 | The application shall detect common local development ports and associate them with workspaces. |
| FR-142 | P1 | Users shall open project folders in a configured external editor. |
| FR-143 | P1 | Users shall open detected local development URLs in the system browser. |
| FR-144 | P2 | The application may provide an embedded browser panel. |
| FR-145 | P2 | The application may support port forwarding for remote development hosts. |

### 5.12 Configuration and customization

Configuration precedence:
1. Built-in defaults.
2. User/global configuration.
3. Project configuration.
4. Session-level overrides.

| ID | Priority | Requirement |
|---|---|---|
| FR-150 | P0 | The application shall provide global theme, font and terminal defaults. |
| FR-151 | P0 | Users shall configure per-session visual overrides. |
| FR-152 | P1 | Projects shall support a versioned JSON configuration file. |
| FR-153 | P1 | Project configuration shall not contain secrets. |
| FR-154 | P1 | The application shall validate configuration against a published schema. |
| FR-155 | P1 | Users shall be able to review configuration changes before applying them. |
| FR-156 | P1 | Project startup commands shall require a trust decision before first execution. |
| FR-157 | P1 | Users shall export and import portable settings without exporting credentials by default. |

Suggested project file: `.nexus/workspace.json`  
Suggested user data directory: platform-specific application data directory.  
The project file must be safe to commit to source control and must not contain absolute user-specific secrets or private key material.

---

## 6. User experience and design requirements

### 6.1 Design direction

Visual references:
- Linear: hierarchy, spacing and restrained colour.
- Raycast: command palette and keyboard-first workflows.
- Arc: workspace organisation and contextual controls.
- Modern native macOS applications: polish and predictable interaction.

### 6.2 Main application layout

Proposed primary layout:

```text
+------------------------------------------------------------------+
| NEXUS   Workspace / Project                  Search   Profile     |
+------------------+-----------------------------------------------+
| SIDEBAR          | WORKSPACE                                      |
|                  |                                               |
| Workspaces       |  Project name             Host: Local / DEV    |
|  Project A       |  Git branch / status       Environment         |
|  Project B       |                                               |
|  Project C       |  +----------------------+ +-----------------+  |
|                  |  | Terminal / Agent 1   | | Terminal 2      |  |
| Remote Machines  |  |                      | |                 |  |
|  DEV-01          |  |                      | |                 |  |
|  QA-02           |  +----------------------+ +-----------------+  |
|                  |                                               |
| Sessions         |  +-----------------------------------------+  |
|  API / Claude    |  | Terminal / Agent 3                       |  |
|  Tests           |  |                                         |  |
|  Shell           |  +-----------------------------------------+  |
|                  |                                               |
| Activity         | Status: 3 running | 1 needs attention         |
+------------------+-----------------------------------------------+
```

This is a conceptual layout, not a final visual design.

### 6.3 UX rules

- Keep the sidebar compact and collapsible.
- Show only essential controls by default.
- Use clear icons and labels; do not rely on colour alone for status.
- Preserve terminal screen area.
- Make session switching fast and predictable.
- Provide keyboard shortcuts for all common operations.
- Support accessible contrast, keyboard focus and screen-reader labels.
- Respect OS reduced-motion preferences.
- Avoid modal dialogs for routine actions.
- Make destructive actions explicit and reversible where practical.
- Make local/remote identity visible at all times to prevent commands being run on the wrong host.

### 6.4 Session state visual language

Recommended states:
- Running
- Waiting for input
- Permission required
- Completed
- Failed
- Disconnected
- Exited
- Restored
- Unknown

Each state must have a text label or accessible tooltip, not colour alone.

---

## 7. Security and privacy requirements

Security is a product requirement, not a later enhancement.

### 7.1 Secrets and credentials

| ID | Priority | Requirement |
|---|---|---|
| SEC-001 | P0 | SSH private keys, passphrases and passwords shall never be stored in plaintext application databases or project configuration. |
| SEC-002 | P0 | Use native OS credential storage where available: macOS Keychain, Windows Credential Manager/DPAPI-backed storage, and Linux Secret Service/libsecret where available. |
| SEC-003 | P0 | If secure OS storage is unavailable, fail safely or require an explicitly configured encrypted fallback protected by a user-controlled secret. |
| SEC-004 | P0 | Logs, telemetry, crash reports and diagnostic exports shall redact credentials, tokens and sensitive environment values. |
| SEC-005 | P0 | API keys shall not be requested when an agent CLI already manages its own authentication. |
| SEC-006 | P1 | Credential references shall be separate from host profiles and may be rotated without rewriting project configuration. |
| SEC-007 | P1 | Users shall be able to remove stored credentials and review which host profiles reference them. |

### 7.2 SSH security

- Verify SSH host keys and protect against silent host-key substitution.
- Respect system SSH configuration where possible.
- Never disable host-key checking by default.
- Make agent forwarding opt-in and explain its security implications.
- Avoid storing passwords in command-line arguments or process listings.
- Use restrictive file permissions for any NEXUS-managed files.
- Support modern SSH algorithms through the selected SSH implementation.
- Do not silently modify `~/.ssh/config` or `known_hosts`.

### 7.3 Command execution and project trust

- Treat project configuration as untrusted until the user trusts the project.
- Show startup commands and environment changes before first execution.
- Do not automatically run arbitrary commands from a newly opened project.
- Apply allowlists/scopes to any application command execution bridge.
- Keep shell execution in the Rust/native layer; do not expose unrestricted process execution directly to the webview.
- Validate arguments and avoid shell-string concatenation where argument arrays are possible.
- Clearly distinguish commands executed locally from commands executed remotely.
- Require confirmation for destructive or privileged operations initiated by NEXUS.

### 7.4 Environment variables and clipboard

- Do not persist secret environment values in plaintext session history.
- Redact known secret patterns in diagnostic output where possible.
- Do not capture clipboard contents automatically.
- Warn before pasting multi-line commands into a terminal, with a user-configurable policy.
- Do not transmit terminal output to any cloud service by default.

### 7.5 Cloud and web security (Phase 2)

- Enforce TLS for all browser/API/connector communication.
- Use short-lived, scoped access tokens; rotate refresh tokens and support immediate device revocation.
- Require explicit pairing/approval before a new desktop or remote connector can expose sessions to an account.
- Bind live session access to user, device, connector, workspace and session permissions.
- Do not expose connector ports directly to the public internet by default; connectors should establish outbound connections to the broker.
- Apply rate limits, session limits, abuse detection and audit logging to web terminal access.
- Provide an explicit per-device switch to disable web access to local sessions.
- Require re-authentication or step-up confirmation for sensitive operations such as destructive commands or credential changes.
- Do not store SSH private keys, passwords or agent API tokens in PostgreSQL.
- Consider end-to-end encryption for selected synced sensitive configuration in a later security design. The product must not claim E2E encryption unless key management and recovery have been implemented and audited.
- Terminal data should be treated as sensitive. Do not retain live terminal streams by default; any recording feature requires separate opt-in, retention controls and clear disclosure.

### 7.6 Local-first privacy

- No mandatory account.
- No mandatory cloud backend.
- No telemetry by default unless explicitly approved in product policy; if introduced, make it opt-in and disclose its contents.
- Remote host data remains in local application storage unless the user explicitly enables a future sync service.
- Provide a clear data export and delete workflow.

---

## 8. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Performance | Terminal input must feel immediate; application UI must not block on process, SSH or filesystem operations. |
| NFR-002 | Performance | Terminal output rendering shall remain responsive during large log streams and rapid output. |
| NFR-003 | Reliability | Session metadata and layout changes shall be committed transactionally. |
| NFR-004 | Reliability | A failed terminal or SSH adapter shall not crash the whole application. |
| NFR-005 | Reliability | The app shall recover from network loss and allow reconnection without duplicate durable sessions. |
| NFR-006 | Portability | Core domain logic shall be platform-independent; OS process/PTY and credential functions shall be implemented behind adapters. |
| NFR-007 | Security | Follow secure development practices and use OWASP ASVS as a security design/testing reference where applicable. |
| NFR-008 | Privacy | Core local workflows shall function offline. |
| NFR-009 | Accessibility | Main workflows shall be keyboard accessible and meet WCAG 2.2 AA principles where applicable to the desktop UI. |
| NFR-010 | Maintainability | Agent, terminal and remote-host integrations shall have versioned interfaces and contract tests. |
| NFR-011 | Observability | Internal logs shall be structured, local-first and redact secrets. |
| NFR-012 | Compatibility | Support common Unicode, terminal control sequences, mouse reporting and modern TUI applications. |
| NFR-013 | Resource usage | Idle background polling shall be bounded and configurable. |
| NFR-014 | Upgradeability | Database schema migrations shall be versioned, tested and recoverable. |
| NFR-015 | Packaging | Release artifacts shall be signed where supported and checksums published. |
| NFR-016 | Sync | Desktop shall remain usable offline; cloud unavailability shall not block local terminal work. |
| NFR-017 | Sync | Sync operations shall be idempotent and support retry after network interruption. |
| NFR-018 | Cloud security | All cloud and connector communication shall use authenticated encrypted transport. |
| NFR-019 | Web availability | Web UI shall distinguish synced metadata availability from live connector availability. |
| NFR-020 | Data minimisation | Cloud storage shall contain only data needed for explicitly enabled sync and web features. |

---

## 9. Recommended solution architecture

### 9.1 Architecture decision

Recommended starting point: **Tauri 2 + React + TypeScript + Rust** for desktop, plus a separately deployed **React/TypeScript web application** and a cloud backend introduced in Phase 2.

The desktop client remains a modular monolith with explicit ports and adapters. The cloud backend should be a modular service/API initially, not a collection of premature microservices. The web application and desktop application share typed API contracts and selected UI/domain models, but privileged process and secret operations remain in the native desktop/connector layer.

This is appropriate for a local-first desktop product with native process management, OS credential integration and a web-based UI. Tauri's security model and capability permissions must be configured narrowly. Its shell plugin should not be exposed as an unrestricted general-purpose command API to the frontend.

### 9.2 Logical architecture

```text
+--------------------------------------------------------------+
|             NEXUS Desktop: React / TypeScript UI              |
|  Sidebar | Workspace | Terminal Grid | Dashboard | Settings   |
+------------------------------+-------------------------------+
                               |
                     Typed Tauri Commands/Events
                               |
+------------------------------v-------------------------------+
|                     Rust Application Core                    |
|                                                              |
| Workspace Domain     Session Domain       Agent Domain        |
| Layout Domain        Remote Host Domain   Notification Domain |
| Configuration        Search/History       Activity Domain     |
|                                                              |
| Ports / Interfaces:                                          |
| TerminalRuntime | AgentAdapter | RemoteTransport | SecretStore|
| MetricsProvider | Persistence  | NotificationProvider         |
+------------------------------+-------------------------------+
                               |
+------------------------------v-------------------------------+
|                         Adapters                             |
|                                                              |
| Local PTY       SSH Transport      OS Keychain               |
| Terminal Engine Agent CLI Profiles SQLite                   |
| tmux/Host Agent Remote Metrics    OS Notifications           |
| Git/Port Scan   Filesystem         WSL / ConPTY               |
+------------------------------+-------------------------------+
                               |
               Local OS / WSL / Remote Development Hosts
```

### 9.3 Architectural style

- Modular monolith for the desktop application.
- Domain-driven boundaries around workspace, session, agent, remote host and configuration.
- Hexagonal architecture for operating-system and provider integrations.
- Event-driven internal updates for session state and dashboard activity.
- SQLite as the local source of truth for metadata.
- JSON for portable project configuration.
- Async execution for all I/O and process operations.
- No separate backend microservices for the initial product.

### 9.4 Phase 2 cloud and web architecture

```text
 Desktop App                         Browser
+----------------------+       +----------------------+
| React Desktop UI     |       | NEXUS Web UI         |
| Rust Core            |       | React / TypeScript   |
| SQLite               |       +----------+-----------+
| Local PTY / SSH      |                  |
| OS Secret Vault      |          HTTPS / WebSocket
+----------+-----------+                  |
           | outbound authenticated       |
           | sync + live-session channel  |
           +---------------+--------------+
                           |
                 +---------v----------+
                 | Cloud API / Gateway|
                 | Identity / Devices |
                 | Sync / Policy      |
                 | Live Session Broker|
                 +----+-----------+---+
                      |           |
               +------v--+   +----v----------------+
               |Postgres |   | Connector Registry  |
               |Metadata |   | Presence / Routing  |
               +---------+   +----+----------------+
                                  |
                    +-------------+-------------+
                    |                           |
             Desktop Connector           Optional Remote
             (local machine)             Connector
                    |                           |
              Local PTYs                 Remote hosts / tmux
```

#### Cloud components

- **Identity and device service:** user sign-in, sessions, trusted device registration and revocation.
- **Cloud API:** validates access and exposes metadata/sync operations.
- **Sync service:** accepts idempotent change batches and returns changes since a cursor.
- **PostgreSQL:** stores account-level metadata, device registry, sync revisions and audit records.
- **Live session broker:** authorises and routes encrypted terminal streams between browser clients and connected desktop/remote connectors.
- **Presence service:** tracks connector online/offline/last-seen state.
- **Notification service:** delivers web notifications and optionally push notifications in later releases.

#### Recommended cloud technology direction

- PostgreSQL for cloud metadata and account state.
- SQLite for local desktop metadata and offline cache.
- HTTPS REST or typed RPC for account, device and sync operations.
- WebSocket (or another authenticated bidirectional transport) for live terminal streams and presence.
- Short-lived access tokens with refresh-token rotation and device revocation.
- A durable server-side change log/outbox for sync.
- Object storage only if a future feature requires user-controlled file/artifact sync. Do not use it for terminal streams.

The cloud backend should not execute shell commands itself. It authenticates and authorises the request, then routes it to an online trusted connector. The connector enforces local policy and executes within the selected local or remote runtime.

### 9.5 Suggested Rust module boundaries

```text
src-tauri/
  src/
    app/
      commands/
      events/
      lifecycle/
    domain/
      workspace/
      session/
      layout/
      agent/
      remote_host/
      activity/
      configuration/
    ports/
      terminal_runtime.rs
      remote_transport.rs
      agent_adapter.rs
      secret_store.rs
      metrics_provider.rs
      notification_provider.rs
      repository.rs
    adapters/
      terminal/
      ssh/
      agents/
      secrets/
      persistence/
      platform/
      metrics/
      notifications/
    security/
      command_policy.rs
      redaction.rs
      project_trust.rs
    infrastructure/
      logging/
      migrations/
      filesystem/
```

Frontend modules should mirror product domains rather than duplicate backend business logic.

### 9.6 Terminal engine strategy

Do not write a terminal emulator from scratch for the first release.

The selected terminal engine must provide:
- Mature VT parsing and screen model.
- PTY integration or a clean integration boundary.
- Searchable scrollback.
- True colour and Unicode support.
- Mouse reporting and alternate screen support.
- Good performance with high-volume output.
- Cross-platform compatibility.
- A licence compatible with the intended distribution model.

Candidate evaluation:
- **xterm.js:** mature terminal frontend with a broad ecosystem; requires a robust native PTY bridge and careful performance validation in a WebView.
- **Alacritty ecosystem/components:** Rust-native terminal implementation and GPU-rendering experience; assess reuse boundaries and licence/maintenance implications rather than assuming the full application can be embedded.
- **WezTerm:** strong reference implementation for cross-platform terminal and multiplexer behaviour; assess whether its architecture is reusable for this product.
- **Other Rust terminal cores:** evaluate parser completeness, rendering integration, licensing, maintenance and Windows support.

The terminal engine choice is an architecture gate. Build a small technical spike before committing.

### 9.7 PTY and process lifecycle

Use platform-specific adapters:
- macOS/Linux: PTY through well-maintained Rust libraries and OS facilities.
- Windows: ConPTY for native Windows shells.
- WSL: launch and manage WSL distributions through the Windows host integration, while treating the Linux process environment as a distinct execution target.

A session manager owns the lifecycle contract, not the UI. It must handle spawn, resize, input, output, exit, termination, cancellation and cleanup.

Do not rely on the Tauri shell plugin alone as a complete interactive PTY/terminal solution. It is a process-spawning API, not a full terminal emulator or durable multiplexer.

### 9.8 Persistent sessions

Use a provider abstraction with explicit capability reporting:

```text
SessionPersistenceProvider
  - create()
  - list()
  - attach()
  - detach()
  - terminate()
  - get_status()
  - get_capabilities()
```

Initial provider candidates:
- Local ephemeral PTY provider.
- Remote tmux provider on Unix-like hosts.
- Optional remote companion service for richer cross-platform lifecycle management.
- Windows-native persistent process host to be evaluated separately.

The application must show a capability label for each host, such as:
- Ephemeral terminal only
- Remote tmux persistence available
- NEXUS companion available
- Agent resume supported
- Scrollback restore available

Never claim a process will survive a local app exit unless the provider can demonstrate it.

### 9.9 SSH and remote architecture

Use a dedicated SSH transport adapter in Rust. Evaluate native SSH libraries against OpenSSH subprocess integration.

Prefer respecting existing OpenSSH configuration, host keys and user workflows. A native library may simplify terminal streaming and cross-platform packaging, while OpenSSH integration may provide stronger compatibility with user configuration. The prototype must compare:
- Host-key verification.
- ProxyJump and bastion support.
- Agent/key support.
- Keyboard-interactive authentication.
- Windows packaging.
- Cancellation and reconnect behaviour.
- Licence and maintenance.
- Terminal stream correctness.

Remote machine metrics should initially use low-privilege, bounded commands or an optional companion. Avoid installing a privileged daemon just to read basic CPU/memory/disk statistics.

### 9.10 Persistence and data model

SQLite stores local metadata. Suggested entities:

- `Workspace`
- `WorkspaceHostBinding`
- `RemoteHost`
- `CredentialReference`
- `Session`
- `SessionRuntime`
- `AgentProfile`
- `AgentRun`
- `AgentConversationReference`
- `Pane`
- `Layout`
- `ClosedSession`
- `ActivityEvent`
- `HostMetricSnapshot`
- `ProjectTrustDecision`
- `UserPreference`

Separate durable metadata from volatile runtime state. Store agent conversation IDs as references, not as a substitute for the agent's own conversation storage.

Use SQLite transactions, foreign keys, schema migrations and appropriate indexes. Consider SQLite FTS for local search if terminal-history indexing is enabled.

### 9.11 Data storage layout

Illustrative layout:

```text
Application data/
  nexus/
    database.sqlite
    config/
      settings.json
      keybindings.json
    logs/
    cache/
    exports/

Project/
  .nexus/
    workspace.json
    layouts/
      default.json
```

Secrets must be held in the OS credential vault. Project configuration should contain credential identifiers/references only when safe and portable, never credential values.

### 9.12 Dashboard metrics model

Every metric must include:
- Source (local OS, SSH command, companion agent).
- Timestamp.
- Collection status.
- Staleness indicator.
- Units.
- Optional error information.

Do not present stale values as live. Display `Last updated` and `Unavailable` states.

---

## 10. Technology evaluation and architecture gates

The proposed stack is a strong starting point, but the following decisions must be validated.

| Area | Initial recommendation | Validation required |
|---|---|---|
| Desktop shell | Tauri 2 | Packaging, multi-window, OS integration, WebView behaviour |
| UI | React + TypeScript | Terminal rendering performance and accessibility |
| Core | Rust | Async lifecycle, process management and adapter boundaries |
| Terminal frontend | xterm.js or evaluated Rust-native engine | TUI compatibility, Unicode, input latency, output throughput |
| GPU rendering | Evaluate terminal engine capability | Do not promise GPU acceleration until measured in all targets |
| Local process | Native PTY adapter | macOS/Linux PTY, Windows ConPTY, WSL |
| Remote | SSH transport adapter | OpenSSH config, host keys, jump hosts, auth methods |
| Persistent sessions | tmux adapter first for remote Unix hosts | Attach/detach/reconnect, resize, scrollback and host failure |
| Metadata | SQLite | Migration, crash recovery, concurrent reads/writes |
| Project config | Versioned JSON | Schema, trust and portability |
| Secrets | Native OS vault | macOS, Windows and Linux availability/fallback |
| Metrics | Local OS APIs / bounded remote commands | Permissions, cost, accuracy and staleness |
| Observability | Structured local logs; OpenTelemetry-compatible internal model | Avoid telemetry by default |

### Architecture gate 1: terminal prototype

Before implementing the full UI, prove:
- Interactive Bash, Zsh, Fish, PowerShell, CMD and WSL where installed.
- Vim, less, top/htop, Claude Code and Codex interaction.
- Resize behaviour.
- Unicode and East Asian width.
- Mouse reporting and alternate screen.
- High-volume output and memory stability.
- Copy/paste and keyboard shortcuts.
- macOS, Ubuntu and Windows parity.

### Architecture gate 2: process persistence

Prove separately:
- App window close.
- Application process exit.
- OS logout.
- Network disconnect.
- Remote SSH reconnect.
- Remote host reboot.

Document what survives each event. Do not conflate these scenarios.

### Architecture gate 3: remote host

Prove:
- SSH keys and encrypted keys.
- Host-key verification.
- SSH config aliases.
- ProxyJump/bastion.
- Password and keyboard-interactive authentication.
- Multiple remote sessions.
- tmux create/list/attach/detach.
- Connection interruption and reconnection.
- Basic CPU, memory and disk metrics.

### Architecture gate 4: agent integration

Prove:
- Claude Code launch and session ID capture/resume.
- Codex launch and supported resume behaviour.
- Permission/attention state detection using supported signals.
- Agent version compatibility and graceful fallback.
- Multiple concurrent instances without cross-session state leakage.

---

## 11. API and internal event contracts

The desktop application does not require a public network API for MVP. Use typed internal commands and events across the Tauri boundary.

Example command groups:
- `workspace_create`, `workspace_list`, `workspace_update`
- `session_create`, `session_close`, `session_restore`, `session_list`
- `terminal_write`, `terminal_resize`, `terminal_subscribe`
- `agent_launch`, `agent_resume`, `agent_get_status`
- `remote_host_create`, `remote_host_test`, `remote_host_connect`
- `remote_session_list`, `remote_session_attach`, `remote_session_detach`
- `layout_save`, `layout_restore`
- `dashboard_get_snapshot`, `activity_list`

Example event types:
- `session.created`
- `session.output`
- `session.state_changed`
- `session.exited`
- `agent.state_changed`
- `agent.attention_required`
- `remote_host.connected`
- `remote_host.disconnected`
- `remote_host.metrics_updated`
- `activity.created`

All event payloads should include stable identifiers, timestamps and schema versions. Terminal output should use a streaming channel and must not be persisted by default without an explicit history setting.

---

## 12. Error handling and recovery

The UI shall provide actionable errors for:
- Shell not installed.
- Project folder missing.
- Permission denied.
- SSH authentication failure.
- Host-key mismatch.
- Host unreachable.
- Remote helper/multiplexer unavailable.
- Agent CLI missing or unsupported version.
- Agent resume unsupported.
- Database migration failure.
- Terminal process exited unexpectedly.
- Disk full or scrollback retention limit reached.

Recovery actions should be context-specific:
- Retry connection.
- Edit host settings.
- Open SSH diagnostics.
- Install or configure a supported multiplexer manually.
- Restore as a new terminal.
- Resume using the agent's native session ID.
- Re-link project folder.
- Export diagnostic report with secrets redacted.

A host-key mismatch must not have a casual “ignore” default action.

---

## 13. Testing strategy

### 13.1 Automated tests

- Rust unit tests for domain logic and state transitions.
- Adapter contract tests for PTY, SSH, secret store and agent providers.
- Database migration and recovery tests.
- React component and interaction tests.
- End-to-end tests for core workspace/session workflows.
- Security tests for command validation, project trust and secret redaction.
- Cross-platform CI on macOS, Ubuntu and Windows.

### 13.2 Compatibility matrix

| Area | macOS | Ubuntu | Windows native | WSL |
|---|---|---|---|---|
| Local terminal | Required | Required | Required | Required |
| Bash/Zsh/Fish | Where installed | Required | Via WSL/Git Bash where installed | Required where installed |
| PowerShell/CMD | Not applicable | Not applicable | Required | Optional |
| SSH client | Required | Required | Required | Optional |
| GPU rendering | Validate | Validate | Validate | Host-rendered UI |
| Agent CLIs | Validate installed CLIs | Validate installed CLIs | Validate installed CLIs | Validate installed CLIs |
| Durable local sessions | Evaluate | Evaluate | Evaluate | Evaluate |
| Remote tmux | Client support | Client support | Client support | Client support |

### 13.3 Manual test scenarios

- Run a long build and close/reopen the application.
- Disconnect Wi-Fi during a remote session.
- Reconnect and verify no duplicate remote process is created.
- Change remote host key and verify blocking warning.
- Open an untrusted project containing startup commands.
- Launch multiple agents in different workspaces.
- Trigger agent permission requests and verify attention indicators.
- Test very large output and scrollback limits.
- Test IME input, Unicode and terminal mouse interaction.
- Fill local disk and verify safe failure.

---

## 14. Delivery roadmap

### Phase 0 — Technical feasibility

Deliverables:
- Tauri 2 desktop shell.
- Rust PTY spike.
- Terminal engine comparison.
- Windows ConPTY and WSL spike.
- SSH connectivity spike.
- Remote tmux persistence spike.
- Claude Code and Codex launch/resume spike.
- Written architecture decision records.

Exit criteria: no unresolved blocker in terminal interaction, process lifecycle or core platform support.

### Phase 1 — P0 desktop terminal workspace

Deliverables:
- Onboarding and shell detection.
- Workspace/project sidebar.
- Local terminal engine.
- Tabs and split panes.
- Session labels, colours and themes.
- Claude Code and Codex launch profiles.
- SQLite metadata persistence.
- Recently closed sessions.
- Workspace/layout restoration.
- Core dashboard with local session state.

### Phase 2 — P1 productivity and agent awareness

Deliverables:
- Agent adapter interface.
- Agent state/attention detection.
- Native notifications.
- Command palette and search.
- Saved layouts.
- Git branch/status.
- Project JSON configuration and trust flow.
- Improved scrollback persistence.

### Phase 3 — Remote development

Deliverables:
- Remote host registry.
- Secure SSH credential references.
- SSH host-key verification.
- Multiple remote sessions.
- Remote project workspaces.
- tmux-backed durable sessions for supported Unix hosts.
- Remote host status and resource metrics.
- Remote agent execution.
- Remote connection dashboard.

### Phase 4 — Web application and cloud synchronisation

Deliverables:
- User identity and sign-in.
- Trusted device registration and revocation.
- Cloud API and PostgreSQL metadata store.
- SQLite-to-cloud sync engine and conflict handling.
- NEXUS Web dashboard and workspace browser.
- Live browser terminal access through an online desktop connector.
- Optional remote connector for desktop-independent remote access.
- Audit logs, session access policy and security review.

### Phase 5 — Advanced ecosystem

Deliverables:
- Remote host registry.
- Secure SSH credential references.
- SSH host-key verification.
- Multiple remote sessions.
- Remote project workspaces.
- tmux-backed durable sessions for supported Unix hosts.
- Remote host status and resource metrics.
- Remote agent execution.
- Remote connection dashboard.

### Phase 5 — Advanced ecosystem

Deliverables:
- Plugin SDK.
- Additional agent integrations.
- Optional remote companion.
- Port forwarding and advanced remote workflows.
- Built-in browser evaluation.
- Advanced automation.
- Optional encrypted device synchronisation, subject to a separate privacy/security design.

---

## 15. MVP acceptance criteria

The MVP is acceptable when all of the following are demonstrated on the supported reference platforms:

1. A user can add an existing project folder.
2. A user can open at least three terminal sessions in one project.
3. A user can split panes and switch sessions using keyboard shortcuts.
4. A user can launch Claude Code and Codex from configured profiles.
5. A user can identify sessions by project, name, colour and agent type.
6. A user can close a session and restore its metadata as a new terminal.
7. The app can restore the previous workspace and pane layout after a normal restart.
8. The UI clearly explains that an ephemeral local process cannot necessarily be resumed after app exit.
9. The dashboard accurately shows active local sessions and agent states where detectable.
10. No SSH/API secret is written to plaintext project configuration or application logs.
11. The application remains responsive during heavy terminal output.
12. Core local terminal functionality works offline and without an account.

Remote management is a P1/P2 expansion in the supplied priority plan, but the architecture must reserve the host/session abstractions from the beginning so it does not require a rewrite.

### Phase 2 web/cloud acceptance criteria

1. A user can sign in to NEXUS Web and see synced workspace and host metadata.
2. Desktop continues to work when offline and synchronises changes after reconnecting.
3. A user can see which desktop/remote connectors are online and revoke a trusted device.
4. A browser can attach to an authorised local session only while the desktop connector is online.
5. A browser can attach to an authorised remote session through an approved online connector.
6. Disconnecting the browser does not accidentally terminate a durable remote process.
7. The cloud database contains no SSH private key, password or raw agent API token.
8. Sync conflicts are handled according to entity-specific policies and are not silently destructive.
9. Terminal streams are encrypted in transit and are not retained by default.
10. A user can disable web access to a device and immediately revoke its active sessions.

---

## 16. Key product decisions still requiring confirmation

| Decision | Recommended default | Reason |
|---|---|---|
| Product name | Keep NEXUS as a working codename only | Search results show heavy existing use of NEXUS/NEXTERM and related names; formal clearance required |
| Local persistence | Ephemeral PTY for MVP; evaluate durable host later | Avoid false process-survival promises |
| Remote persistence | tmux adapter first for Unix-like hosts | Mature detach/reattach model |
| SSH implementation | Compare native Rust SSH library with OpenSSH subprocess | Compatibility versus integration trade-off |
| Terminal renderer | Prototype xterm.js and Rust-native alternatives | Must validate TUI fidelity and GPU performance |
| Cloud | No cloud dependency for MVP | Local-first privacy and reduced operational complexity |
| Remote companion | Optional later feature | Rich metrics and process lifecycle without requiring it for basic SSH |
| Agent status | Adapter-provided, confidence-aware state | Avoid unreliable terminal-text heuristics |
| Project config | Versioned `.nexus/workspace.json` | Portable and reviewable |
| Telemetry | Off by default | Privacy-first product positioning |

---

## 17. Product naming research and recommendation

### 17.1 Assessment of NEXUS

NEXUS is a strong internal codename because it suggests a central connection point. However, it is a highly used technology and product term. Search results also show existing terminal-related products using names such as NEXTERM and NEXORA, and other software products using NEXUS. It is therefore not recommended as a final commercial brand without professional trademark, domain and app-store clearance.

### 17.2 Names checked during preliminary web research

| Candidate | Preliminary finding | Recommendation |
|---|---|---|
| NEXUS | Very generic and heavily used | Working codename only |
| ForgeDeck | Existing developer/AI terminal product found | Avoid |
| TermWeave | Existing terminal-related repositories/projects found | Avoid |
| TermFleet | Existing AI terminal session management project found | Avoid |
| Nexora | Existing developer and AI software products found | Avoid |
| PanePilot | Existing file manager and window management uses found | Avoid |

This is preliminary web research, not a legal trademark search. Search engine absence is not evidence of availability.

### 17.3 Naming direction

The final name should be:
- Distinctive and pronounceable.
- Short enough for an app icon and command-line binary.
- Not a generic term such as Terminal, Nexus or Workstation.
- Not too narrowly tied to SSH or one AI vendor.
- Available as a suitable domain and software brand after clearance.

**Recommendation:** keep **NEXUS** as the project codename while generating and clearing a new coined brand before public launch. Do not commit marketing, package identifiers or trademark filings to the codename yet.

Possible naming territories for a second naming round:
- Orbit / constellation / control centre.
- Weaving / orchestration / connected sessions.
- Craft / forge / workshop.
- Navigation / command / cockpit.

---

## 18. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Terminal engine limitations in WebView | High | Prototype terminal engine before UI expansion |
| Inconsistent Windows PTY behaviour | High | Dedicated ConPTY and WSL feasibility phase |
| False session restoration promise | High | Separate UI restoration, process reattachment and agent resume |
| SSH implementation gaps | High | Test host keys, jump hosts, agent and keyboard-interactive auth early |
| Agent CLI changes | Medium/High | Versioned adapters and graceful unknown-state fallback |
| Unsafe project startup commands | High | Project trust model and command review |
| Credential leakage | Critical | OS vault, redaction tests and security review |
| Remote metrics overhead | Medium | Bounded polling and optional companion |
| Scope expansion into IDE territory | High | Keep product boundary terminal/workspace-focused |
| Product name conflict | Medium | Trademark/domain/app-store clearance before launch |

---

## 19. Reference material

The following references informed the preliminary technical direction. They should be reviewed again during implementation because versions and project status can change.

- Tauri 2 architecture: https://v2.tauri.app/concept/architecture/
- Tauri shell plugin and permissions: https://v2.tauri.app/plugin/shell/
- Alacritty terminal project: https://alacritty.org/
- WezTerm terminal and multiplexer: https://wezterm.org/
- Ubuntu terminal multiplexer guidance: https://ubuntu.com/server/docs/reference/other-tools/terminal-multiplexers/
- tmux documentation: https://github.com/tmux/tmux/wiki
- OpenTelemetry architecture: https://opentelemetry.io/docs/collector/architecture/
- OWASP Application Security Verification Standard: https://owasp.org/www-project-application-security-verification-standard/

---

## 20. Final product definition

NEXUS is a local-first, cross-platform terminal workspace manager with a secure web companion for developers who work across multiple projects, shells, AI coding agents and remote development machines.

Its defining capability is not simply opening many terminals. It is providing a coherent, recoverable and secure model of work across local and remote environments, with a clear view of what is running, what needs attention and where each session lives.

**Build a focused terminal workspace, not another IDE.**
