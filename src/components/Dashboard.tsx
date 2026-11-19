import { describeAgent, describeState, kindLabel, timeAgo, useApp } from "../lib/state";

export function Dashboard() {
  const app = useApp();
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
          <Card label="Local sessions" value={running.filter((s) => s.host === "local").length} note="On this computer" />
          <Card label="Remote sessions" value={0} note="Remote hosts are not in this build yet" muted />
          <Card
            label="Agent sessions"
            value={agentsRunning.length}
            note={agentNote}
          />
        </div>

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

function Card({ label, value, note, muted }: { label: string; value: number; note: string; muted?: boolean }) {
  return (
    <div className={`card ${muted ? "muted" : ""}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      <div className="card-note">{note}</div>
    </div>
  );
}
