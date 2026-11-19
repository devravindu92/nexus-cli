import { useApp } from "../lib/state";

export function Welcome() {
  const app = useApp();
  return (
    <div className="welcome">
      <header className="topbar" data-tauri-drag-region />
      <div className="welcome-body">
        <h1>Welcome to NEXUS</h1>
        <p className="lead">One calm workspace for every terminal, agent and project.</p>
        <button className="btn primary big" onClick={app.addWorkspace}>
          Add a project folder
        </button>
        <p className="fine">Everything stays on this computer. No account, no cloud.</p>

        <div className="setup">
          <section className="panel">
            <h3>Shells found</h3>
            {app.shells.length === 0 && <p className="empty-hint">Detecting…</p>}
            {app.shells.map((s) => (
              <div key={s.id} className="row static">
                <span className="st st-running" aria-hidden>
                  ✓
                </span>
                <span className="row-main">
                  <span className="row-title">{s.name}</span>
                  <span className="row-sub">{s.program}</span>
                </span>
                {s.isDefault && <span className="row-meta">default</span>}
              </div>
            ))}
          </section>
          <section className="panel">
            <h3>
              AI agent CLIs
              <button className="link" onClick={app.refreshAgents}>
                Re-scan
              </button>
            </h3>
            {app.agents.length === 0 && <p className="empty-hint">Detecting…</p>}
            {app.agents.map((a) => (
              <div key={a.id} className="row static">
                <span className={`st ${a.available ? "st-running" : "st-exited"}`} aria-hidden>
                  {a.available ? "✓" : "–"}
                </span>
                <span className="row-main">
                  <span className="row-title">{a.name}</span>
                  <span className="row-sub">{a.available ? a.resolvedPath : `\`${a.program}\` not found on PATH`}</span>
                </span>
                <span className="row-meta">{a.available ? "ready" : "not installed"}</span>
              </div>
            ))}
            <p className="fine">Agents use their own sign-in. NEXUS never asks for API keys.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
