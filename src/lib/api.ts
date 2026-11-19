import { Channel, invoke } from "@tauri-apps/api/core";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  icon: string;
  accent: string;
  description: string;
  pinned: boolean;
  tags: string[];
  createdAt: number;
  lastOpenedAt: number;
  pathExists: boolean;
}

export type SessionKind = "shell" | "agent" | "command";
export type SessionState = "running" | "exited" | "recoverable" | "closed";

export interface Session {
  id: string;
  workspaceId: string;
  name: string;
  kind: SessionKind;
  profileId: string | null;
  program: string;
  args: string[];
  cwd: string;
  accent: string | null;
  host: string;
  state: SessionState;
  exitCode: number | null;
  restored: boolean;
  createdAt: number;
  closedAt: number | null;
  /** Terminal font size override in px; null follows the global setting. */
  fontSize: number | null;
  /** The agent CLI's own conversation ID, when its adapter knows it. */
  agentSessionId: string | null;
  /** That conversation has content, so the CLI can be asked to continue it. */
  agentResumable: boolean;
  /** Latest state from the agent's own signals; null means unknown. */
  agentState: AgentState | null;
  /** "" = ends with its connection; "tmux" = runs in tmux on the remote host. */
  persistence: "" | "tmux";
  /** The running process was asked to continue an earlier conversation. */
  agentResumed: boolean;
}

export type AgentState = "working" | "waiting" | "permission" | "completed";

export interface ShellProfile {
  id: string;
  name: string;
  program: string;
  args: string[];
  isDefault: boolean;
}

export interface AgentProfile {
  id: string;
  name: string;
  program: string;
  args: string[];
  available: boolean;
  resolvedPath: string | null;
  canResume: boolean;
  reportsState: boolean;
  /** Added by the user in Settings. */
  custom: boolean;
}

export interface RemoteHost {
  id: string;
  name: string;
  environment: string;
  /** Hostname, IP address or SSH config alias. */
  target: string;
  port: number | null;
  user: string | null;
  identityFile: string | null;
  proxyJump: string | null;
  agentForwarding: boolean;
  tags: string[];
  disabled: boolean;
  metricsEnabled: boolean;
  metricsIntervalSecs: number;
  hasTmux: boolean | null;
  createdAt: number;
  lastConnectedAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export type ProbeStatus =
  | "ok"
  | "unreachable"
  | "needsInteraction"
  | "hostKeyUnknown"
  | "hostKeyChanged"
  | "error";

export interface HostTest {
  status: ProbeStatus;
  message: string;
  os: string | null;
  hasTmux: boolean | null;
}

export interface HostMetrics {
  hostId: string;
  source: string;
  collectedAt: number;
  status: ProbeStatus | null;
  error: string | null;
  os: string | null;
  load1: number | null;
  cpus: number | null;
  memTotalKb: number | null;
  memAvailableKb: number | null;
  diskTotalKb: number | null;
  diskUsedKb: number | null;
  uptimeSecs: number | null;
}

export interface CloudStatus {
  linked: boolean;
  url: string | null;
  deviceName: string | null;
  paused: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface ProjectSession {
  name: string;
  kind: SessionKind;
  command: string[];
  agent: string | null;
  args: string[];
  cwd: string | null;
}

export interface ProjectConfig {
  version: number;
  description: string | null;
  sessions: ProjectSession[];
}

export interface ProjectConfigStatus {
  exists: boolean;
  path: string;
  config: ProjectConfig | null;
  error: string | null;
  trusted: boolean;
  changedSinceTrust: boolean;
}

export interface ActivityEvent {
  id: number;
  ts: number;
  kind: string;
  message: string;
  workspaceId: string | null;
  sessionId: string | null;
}

export interface AppInfo {
  version: string;
  platform: string;
  homeDir: string;
  agentAdapterApi: number;
}

export interface TreeUsage {
  memoryBytes: number;
  /** Percent of one CPU core. */
  cpuPercent: number;
  processCount: number;
}

export interface SessionUsage extends TreeUsage {
  sessionId: string;
  pid: number;
  /** Command line of the program in control of the terminal right now. */
  foreground: string | null;
  /** The session's own root program is in front (a shell at its prompt). */
  atRoot: boolean;
}

export interface UsageSnapshot {
  /** NEXUS itself, without the terminals' processes. */
  app: TreeUsage;
  appIncludesWebview: boolean;
  sessions: SessionUsage[];
}

export interface NewSession {
  workspaceId: string;
  kind: SessionKind;
  profileId?: string;
  program?: string;
  args?: string[];
  name?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** A registered remote machine; omitted = this computer. */
  hostId?: string;
  persistence?: "tmux";
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  shells: () => invoke<ShellProfile[]>("shells_list"),
  agents: () => invoke<AgentProfile[]>("agents_list"),

  workspaceList: () => invoke<Workspace[]>("workspace_list"),
  workspaceCreate: (rootPath: string, name?: string) =>
    invoke<Workspace>("workspace_create", { rootPath, name }),
  workspaceUpdate: (workspace: Workspace) =>
    invoke<Workspace>("workspace_update", { workspace }),
  workspaceRemove: (id: string) => invoke<void>("workspace_remove", { id }),
  workspaceRelink: (id: string, rootPath: string) =>
    invoke<Workspace>("workspace_relink", { id, rootPath }),
  workspaceGitBranch: (id: string) =>
    invoke<string | null>("workspace_git_branch", { id }),

  sessionCreate: (input: NewSession) => invoke<Session>("session_create", { input }),
  sessionStart: (id: string, cols?: number, rows?: number, resume = false) =>
    invoke<Session>("session_start", { id, cols, rows, resume }),
  sessionList: () => invoke<Session[]>("session_list"),
  sessionListClosed: (search?: string) =>
    invoke<Session[]>("session_list_closed", { search }),
  sessionUpdate: (
    id: string,
    patch: {
      name?: string;
      accent?: string;
      clearAccent?: boolean;
      fontSize?: number;
      clearFontSize?: boolean;
    },
  ) => invoke<Session>("session_update", { id, ...patch }),
  sessionClose: (id: string, endRemote = false) =>
    invoke<void>("session_close", { id, endRemote }),
  sessionForget: (id: string) => invoke<void>("session_forget", { id }),

  usageSnapshot: () => invoke<UsageSnapshot>("usage_snapshot"),

  terminalSubscribe: (id: string, onOutput: (bytes: Uint8Array) => void) => {
    const channel = new Channel<unknown>();
    channel.onmessage = (msg) => {
      if (msg instanceof ArrayBuffer) onOutput(new Uint8Array(msg));
      else if (msg instanceof Uint8Array) onOutput(msg);
      else if (Array.isArray(msg)) onOutput(Uint8Array.from(msg as number[]));
      else if (typeof msg === "string") onOutput(new TextEncoder().encode(msg));
    };
    return invoke<boolean>("terminal_subscribe", { id, onOutput: channel });
  },
  terminalWrite: (id: string, data: string) =>
    invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),

  layoutGet: (workspaceId: string) =>
    invoke<string | null>("layout_get", { workspaceId }),
  layoutSave: (workspaceId: string, data: string) =>
    invoke<void>("layout_save", { workspaceId, data }),

  prefsGet: () => invoke<Record<string, string>>("prefs_get"),
  prefSet: (key: string, value: string) => invoke<void>("pref_set", { key, value }),

  activityList: (limit = 30) => invoke<ActivityEvent[]>("activity_list", { limit }),

  customAgentSave: (name: string, program: string, args: string[], id?: string) =>
    invoke<AgentProfile[]>("custom_agent_save", { id, name, program, args }),
  customAgentRemove: (id: string) => invoke<AgentProfile[]>("custom_agent_remove", { id }),

  hostList: () => invoke<RemoteHost[]>("host_list"),
  hostSave: (host: RemoteHost) => invoke<RemoteHost>("host_save", { host }),
  /** Returns the IDs of local session records that were dropped with it. */
  hostRemove: (id: string) => invoke<string[]>("host_remove", { id }),
  hostTest: (host: RemoteHost) => invoke<HostTest>("host_test", { host }),
  hostMetrics: (id: string) => invoke<HostMetrics>("host_metrics", { id }),
  hostTmuxSessions: (id: string) => invoke<string[]>("host_tmux_sessions", { id }),
  hostDisclosure: () => invoke<Record<string, string>>("host_disclosure"),

  projectConfigGet: (workspaceId: string) =>
    invoke<ProjectConfigStatus>("project_config_get", { workspaceId }),
  projectConfigStart: (workspaceId: string, approved?: ProjectConfig) =>
    invoke<Session[]>("project_config_start", { workspaceId, approved }),
  projectConfigUntrust: (workspaceId: string) =>
    invoke<void>("project_config_untrust", { workspaceId }),

  cloudStatus: () => invoke<CloudStatus>("cloud_status"),
  cloudLink: (url: string, code: string, name: string) =>
    invoke<CloudStatus>("cloud_link", { url, code, name }),
  cloudUnlink: () => invoke<CloudStatus>("cloud_unlink"),
  cloudSyncNow: () => invoke<CloudStatus>("cloud_sync_now"),
  cloudDeleteData: () => invoke<CloudStatus>("cloud_delete_data"),
  cloudPreview: () => invoke<string>("cloud_preview"),

  settingsExport: (path: string) => invoke<void>("settings_export", { path }),
  settingsImport: (path: string) => invoke<string>("settings_import", { path }),
};

export function blankHost(): RemoteHost {
  return {
    id: "",
    name: "",
    environment: "",
    target: "",
    port: null,
    user: null,
    identityFile: null,
    proxyJump: null,
    agentForwarding: false,
    tags: [],
    disabled: false,
    metricsEnabled: true,
    metricsIntervalSecs: 60,
    hasTmux: null,
    createdAt: 0,
    lastConnectedAt: null,
    lastCheckedAt: null,
    lastError: null,
  };
}

/** Split a command line into argv without invoking a shell. */
export function parseCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < input.length && !/[a-zA-Z0-9]/.test(input[i + 1])) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
