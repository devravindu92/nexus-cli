import { createContext, useContext } from "react";
import type {
  ActivityEvent,
  AgentProfile,
  AppInfo,
  NewSession,
  ProjectConfigStatus,
  RemoteHost,
  Session,
  ShellProfile,
  Workspace,
} from "./api";
import type { SplitDir, WorkspaceLayout } from "./layout";
import type { PastePolicy } from "./terminals";
import type { ThemePref } from "./themes";

export type Placement = "tab" | SplitDir;

export type ModalState =
  | {
      kind: "input";
      title: string;
      label?: string;
      initial?: string;
      placeholder?: string;
      confirmLabel?: string;
      onSubmit: (value: string) => void;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      /** Optional literal text shown in a monospace block (e.g. a paste preview). */
      detail?: string;
      confirmLabel?: string;
      danger?: boolean;
      onConfirm: () => void;
      /** A second, different way to proceed (e.g. end vs. detach). */
      altLabel?: string;
      onAlt?: () => void;
    }
  | { kind: "host"; host: RemoteHost | null }
  | { kind: "remote-session"; host: RemoteHost; placement: Placement }
  | { kind: "project"; workspace: Workspace; status: ProjectConfigStatus }
  | { kind: "closed" }
  | { kind: "settings" }
  | null;

export interface AppContext {
  info: AppInfo;
  isMac: boolean;
  shells: ShellProfile[];
  agents: AgentProfile[];
  workspaces: Workspace[];
  sessions: Session[];
  layouts: Record<string, WorkspaceLayout>;
  activity: ActivityEvent[];
  view: string; // "dashboard" or a workspace id
  activeWorkspace: Workspace | null;
  gitBranch: string | null;
  themePref: ThemePref;
  fontSize: number;
  pastePolicy: PastePolicy;
  focusTick: number;
  findFor: string | null;
  hosts: RemoteHost[];
  /** Raw preferences, for settings that need no dedicated state. */
  prefs: Record<string, string>;

  setView: (view: string) => void;
  addWorkspace: () => void;
  updateWorkspace: (ws: Workspace) => void;
  removeWorkspace: (ws: Workspace) => void;
  relinkWorkspace: (ws: Workspace) => void;
  newSession: (spec: Omit<NewSession, "workspaceId">, placement?: Placement) => void;
  runCommandPrompt: (placement?: Placement) => void;
  closeSession: (id: string) => void;
  /** Start a new process; `resume` asks an agent to continue its saved conversation. */
  startSession: (id: string, resume?: boolean) => void;
  renameSession: (s: Session) => void;
  setSessionAccent: (id: string, accent: string | null) => void;
  setSessionFontSize: (id: string, size: number | null) => void;
  restoreClosed: (s: Session, resume?: boolean) => void;
  focusSession: (id: string) => void;
  setLayout: (workspaceId: string, fn: (l: WorkspaceLayout) => WorkspaceLayout) => void;
  setModal: (m: ModalState) => void;
  setPaletteOpen: (open: boolean) => void;
  setThemePref: (pref: ThemePref) => void;
  setFontSize: (size: number) => void;
  setPastePolicy: (policy: PastePolicy) => void;
  setFindFor: (id: string | null) => void;
  refreshAgents: () => void;
  setPref: (key: string, value: string) => void;
  setAgentList: (agents: AgentProfile[]) => void;
  saveHost: (host: RemoteHost) => Promise<RemoteHost>;
  removeHost: (host: RemoteHost) => void;
  refreshHosts: () => void;
  /** Add sessions started by the backend (project config) to the workspace. */
  adoptSessions: (sessions: Session[]) => void;
  toast: (text: string) => void;
}

export const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
}

export interface StateInfo {
  label: string;
  icon: string;
  cls: string;
  detail: string;
}

/** Truthful, text-labelled session state (never colour alone). */
export function describeState(s: Session): StateInfo {
  const remote = s.host !== "local";
  const durable = remote && s.persistence === "tmux";
  if (durable && s.state === "running")
    return {
      label: "Running · tmux",
      icon: "●",
      cls: "st-running",
      detail:
        "Runs inside tmux on the remote machine. It keeps running if the connection drops or NEXUS quits, but not if that machine restarts.",
    };
  if (durable && (s.state === "recoverable" || (s.state === "exited" && s.exitCode === 255)))
    return {
      label: "Detached",
      icon: "⇄",
      cls: "st-recoverable",
      detail:
        "Not connected. The tmux session may still be running on the remote machine; reattach to find out.",
    };
  if (remote && s.state === "exited" && s.exitCode === 255)
    return {
      label: "Disconnected",
      icon: "⇄",
      cls: "st-failed",
      detail: "The SSH connection failed or dropped. The remote process ended with it.",
    };
  if (remote && s.state === "recoverable")
    return {
      label: "Recoverable",
      icon: "◌",
      cls: "st-recoverable",
      detail:
        "The connection closed when NEXUS quit and the remote process ended with it. It can be started again as a new process.",
    };
  switch (s.state) {
    case "running":
      return s.restored
        ? {
            label: "Restored",
            icon: "↻",
            cls: "st-restored",
            detail: "Running as a new process started from saved settings. The earlier process was not resumed.",
          }
        : { label: "Running", icon: "●", cls: "st-running", detail: "Process is running." };
    case "exited":
      return {
        label: s.exitCode != null && s.exitCode !== 0 ? `Exited (${s.exitCode})` : "Exited",
        icon: "■",
        cls: s.exitCode ? "st-failed" : "st-exited",
        detail: "The process has ended.",
      };
    case "recoverable":
      return {
        label: "Recoverable",
        icon: "◌",
        cls: "st-recoverable",
        detail: "The process ended when NEXUS quit. Its settings were kept and it can be started again as a new process.",
      };
    default:
      return { label: "Closed", icon: "×", cls: "st-exited", detail: "Closed." };
  }
}

/**
 * What a running agent is doing, from the agent CLI's own signals only.
 * Anything NEXUS cannot know is labelled as unknown rather than guessed.
 * Returns null for sessions that are not running agents.
 */
export function describeAgent(s: Session, agents: AgentProfile[]): (StateInfo & { attention: boolean }) | null {
  if (s.kind !== "agent" || s.state !== "running") return null;
  const profile = agents.find((a) => a.id === s.profileId);
  const name = profile?.name ?? "This agent";
  switch (s.agentState) {
    case "working":
      return { label: "Working", icon: "◐", cls: "st-restored", attention: false, detail: `${name} is working on a prompt.` };
    case "waiting":
      return { label: "Waiting for input", icon: "▸", cls: "st-recoverable", attention: true, detail: `${name} is waiting for you to type.` };
    case "permission":
      return { label: "Needs permission", icon: "⚠", cls: "st-attention", attention: true, detail: `${name} is blocked until you answer a permission prompt.` };
    case "completed":
      return { label: "Finished turn", icon: "✓", cls: "st-running", attention: true, detail: `${name} finished its turn and is ready for the next prompt.` };
    default:
      return {
        label: "State unknown",
        icon: "?",
        cls: "st-exited",
        attention: false,
        detail:
          profile && !profile.reportsState
            ? `${name} gives NEXUS no reliable signal, so its state is not shown.`
            : `No signal from ${name} yet.`,
      };
  }
}

/** Whether the saved conversation of a stopped agent session can be continued. */
export function canResume(s: Session, agents: AgentProfile[]): boolean {
  return (
    s.kind === "agent" &&
    s.agentResumable &&
    !!s.agentSessionId &&
    !!agents.find((a) => a.id === s.profileId)?.canResume
  );
}

/** Where a session runs, for the always-visible local / remote label. */
export function hostLabel(s: Session, hosts: RemoteHost[]): string {
  if (s.host === "local") return "Local";
  return hosts.find((h) => h.id === s.host)?.name ?? "Removed machine";
}

export function kindLabel(s: Session, agents: AgentProfile[]): string {
  if (s.kind === "agent") return agents.find((a) => a.id === s.profileId)?.name ?? "Agent";
  if (s.kind === "command") return "Command";
  return "Terminal";
}

export function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}
