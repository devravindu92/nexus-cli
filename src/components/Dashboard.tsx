import { useEffect, useState } from "react";
import { api, Session, SessionUsage, UsageSnapshot } from "../lib/api";
import { describeAgent, describeState, kindLabel, timeAgo, useApp } from "../lib/state";

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/**
 * What is in front in a terminal. For an agent's own process, show what the
 * user launched rather than the session and hook flags NEXUS appends.
 */
function runningNow(u: SessionUsage, s: Session): string {
  if (u.atRoot && s.kind === "agent")
    return [s.program.split(/[\\/]/).pop(), ...s.args].join(" ");
  return u.foreground ?? "Unknown";
}

const formatCpu = (percent: number) => `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;

/** Sample resource use every few seconds, only while this view is on screen. */
function useUsage(): UsageSnapshot | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      api
        .usageSnapshot()
        .then((u) => !cancelled && setUsage(u))
        .catch(() => {});
    };
    load();
    // The first sample has no CPU baseline, so take a second one soon after.
    const soon = setTimeout(load, 1000);
    const timer = setInterval(load, 3000);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearTimeout(soon);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return usage;
}

export function Dashboard() {
  const app = useApp();
  const usage = useUsage();
  const usageRows = (usage?.sessions ?? [])
    .map((u) => ({ u, s: app.sessions.find((s) => s.id === u.sessionId) }))
    .filter((r) => r.s)
    .sort((a, b) => b.u.memoryBytes - a.u.memoryBytes);
  const terminalBytes = usageRows.reduce((sum, r) => sum + r.u.memoryBytes, 0);
  const running = app.sessions.filter((s) => s.state === "running");
  const agentsRunning = running.filter((s) => s.kind === "agent");
  const notRunning = app.sessions.filter((s) => s.state !== "running");
  const agentInfo = agentsRunning.map((s) => describeAgent(s, app.agents));
  const wantYou = agentInfo.filter((a) => a?.attention).length;
  const unknown = agentInfo.filter((a) => a?.label === "State unknown").length;
  const agentNote =
    agentsRunning.length === 0
      ? "No agents running"
      : [
          wantYou > 0 ? `${wantYou} waiting for you` : "None waiting for you",
          unknown > 0 ? `${unknown} with unknown state` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const wsName = (id: string) => app.workspaces.find((w) => w.id === id)?.name ?? "—";

  return (
    <div className="dashboard">
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-title" data-tauri-drag-region>
          <strong data-tauri-drag-region>Dashboard</strong>
        </div>
        <div className="topbar-actions">
          <button className="btn primary" onClick={app.addWorkspace}>
            + Add project folder
          </button>
        </div>
      </header>

      <div className="dash-scroll">
        <div className="cards">
          <Card label="Active sessions" value={running.length} note={`${notRunning.length} not running`} />
          <Card
            label="Memory in use"
            value={usage ? formatBytes(terminalBytes + usage.app.memoryBytes) : "…"}
            note={
              usage
                ? `Terminals ${formatBytes(terminalBytes)} · NEXUS ${formatBytes(usage.app.memoryBytes)}`
                : "Measuring"
            }
          />
          <Card label="Remote sessions" value={0} note="Remote hosts are not in this build yet" muted />
          <Card
            label="Agent sessions"
            value={agentsRunning.length}
            note={agentNote}
          />
        </div>

        <section className="panel usage-panel">
          <h3>
            Resource use
            <span className="usage-note">
              Each session with everything it started · updates every 3 s
            </span>
          </h3>
          {usageRows.length === 0 && <p className="empty-hint">No running sessions.</p>}
          {usageRows.length > 0 && (
            <div className="usage-table" role="table" aria-label="Resource use by session">
              <div className="usage-row usage-head" role="row">
                <span role="columnheader">Session</span>
                <span role="columnheader">Running now</span>
                <span role="columnheader" className="num">Processes</span>
                <span role="columnheader" className="num">CPU</span>
                <span role="columnheader" className="num">Memory</span>
                <span role="columnheader" className="sr-only">Actions</span>
              </div>
              {usageRows.map(({ u, s }) => (
                <div key={u.sessionId} className="usage-row" role="row">
                  <button role="cell" className="usage-name" onClick={() => app.focusSession(u.sessionId)} title="Go to this session">
                    <span className="row-title">{s!.name}</span>
                    <span className="row-sub">
                      {wsName(s!.workspaceId)} · {kindLabel(s!, app.agents)}
                    </span>
                  </button>
                  <span role="cell" className="usage-cmd" title={runningNow(u, s!)}>
                    {runningNow(u, s!)}
                    {u.atRoot && s!.kind === "shell" && <span className="usage-idle"> · at prompt</span>}
                  </span>
                  <span role="cell" className="num">{u.processCount}</span>
                  <span role="cell" className="num">{formatCpu(u.cpuPercent)}</span>
                  <span role="cell" className="num usage-mem">{formatBytes(u.memoryBytes)}</span>
                  <span role="cell">
                    <button
                      className="btn"
                      title="End this session's processes. It moves to Recently closed and can be started again."
                      onClick={() => app.closeSession(u.sessionId)}
                    >
                      Close
                    </button>
                  </span>
                </div>
              ))}
              {usage && (
                <div className="usage-row usage-foot" role="row">
                  <span role="cell" className="usage-name">
                    <span className="row-title">NEXUS itself</span>
                    <span className="row-sub">
                      {usage.appIncludesWebview ? "App and its window" : "App only; the window's web view is not counted"}
                    </span>
                  </span>
                  <span role="cell" />
                  <span role="cell" className="num">{usage.app.processCount}</span>
                  <span role="cell" className="num">{formatCpu(usage.app.cpuPercent)}</span>
                  <span role="cell" className="num usage-mem">{formatBytes(usage.app.memoryBytes)}</span>
                  <span role="cell" />
                </div>
              )}
            </div>
          )}
        </section>

        <div className="dash-cols">
          <section className="panel">
            <h3>Workspaces</h3>
            {app.workspaces.map((ws) => {
              const mine = app.sessions.filter((s) => s.workspaceId === ws.id);
              const live = mine.filter((s) => s.state === "running").length;
              return (
                <button key={ws.id} className="row" onClick={() => app.setView(ws.id)}>
                  <span className="ws-dot" style={{ background: ws.accent }} aria-hidden />
                  <span className="row-main">
                    <span className="row-title">{ws.name}</span>
                    <span className="row-sub">{ws.rootPath.replace(app.info.homeDir, "~")}</span>
                  </span>
                  <span className="row-meta">
                    {live} running{mine.length > live ? ` · ${mine.length - live} stopped` : ""}
                  </span>
                </button>
              );
            })}
          </section>

          <section className="panel">
            <h3>Sessions</h3>
            {app.sessions.length === 0 && <p className="empty-hint">No open sessions.</p>}
            {app.sessions.map((s) => {
              const st = describeAgent(s, app.agents) ?? describeState(s);
              return (
                <button key={s.id} className="row" onClick={() => app.focusSession(s.id)} title={st.detail}>
                  <span className={`st ${st.cls}`} aria-hidden>
                    {st.icon}
                  </span>
                  <span className="row-main">
                    <span className="row-title">{s.name}</span>
                    <span className="row-sub">
                      {wsName(s.workspaceId)} · {kindLabel(s, app.agents)} · Local
                    </span>
                  </span>
                  <span className="row-meta">{st.label}</span>
                </button>
              );
            })}
          </section>

          <section className="panel">
            <h3>Recent activity</h3>
            {app.activity.length === 0 && <p className="empty-hint">Nothing yet.</p>}
            {app.activity.slice(0, 14).map((a) => (
              <div key={a.id} className="row static">
                <span className="row-main">
                  <span className="row-title">{a.message}</span>
                </span>
                <span className="row-meta">{timeAgo(a.ts)}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, note, muted }: { label: string; value: number | string; note: string; muted?: boolean }) {
  return (
    <div className={`card ${muted ? "muted" : ""}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      <div className="card-note">{note}</div>
    </div>
  );
}
