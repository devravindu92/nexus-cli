import { createContext, useContext } from "react";
import type {
  ActivityEvent,
  AgentProfile,
  AppInfo,
  NewSession,
  Session,
  ShellProfile,
  Workspace,
} from "./api";
import type { SplitDir, WorkspaceLayout } from "./layout";
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
      confirmLabel?: string;
      danger?: boolean;
      onConfirm: () => void;
    }
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
  focusTick: number;
  findFor: string | null;

  setView: (view: string) => void;
  addWorkspace: () => void;
  updateWorkspace: (ws: Workspace) => void;
  removeWorkspace: (ws: Workspace) => void;
  newSession: (spec: Omit<NewSession, "workspaceId">, placement?: Placement) => void;
  runCommandPrompt: (placement?: Placement) => void;
  closeSession: (id: string) => void;
  startSession: (id: string) => void;
  renameSession: (s: Session) => void;
  setSessionAccent: (id: string, accent: string | null) => void;
  restoreClosed: (s: Session) => void;
  focusSession: (id: string) => void;
  setLayout: (workspaceId: string, fn: (l: WorkspaceLayout) => WorkspaceLayout) => void;
  setModal: (m: ModalState) => void;
  setPaletteOpen: (open: boolean) => void;
  setThemePref: (pref: ThemePref) => void;
  setFontSize: (size: number) => void;
  setFindFor: (id: string | null) => void;
  refreshAgents: () => void;
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
