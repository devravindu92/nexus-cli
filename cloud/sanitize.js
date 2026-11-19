// What a desktop is allowed to store in the cloud: names and states only.
// Anything not listed here is dropped, whatever the client sends. In
// particular there is no field for commands, arguments, environment values,
// terminal output, key paths or passwords.

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const opt = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);
const list = (v, max, fn) => (Array.isArray(v) ? v.slice(0, max).map(fn) : []);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

export function sanitizeState(input) {
  const s = input && typeof input === "object" ? input : {};
  return {
    workspaces: list(s.workspaces, 200, (w) => ({
      id: str(w?.id, 64),
      name: str(w?.name, 120),
      path: str(w?.path, 300),
      accent: /^#[0-9a-fA-F]{6}$/.test(w?.accent ?? "") ? w.accent : "",
      tags: list(w?.tags, 20, (t) => str(t, 40)),
      pinned: w?.pinned === true,
    })),
    sessions: list(s.sessions, 500, (x) => ({
      id: str(x?.id, 64),
      workspaceId: str(x?.workspaceId, 64),
      name: str(x?.name, 120),
      kind: oneOf(x?.kind, ["shell", "agent", "command"], "shell"),
      agent: opt(x?.agent, 60),
      host: str(x?.host, 120) || "Local",
      remote: x?.remote === true,
      durable: x?.durable === true,
      state: oneOf(x?.state, ["running", "exited", "recoverable"], "exited"),
      agentState: oneOf(x?.agentState, ["working", "waiting", "permission", "completed"], null),
      exitCode: int(x?.exitCode),
      createdAt: int(x?.createdAt),
    })),
    hosts: list(s.hosts, 200, (h) => ({
      id: str(h?.id, 64),
      name: str(h?.name, 120),
      environment: str(h?.environment, 60),
      target: str(h?.target, 200),
      tags: list(h?.tags, 20, (t) => str(t, 40)),
      reachable: h?.reachable === true ? true : h?.reachable === false ? false : null,
      checkedAt: int(h?.checkedAt),
    })),
    activity: list(s.activity, 50, (a) => ({
      ts: int(a?.ts),
      kind: str(a?.kind, 40),
      message: str(a?.message, 300),
    })),
  };
}

export const validEmail = (e) =>
  typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
