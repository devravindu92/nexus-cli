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
}

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
  workspaceGitBranch: (id: string) =>
    invoke<string | null>("workspace_git_branch", { id }),

  sessionCreate: (input: NewSession) => invoke<Session>("session_create", { input }),
  sessionStart: (id: string, cols?: number, rows?: number) =>
    invoke<Session>("session_start", { id, cols, rows }),
  sessionList: () => invoke<Session[]>("session_list"),
  sessionListClosed: (search?: string) =>
    invoke<Session[]>("session_list_closed", { search }),
  sessionUpdate: (
    id: string,
    patch: { name?: string; accent?: string; clearAccent?: boolean },
  ) => invoke<Session>("session_update", { id, ...patch }),
  sessionClose: (id: string) => invoke<void>("session_close", { id }),
  sessionForget: (id: string) => invoke<void>("session_forget", { id }),

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
};

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
