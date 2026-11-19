import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, blankHost, HostTest, parseCommandLine, RemoteHost } from "../lib/api";
import { Placement, timeAgo, useApp } from "../lib/state";

const STATUS_LABEL: Record<HostTest["status"], string> = {
  ok: "✓ Connected",
  unreachable: "✕ Unreachable",
  needsInteraction: "⚠ Needs sign-in",
  hostKeyUnknown: "⚠ Host key not trusted yet",
  hostKeyChanged: "⛔ Host key changed",
  error: "✕ Failed",
};

/** One-line connection summary for lists. Text, not colour alone. */
export function hostStatus(h: RemoteHost): { icon: string; label: string; cls: string } {
  if (h.disabled) return { icon: "–", label: "Disabled", cls: "st-exited" };
  if (h.lastCheckedAt == null) return { icon: "○", label: "Not tested yet", cls: "st-exited" };
  if (h.lastError) return { icon: "✕", label: "Last check failed", cls: "st-failed" };
  return { icon: "●", label: "Reachable at last check", cls: "st-running" };
}

/** Register or edit a remote machine. Nothing is contacted until "Test". */
export function HostDialog({ initial, close }: { initial: RemoteHost | null; close: () => void }) {
  const app = useApp();
  const [host, setHost] = useState<RemoteHost>(initial ?? blankHost());
  const [test, setTest] = useState<HostTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<Record<string, string> | null>(null);
  const set = (patch: Partial<RemoteHost>) => {
    setHost((h) => ({ ...h, ...patch }));
    setTest(null);
    setError(null);
  };
  const text = (v: string) => (v.trim() ? v : null);

  useEffect(() => {
    api.hostDisclosure().then(setDisclosure).catch(() => {});
  }, []);

  const runTest = async () => {
    setTesting(true);
    setError(null);
    try {
      setTest(await api.hostTest(host));
      if (host.id) app.refreshHosts();
    } catch (err) {
      setError(String(err));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    try {
      const saved = await app.saveHost(host);
      // Keep what the test just learned about the machine.
      if (test && !host.id) await api.hostTest(saved).catch(() => {});
      app.refreshHosts();
      close();
    } catch (err) {
      setError(String(err));
    }
  };

  const pickKey = async () => {
    const picked = await open({ multiple: false, title: "Choose a private key file" }).catch(() => null);
    if (typeof picked === "string") set({ identityFile: picked });
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h2>{initial ? `Edit ${initial.name}` : "Add a remote machine"}</h2>
      <p>
        NEXUS connects with your system SSH client, so your SSH config, keys, agent and known hosts apply
        as they do in a terminal. Passwords and passphrases are typed into the terminal when SSH asks;
        NEXUS never sees or stores them.
      </p>
      <div className="form-grid">
        <label>
          Name
          <input className="text-input" autoFocus value={host.name} placeholder="DEV-01" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          Environment
          <input className="text-input" value={host.environment} placeholder="dev, staging, customer…" onChange={(e) => set({ environment: e.target.value })} />
        </label>
        <label className="wide">
          Host
          <input
            className="text-input"
            value={host.target}
            placeholder="hostname, IP address or SSH config alias"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => set({ target: e.target.value })}
          />
        </label>
        <label>
          User <span className="opt">optional</span>
          <input className="text-input" value={host.user ?? ""} spellCheck={false} autoCapitalize="off" onChange={(e) => set({ user: text(e.target.value) })} />
        </label>
        <label>
          Port <span className="opt">optional</span>
          <input
            className="text-input"
            inputMode="numeric"
            value={host.port ?? ""}
            placeholder="22"
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ""));
              set({ port: n >= 1 && n <= 65535 ? n : null });
            }}
          />
        </label>
        <label className="wide">
          Identity file <span className="opt">optional — the key stays where it is; only its path is saved</span>
          <span className="input-row">
            <input className="text-input" value={host.identityFile ?? ""} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={(e) => set({ identityFile: text(e.target.value) })} />
            <button type="button" className="btn" onClick={pickKey}>
              Choose…
            </button>
          </span>
        </label>
        <label className="wide">
          Jump host <span className="opt">optional — [user@]bastion[:port]</span>
          <input className="text-input" value={host.proxyJump ?? ""} spellCheck={false} autoCapitalize="off" onChange={(e) => set({ proxyJump: text(e.target.value) })} />
        </label>
        <label className="wide">
          Tags <span className="opt">comma-separated</span>
          <input
            className="text-input"
            value={host.tags.join(", ")}
            onChange={(e) => set({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
          />
        </label>
      </div>

      <label className="check">
        <input type="checkbox" checked={host.agentForwarding} onChange={(e) => set({ agentForwarding: e.target.checked })} />
        <span>
          Forward my SSH agent to this machine
          <small>
            Off by default. While you are connected, anyone with root on that machine can use your agent to
            sign in elsewhere as you. Turn it on only for machines you fully trust.
          </small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={host.metricsEnabled} onChange={(e) => set({ metricsEnabled: e.target.checked })} />
        <span>
          Show CPU load, memory, disk and uptime on the dashboard
          <small>
            Runs a small read-only command over SSH every{" "}
            <input
              className="text-input tiny"
              inputMode="numeric"
              aria-label="Metrics interval in seconds"
              value={host.metricsIntervalSecs}
              onChange={(e) => set({ metricsIntervalSecs: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            />{" "}
            seconds, only while the dashboard is open. No software is installed on the machine.
          </small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={host.disabled} onChange={(e) => set({ disabled: e.target.checked })} />
        <span>Disabled (keep the profile, but do not connect)</span>
      </label>

      {disclosure && (
        <details className="disclosure">
          <summary>What NEXUS runs on this machine</summary>
          <p>Connection test:</p>
          <pre className="dialog-detail">{disclosure.test}</pre>
          <p>Metrics check:</p>
          <pre className="dialog-detail">{disclosure.metrics}</pre>
          <p>
            Durable sessions additionally run <code>tmux</code> commands for the sessions NEXUS created
            (named <code>nexus-…</code>). Everything else is what you type.
          </p>
        </details>
      )}

      {test && (
        <div className={`callout ${test.status === "ok" ? "ok" : test.status === "hostKeyChanged" ? "bad" : "warn"}`} role="status">
          <strong>{STATUS_LABEL[test.status]}</strong>
          {test.os ? ` · ${test.os}` : ""}
          <div>{test.message}</div>
        </div>
      )}
      {error && (
        <div className="callout bad" role="alert">
          {error}
        </div>
      )}
      {initial?.lastConnectedAt && (
        <p className="fine">Last reached {timeAgo(initial.lastConnectedAt)}.</p>
      )}

      <div className="dialog-actions">
        {initial && (
          <button type="button" className="btn danger-text" onClick={() => app.removeHost(initial)}>
            Remove…
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn" disabled={testing || !host.target.trim()} onClick={runTest}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Save
        </button>
      </div>
    </form>
  );
}

type RemoteKind = "shell" | "agent" | "command";

/** Start a session on a remote machine from the current workspace. */
export function RemoteSessionDialog({
  host,
  placement,
  close,
}: {
  host: RemoteHost;
  placement: Placement;
  close: () => void;
}) {
  const app = useApp();
  const dirKey = `remoteDir:${app.view}:${host.id}`;
  const [kind, setKind] = useState<RemoteKind>("shell");
  const [dir, setDir] = useState(app.prefs[dirKey] ?? "");
  const [agentId, setAgentId] = useState(app.agents[0]?.id ?? "claude");
  const [command, setCommand] = useState("");
  const [durable, setDurable] = useState(host.hasTmux === true);

  const start = () => {
    const argv = parseCommandLine(command);
    if (kind === "command" && argv.length === 0) return;
    if (dir.trim()) app.setPref(dirKey, dir.trim());
    close();
    app.newSession(
      {
        kind,
        hostId: host.id,
        cwd: dir.trim() || undefined,
        profileId: kind === "agent" ? agentId : undefined,
        program: kind === "command" ? argv[0] : undefined,
        args: kind === "command" ? argv.slice(1) : undefined,
        name: kind === "command" ? `${command.trim()} · ${host.name}` : undefined,
        persistence: durable ? "tmux" : undefined,
      },
      placement,
    );
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <h2>New session on {host.name}</h2>
      <p>
        Runs on <strong>{host.user ? `${host.user}@` : ""}{host.target}</strong>
        {host.environment ? ` (${host.environment})` : ""}, not on this computer.
      </p>
      <div className="segmented" role="radiogroup" aria-label="What to run">
        {(
          [
            ["shell", "Shell"],
            ["agent", "AI agent"],
            ["command", "Command"],
          ] as [RemoteKind, string][]
        ).map(([value, label]) => (
          <button type="button" key={value} role="radio" aria-checked={kind === value} className={kind === value ? "on" : ""} onClick={() => setKind(value)}>
            {label}
          </button>
        ))}
      </div>
      <div className="form-grid">
        {kind === "agent" && (
          <label className="wide">
            Agent <span className="opt">must be installed on {host.name}</span>
            <select className="text-input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {app.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.program})
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "command" && (
          <label className="wide">
            Command
            <input className="text-input" autoFocus value={command} placeholder="e.g. npm run dev" spellCheck={false} autoCapitalize="off" onChange={(e) => setCommand(e.target.value)} />
          </label>
        )}
        <label className="wide">
          Remote folder <span className="opt">optional — remembered for this workspace</span>
          <input className="text-input" autoFocus={kind !== "command"} value={dir} placeholder="~/projects/app" spellCheck={false} autoCapitalize="off" onChange={(e) => setDir(e.target.value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={durable} disabled={host.hasTmux === false} onChange={(e) => setDurable(e.target.checked)} />
        <span>
          Keep it running if the connection drops (tmux)
          <small>
            {host.hasTmux === false
              ? `tmux was not found on ${host.name} at the last connection test. Install tmux there, test the connection again, and this becomes available.`
              : host.hasTmux == null
                ? "Needs tmux on the machine. It has not been checked yet; if tmux is missing the session ends at once with “command not found”."
                : "The session lives in tmux on the machine: it survives a dropped connection and NEXUS quitting, and you can reattach to it. It does not survive that machine restarting."}
          </small>
        </span>
      </label>
      {kind === "agent" && (
        <p className="fine">
          Remote agents show “State unknown”: the signals NEXUS uses for local agents do not reach across SSH.
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Connect
        </button>
      </div>
    </form>
  );
}
