import { useEffect, useState } from "react";
import { api, HostMetrics, RemoteHost, Session, SessionUsage, UsageSnapshot } from "../lib/api";
import { hostStatus } from "./Remote";
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

const formatKb = (kb: number) => formatBytes(kb * 1024);

function formatUptime(secs: number): string {
  const days = Math.floor(secs / 86400);
  if (days > 0) return `${days} d`;
  const hours = Math.floor(secs / 3600);
  return hours > 0 ? `${hours} h` : `${Math.max(1, Math.floor(secs / 60))} min`;
}

/**
 * Metrics for each machine, fetched on that machine's own interval and only
 * while this panel is on screen. A value is never shown without its age.
 */
function useHostMetrics(hosts: RemoteHost[], onChecked: () => void) {
  const [metrics, setMetrics] = useState<Record<string, HostMetrics>>({});
  const [, setTick] = useState(0);
  const key = hosts.map((h) => `${h.id}:${h.metricsEnabled}:${h.disabled}:${h.metricsIntervalSecs}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const timers = hosts
      .filter((h) => h.metricsEnabled && !h.disabled)
      .map((h) => {
        const load = () => {
          if (document.hidden) return;
          api
            .hostMetrics(h.id)
            .then((m) => {
              if (cancelled) return;
              setMetrics((prev) => ({ ...prev, [h.id]: m }));
              onChecked();
            })
            .catch(() => {});
        };
        load();
        return setInterval(load, Math.max(10, h.metricsIntervalSecs) * 1000);
      });
    // Re-render so "updated … ago" and staleness stay honest between checks.
    const clock = setInterval(() => setTick((n) => n + 1), 10000);
    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
      clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return metrics;
}

function Meter({ label, used, total, text }: { label: string; used: number; total: number; text: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const level = pct >= 90 ? "high" : pct >= 75 ? "mid" : "";
  return (
    <div className="meter" title={`${label}: ${text}`}>
      <div className="meter-label">
        <span>{label}</span>
        <span>
          {pct}%{level === "high" ? " ⚠" : ""}
        </span>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`meter-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="meter-text">{text}</div>
    </div>
  );
}

function HostsPanel({ hosts, sessions }: { hosts: RemoteHost[]; sessions: Session[] }) {
  const app = useApp();
  const metrics = useHostMetrics(hosts, app.refreshHosts);
  return (
    <section className="panel hosts-panel">
      <h3>
        Remote machines
        <span className="usage-note">Checked over SSH while this page is open</span>
      </h3>
      {hosts.map((h) => {
        const m = metrics[h.id];
        const st = hostStatus(h);
        const live = sessions.filter((s) => s.host === h.id && s.state === "running").length;
        const age = m ? Date.now() - m.collectedAt : 0;
        const stale = m ? age > Math.max(10, h.metricsIntervalSecs) * 2500 : false;
        const ok = m?.status === "ok";
        return (
          <div key={h.id} className="host-row">
            <button className="host-id" onClick={() => app.setModal({ kind: "host", host: h })} title="Edit this machine">
              <span className="row-title">
                <span className={`st ${m ? (ok ? "st-running" : "st-failed") : st.cls}`}>
                  {m ? (ok ? "●" : "✕") : st.icon}
                </span>{" "}
                {h.name}
                {h.environment && <span className="tag">{h.environment}</span>}
              </span>
              <span className="row-sub">
                {h.user ? `${h.user}@` : ""}
                {h.target} · {live} running session{live === 1 ? "" : "s"}
                {h.hasTmux === true ? " · tmux available" : h.hasTmux === false ? " · no tmux" : ""}
              </span>
            </button>
            <div className="host-metrics">
              {h.disabled ? (
                <span className="empty-hint">Disabled</span>
              ) : !h.metricsEnabled ? (
                <span className="empty-hint">Metrics turned off for this machine</span>
              ) : !m ? (
                <span className="empty-hint">Checking…</span>
              ) : !ok ? (
                <span className="host-error">
                  {m.status === "unreachable" ? "Unreachable" : m.status === "needsInteraction" ? "Metrics unavailable" : "Check failed"}
                  : {m.error}
                </span>
              ) : (
                <>
                  {m.load1 != null && m.cpus ? (
                    <Meter label="CPU load" used={m.load1} total={m.cpus} text={`${m.load1.toFixed(2)} on ${m.cpus} cores (1 min)`} />
                  ) : (
                    <div className="meter empty-hint">CPU load unavailable</div>
                  )}
                  {m.memTotalKb != null && m.memAvailableKb != null ? (
                    <Meter label="Memory" used={m.memTotalKb - m.memAvailableKb} total={m.memTotalKb} text={`${formatKb(m.memTotalKb - m.memAvailableKb)} of ${formatKb(m.memTotalKb)}`} />
                  ) : (
                    <div className="meter empty-hint">Memory unavailable</div>
                  )}
                  {m.diskTotalKb != null && m.diskUsedKb != null ? (
                    <Meter label="Disk /" used={m.diskUsedKb} total={m.diskTotalKb} text={`${formatKb(m.diskUsedKb)} of ${formatKb(m.diskTotalKb)}`} />
                  ) : (
                    <div className="meter empty-hint">Disk unavailable</div>
                  )}
                </>
              )}
            </div>
            <div className={`host-age ${stale ? "stale" : ""}`}>
              {m ? (
                <>
                  {stale ? "Stale · " : ""}
                  updated {timeAgo(m.collectedAt)}
                  {ok && m.uptimeSecs != null ? ` · up ${formatUptime(m.uptimeSecs)}` : ""}
                  <br />
                  via {m.source}
                </>
              ) : (
                ""
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
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
  const remoteRunning = running.filter((s) => s.host !== "local");
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
          <Card
            label="Remote sessions"
            value={remoteRunning.length}
            note={
              app.hosts.length === 0
                ? "No remote machines registered"
                : `${app.hosts.length} machine${app.hosts.length === 1 ? "" : "s"} · ${remoteRunning.filter((s) => s.persistence === "tmux").length} in tmux`
            }
            muted={app.hosts.length === 0}
          />
          <Card
            label="Agent sessions"
            value={agentsRunning.length}
            note={agentNote}
          />
        </div>

        {app.hosts.length > 0 && <HostsPanel hosts={app.hosts} sessions={app.sessions} />}

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
