import { useState } from "react";
import { Workspace } from "../lib/api";
import { describeAgent, describeState, kindLabel, useApp } from "../lib/state";
import { ACCENTS } from "../lib/themes";

export function Sidebar() {
  const app = useApp();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const running = (wsId: string) =>
    app.sessions.filter((s) => s.workspaceId === wsId && s.state === "running").length;

  const rename = (ws: Workspace) =>
    app.setModal({
      kind: "input",
      title: "Rename workspace",
      initial: ws.name,
      confirmLabel: "Rename",
      onSubmit: (name) => name.trim() && app.updateWorkspace({ ...ws, name: name.trim() }),
    });

  const editTags = (ws: Workspace) =>
    app.setModal({
      kind: "input",
      title: "Workspace tags",
      label: "Comma-separated, e.g. customer, staging",
      initial: ws.tags.join(", "),
      confirmLabel: "Save",
      onSubmit: (value) =>
        app.updateWorkspace({
          ...ws,
          tags: value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
    });

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-head" data-tauri-drag-region>
        {!app.isMac && <span className="brand">NEXUS</span>}
      </div>

      <nav className="sidebar-scroll">
        <button
          className={`nav-item ${app.view === "dashboard" ? "active" : ""}`}
          onClick={() => app.setView("dashboard")}
        >
          <span className="nav-icon" aria-hidden>
            ◫
          </span>
          Dashboard
        </button>

        <div className="section-title">
          <span>Workspaces</span>
          <button className="icon-btn" title="Add project folder" aria-label="Add project folder" onClick={app.addWorkspace}>
            +
          </button>
        </div>

        {app.workspaces.length === 0 && <div className="empty-hint">No workspaces yet.</div>}

        {app.workspaces.map((ws) => {
          const active = app.view === ws.id;
          const count = running(ws.id);
          const wsSessions = app.sessions.filter((s) => s.workspaceId === ws.id);
          return (
            <div key={ws.id} className="ws-block">
              <div className={`nav-item ws-item ${active ? "active" : ""}`}>
                <button className="ws-main" onClick={() => app.setView(ws.id)} title={ws.rootPath}>
                  <span className="ws-dot" style={{ background: ws.accent }} aria-hidden />
                  <span className="ws-name">{ws.name}</span>
                  {ws.pinned && (
                    <span className="ws-pin" title="Pinned" aria-label="Pinned">
                      ★
                    </span>
                  )}
                  {!ws.pathExists && (
                    <span className="ws-warn" title="Project folder not found">
                      ⚠ missing
                    </span>
                  )}
                </button>
                {count > 0 && (
                  <span className="badge" title={`${count} running`}>
                    {count}
                  </span>
                )}
                <button
                  className="icon-btn ws-more"
                  aria-label={`Options for ${ws.name}`}
                  onClick={() => setMenuFor(menuFor === ws.id ? null : ws.id)}
                >
                  ⋯
                </button>
              </div>

              {menuFor === ws.id && (
                <>
                  <div className="scrim" onClick={() => setMenuFor(null)} />
                  <div className="menu ws-menu" role="menu">
                    <button role="menuitem" onClick={() => (setMenuFor(null), rename(ws))}>
                      Rename…
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => (setMenuFor(null), app.updateWorkspace({ ...ws, pinned: !ws.pinned }))}
                    >
                      {ws.pinned ? "Unpin" : "Pin to top"}
                    </button>
                    {!ws.pathExists && (
                      <button role="menuitem" onClick={() => (setMenuFor(null), app.relinkWorkspace(ws))}>
                        Locate folder…
                      </button>
                    )}
                    <button role="menuitem" onClick={() => (setMenuFor(null), editTags(ws))}>
                      Edit tags…
                    </button>
                    <div className="swatches" role="group" aria-label="Accent colour">
                      {ACCENTS.map((c) => (
                        <button
                          key={c}
                          className={`swatch ${ws.accent === c ? "on" : ""}`}
                          style={{ background: c }}
                          aria-label={`Accent ${c}`}
                          onClick={() => app.updateWorkspace({ ...ws, accent: c })}
                        />
                      ))}
                    </div>
                    <button
                      role="menuitem"
                      className="danger"
                      onClick={() => (setMenuFor(null), app.removeWorkspace(ws))}
                    >
                      Remove from NEXUS…
                    </button>
                  </div>
                </>
              )}

              {active && ws.tags.length > 0 && (
                <div className="ws-tags">
                  {ws.tags.map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {active &&
                wsSessions.map((s) => {
                  const st = describeState(s);
                  const agent = describeAgent(s, app.agents);
                  return (
                    <button
                      key={s.id}
                      className="session-row"
                      onClick={() => app.focusSession(s.id)}
                      title={`${kindLabel(s, app.agents)} · ${st.label}${agent ? ` · ${agent.label}` : ""}`}
                    >
                      <span className={`st ${st.cls}`} aria-hidden>
                        {st.icon}
                      </span>
                      <span className="session-name">{s.name}</span>
                      {agent?.attention ? (
                        <span className={`st ${agent.cls}`}>
                          {agent.icon} {agent.label}
                        </span>
                      ) : (
                        s.kind === "agent" && <span className="agent-chip">agent</span>
                      )}
                      <span className="sr-only">{st.label}</span>
                    </button>
                  );
                })}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button className="nav-item" onClick={() => app.setModal({ kind: "closed" })}>
          <span className="nav-icon" aria-hidden>
            ↺
          </span>
          Recently closed
        </button>
        <button className="nav-item" onClick={() => app.setPaletteOpen(true)}>
          <span className="nav-icon" aria-hidden>
            ⌕
          </span>
          Commands
          <kbd>{app.isMac ? "⌘K" : "Ctrl+Shift+K"}</kbd>
        </button>
        <button className="nav-item" onClick={() => app.setModal({ kind: "settings" })}>
          <span className="nav-icon" aria-hidden>
            ⚙
          </span>
          Settings
        </button>
      </div>
    </aside>
  );
}
