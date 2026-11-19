import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Session, Workspace } from "../lib/api";
import { emptyLayout, moveTab, PaneNode, sessionsIn, setRatio } from "../lib/layout";
import { canResume, describeAgent, describeState, hostLabel, kindLabel, Placement, useApp } from "../lib/state";
import { ProjectBanner } from "./Project";
import { terminals } from "../lib/terminals";
import { ACCENTS } from "../lib/themes";

export function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const app = useApp();
  const layout = app.layouts[workspace.id] ?? emptyLayout();
  const sessions = app.sessions.filter((s) => s.workspaceId === workspace.id);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const activeTab = layout.tabs.find((t) => t.id === layout.activeTab) ?? layout.tabs[0];
  const [newMenu, setNewMenu] = useState(false);
  const remoteNames = [
    ...new Set(sessions.filter((s) => s.host !== "local").map((s) => hostLabel(s, app.hosts))),
  ];
  const dragIndex = useRef<number | null>(null);

  const running = sessions.filter((s) => s.state === "running").length;
  const stopped = sessions.length - running;
  const k = (mac: string, other: string) => (app.isMac ? mac : other);

  return (
    <div className="workspace">
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-title" data-tauri-drag-region>
          <span className="ws-dot" style={{ background: workspace.accent }} aria-hidden data-tauri-drag-region />
          <strong data-tauri-drag-region>{workspace.name}</strong>
          <span className="path" data-tauri-drag-region title={workspace.rootPath}>
            {workspace.rootPath.replace(app.info.homeDir, "~")}
          </span>
          {app.gitBranch && (
            <span className="chip" title="Git branch" data-tauri-drag-region>
              ⎇ {app.gitBranch}
            </span>
          )}
          <span
            className="chip host"
            title="Where this workspace's sessions run. Each pane also says where it runs."
            data-tauri-drag-region
          >
            {remoteNames.length === 0 ? "Host: Local" : `Hosts: Local + ${remoteNames.join(", ")}`}
          </span>
          {!workspace.pathExists && (
            <>
              <span className="chip warn" data-tauri-drag-region>
                ⚠ Folder not found
              </span>
              <button className="btn" onClick={() => app.relinkWorkspace(workspace)}>
                Locate folder…
              </button>
            </>
          )}
        </div>
        <div className="topbar-actions">
          <button
            className="btn"
            title={`Split right (${k("⌘D", "Ctrl+Shift+D")})`}
            disabled={!activeTab}
            onClick={() => app.newSession({ kind: "shell" }, "row")}
          >
            ◫ Split right
          </button>
          <button
            className="btn"
            title={`Split down (${k("⌘⇧D", "Ctrl+Shift+E")})`}
            disabled={!activeTab}
            onClick={() => app.newSession({ kind: "shell" }, "col")}
          >
            ⊟ Split down
          </button>
          <div className="menu-anchor">
            <button className="btn primary" aria-haspopup="menu" onClick={() => setNewMenu((v) => !v)}>
              + New session
            </button>
            {newMenu && <NewSessionMenu canSplit={!!activeTab} onClose={() => setNewMenu(false)} />}
          </div>
        </div>
      </header>

      {layout.tabs.length > 0 && (
        <div className="tabs" role="tablist">
          {layout.tabs.map((tab, index) => {
            const ids = sessionsIn(tab.root);
            const focus = byId.get(tab.focus) ?? byId.get(ids[0]);
            const accent = focus?.accent ?? workspace.accent;
            const st = focus ? describeState(focus) : null;
            // An agent anywhere in the tab that wants the user, most urgent first.
            const wants = ids
              .map((id) => byId.get(id))
              .map((s) => (s ? describeAgent(s, app.agents) : null))
              .filter((a) => a?.attention)
              .sort((a, b) => Number(b!.cls === "st-attention") - Number(a!.cls === "st-attention"))[0];
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeTab?.id}
                tabIndex={0}
                className={`tab ${tab.id === activeTab?.id ? "active" : ""}`}
                style={{ ["--accent" as string]: accent }}
                draggable
                onDragStart={() => (dragIndex.current = index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex.current !== null) {
                    const from = dragIndex.current;
                    app.setLayout(workspace.id, (l) => moveTab(l, from, index));
                  }
                  dragIndex.current = null;
                }}
                onClick={() => focus && app.focusSession(focus.id)}
                onKeyDown={(e) => e.key === "Enter" && focus && app.focusSession(focus.id)}
              >
                {st && (
                  <span className={`st ${st.cls}`} title={st.label} aria-label={st.label}>
                    {st.icon}
                  </span>
                )}
                <span className="tab-name">{focus?.name ?? "Session"}</span>
                {wants && (
                  <span className={`st ${wants.cls}`} title={wants.detail}>
                    {wants.icon} <span className="st-label">{wants.label}</span>
                  </span>
                )}
                {ids.length > 1 && <span className="tab-count">{ids.length}</span>}
                {index < 9 && <kbd>{k("⌘", "Alt+")}{index + 1}</kbd>}
              </div>
            );
          })}
        </div>
      )}

      <div className="panes">
        {activeTab ? (
          <PaneTree
            key={activeTab.id}
            node={activeTab.root}
            workspace={workspace}
            byId={byId}
            focus={activeTab.focus}
          />
        ) : (
          <EmptyWorkspace />
        )}
      </div>

      <ProjectBanner workspace={workspace} />

      <footer className="statusbar">
        <span>
          <span className="st st-running" aria-hidden>
            ●
          </span>{" "}
          {running} running
        </span>
        {stopped > 0 && <span>{stopped} not running</span>}
        <span>{sessions.filter((s) => s.kind === "agent").length} agent sessions</span>
        <span className="spacer" />
        <span title="Local terminals end when NEXUS quits. Layout and settings are restored; processes are not.">
          Local sessions are ephemeral
        </span>
      </footer>
    </div>
  );
}

function EmptyWorkspace() {
  const app = useApp();
  const available = app.agents.filter((a) => a.available);
  return (
    <div className="empty-ws">
      <h2>No sessions open</h2>
      <p>Start a terminal or an AI agent in this project.</p>
      <div className="empty-actions">
        <button className="btn primary" onClick={() => app.newSession({ kind: "shell" })}>
          New terminal <kbd>{app.isMac ? "⌘T" : "Ctrl+Shift+T"}</kbd>
        </button>
        {available.slice(0, 3).map((a) => (
          <button key={a.id} className="btn" onClick={() => app.newSession({ kind: "agent", profileId: a.id })}>
            ✦ {a.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function NewSessionMenu({ canSplit, onClose }: { canSplit: boolean; onClose: () => void }) {
  const app = useApp();
  const [placement, setPlacement] = useState<Placement>("tab");
  const go = (fn: () => void) => {
    onClose();
    fn();
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="menu new-menu" role="menu">
        <div className="segmented" role="radiogroup" aria-label="Open in">
          {(
            [
              ["tab", "New tab"],
              ["row", "Split right"],
              ["col", "Split down"],
            ] as [Placement, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={placement === value}
              className={placement === value ? "on" : ""}
              disabled={value !== "tab" && !canSplit}
              onClick={() => setPlacement(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="menu-label">Terminals</div>
        {app.shells.length === 0 && <div className="menu-note">Detecting shells…</div>}
        {app.shells.map((s) => (
          <button
            key={s.id}
            role="menuitem"
            onClick={() => go(() => app.newSession({ kind: "shell", profileId: s.id }, placement))}
          >
            <span className="mi-icon" aria-hidden>
              ❯
            </span>
            {s.name}
            {s.isDefault && <span className="mi-note">default</span>}
          </button>
        ))}
        <div className="menu-label">
          AI agents
          <button className="link" onClick={app.refreshAgents}>
            Re-scan
          </button>
        </div>
        {app.agents.map((a) => (
          <button
            key={a.id}
            role="menuitem"
            disabled={!a.available}
            title={a.available ? (a.resolvedPath ?? "") : `\`${a.program}\` was not found on your PATH`}
            onClick={() => go(() => app.newSession({ kind: "agent", profileId: a.id }, placement))}
          >
            <span className="mi-icon" aria-hidden>
              ✦
            </span>
            {a.name}
            {!a.available && <span className="mi-note">not installed</span>}
          </button>
        ))}
        <div className="menu-label">
          Remote machines
          <button className="link" onClick={() => go(() => app.setModal({ kind: "host", host: null }))}>
            Add…
          </button>
        </div>
        {app.hosts.length === 0 && <div className="menu-note">None registered yet.</div>}
        {app.hosts.map((h) => (
          <button
            key={h.id}
            role="menuitem"
            disabled={h.disabled}
            title={`${h.user ? `${h.user}@` : ""}${h.target}`}
            onClick={() => go(() => app.setModal({ kind: "remote-session", host: h, placement }))}
          >
            <span className="mi-icon" aria-hidden>
              ⇄
            </span>
            {h.name}…
            <span className="mi-note">{h.disabled ? "disabled" : h.environment || "remote"}</span>
          </button>
        ))}
        <div className="menu-sep" />
        <button role="menuitem" onClick={() => go(() => app.runCommandPrompt(placement))}>
          <span className="mi-icon" aria-hidden>
            ▷
          </span>
          Run a command…
        </button>
      </div>
    </>
  );
}

interface TreeProps {
  node: PaneNode;
  workspace: Workspace;
  byId: Map<string, Session>;
  focus: string;
}

function PaneTree({ node, workspace, byId, focus }: TreeProps) {
  const app = useApp();
  const ref = useRef<HTMLDivElement>(null);

  if (node.type === "leaf") {
    const session = byId.get(node.sessionId);
    if (!session) return <div className="pane" />;
    return <TerminalPane session={session} workspace={workspace} focused={focus === session.id} />;
  }

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio =
        node.dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      app.setLayout(workspace.id, (l) => setRatio(l, node.id, ratio));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const nudge = (e: React.KeyboardEvent) => {
    const dec = node.dir === "row" ? "ArrowLeft" : "ArrowUp";
    const inc = node.dir === "row" ? "ArrowRight" : "ArrowDown";
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const delta = e.key === inc ? 0.03 : -0.03;
    app.setLayout(workspace.id, (l) => setRatio(l, node.id, node.ratio + delta));
  };

  return (
    <div ref={ref} className={`split split-${node.dir}`}>
      <div className="split-child" style={{ flex: `${node.ratio} 1 0` }}>
        <PaneTree node={node.a} workspace={workspace} byId={byId} focus={focus} />
      </div>
      <div
        className="divider"
        role="separator"
        tabIndex={0}
        aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
        aria-label="Resize panes (arrow keys)"
        onPointerDown={startDrag}
        onKeyDown={nudge}
      />
      <div className="split-child" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <PaneTree node={node.b} workspace={workspace} byId={byId} focus={focus} />
      </div>
    </div>
  );
}

function TerminalPane({
  session,
  workspace,
  focused,
}: {
  session: Session;
  workspace: Workspace;
  focused: boolean;
}) {
  const app = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const st = describeState(session);
  const accent = session.accent ?? workspace.accent;
  const finding = app.findFor === session.id;
  const paneFont = session.fontSize ?? app.fontSize;
  const agent = describeAgent(session, app.agents);
  const remote = session.host !== "local";
  const durable = remote && session.persistence === "tmux";
  const resumable = canResume(session, app.agents);

  useLayoutEffect(() => {
    const host = hostRef.current!;
    terminals.mount(session.id, host);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => terminals.fit(session.id));
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      terminals.unmount(session.id, host);
    };
  }, [session.id]);

  useEffect(() => {
    // Also for a process that already ended: its last output is still held.
    if (session.state === "running" || session.state === "exited") terminals.subscribe(session.id);
  }, [session.id, session.state]);

  useEffect(() => {
    if (focused && !finding) terminals.focus(session.id);
  }, [focused, finding, session.id, session.state, app.focusTick]);

  const closeFind = () => {
    terminals.clearFind(session.id);
    app.setFindFor(null);
  };

  return (
    <section
      className={`pane ${focused ? "focused" : ""}`}
      style={{ ["--accent" as string]: accent }}
      onMouseDown={() => !focused && app.focusSession(session.id)}
      aria-label={`${session.name}, ${st.label}`}
    >
      <header className="pane-head">
        <span className={`st ${st.cls}`} title={st.detail}>
          {st.icon} <span className="st-label">{st.label}</span>
        </span>
        <span className="pane-name" onDoubleClick={() => app.renameSession(session)} title="Double-click to rename">
          {session.name}
        </span>
        <span className={`kind kind-${session.kind}`}>
          {session.kind === "agent" ? "✦ " : ""}
          {kindLabel(session, app.agents)}
        </span>
        <span
          className={`chip where ${remote ? "remote" : ""}`}
          title={remote ? "This session runs on a remote machine, not on this computer" : "This session runs on this computer"}
        >
          {remote ? "⇄ " : ""}
          {hostLabel(session, app.hosts)}
        </span>
        {agent && (
          <span className={`st ${agent.cls}`} title={agent.detail}>
            {agent.icon} <span className="st-label">{agent.label}</span>
          </span>
        )}
        {session.state === "running" && session.agentResumed && (
          <span
            className="chip"
            title="A new process that asked the agent to continue the saved conversation. The earlier process was not reattached."
          >
            Conversation continued
          </span>
        )}
        <span className="spacer" />
        <div className="menu-anchor">
          <button className="icon-btn" aria-label="Session options" onClick={() => setMenu((v) => !v)}>
            ⋯
          </button>
          {menu && (
            <>
              <div className="scrim" onClick={() => setMenu(false)} />
              <div className="menu pane-menu" role="menu">
                <button role="menuitem" onClick={() => (setMenu(false), app.renameSession(session))}>
                  Rename…
                </button>
                <button role="menuitem" onClick={() => (setMenu(false), app.setFindFor(session.id))}>
                  Find in scrollback
                </button>
                <div className="swatches" role="group" aria-label="Session colour">
                  <button
                    className={`swatch none ${session.accent ? "" : "on"}`}
                    aria-label="Use workspace colour"
                    title="Use workspace colour"
                    onClick={() => app.setSessionAccent(session.id, null)}
                  />
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      className={`swatch ${session.accent === c ? "on" : ""}`}
                      style={{ background: c }}
                      aria-label={`Colour ${c}`}
                      onClick={() => app.setSessionAccent(session.id, c)}
                    />
                  ))}
                </div>
                <div className="menu-row" role="group" aria-label="Font size for this session">
                  <span>Font size</span>
                  <span className="spacer" />
                  <button
                    className="icon-btn"
                    aria-label="Smaller font"
                    disabled={paneFont <= 9}
                    onClick={() => app.setSessionFontSize(session.id, paneFont - 1)}
                  >
                    −
                  </button>
                  <span className="menu-value">{paneFont} px</span>
                  <button
                    className="icon-btn"
                    aria-label="Larger font"
                    disabled={paneFont >= 28}
                    onClick={() => app.setSessionFontSize(session.id, paneFont + 1)}
                  >
                    +
                  </button>
                  <button
                    className="link"
                    disabled={session.fontSize == null}
                    title="Use the global font size"
                    onClick={() => app.setSessionFontSize(session.id, null)}
                  >
                    Reset
                  </button>
                </div>
                <button role="menuitem" className="danger" onClick={() => (setMenu(false), app.closeSession(session.id))}>
                  Close session
                </button>
              </div>
            </>
          )}
        </div>
        <button
          className="icon-btn"
          aria-label="Close session"
          title={`Close (${app.isMac ? "⌘W" : "Ctrl+Shift+W"})`}
          onClick={() => app.closeSession(session.id)}
        >
          ×
        </button>
      </header>

      {finding && (
        <div className="findbar">
          <input
            autoFocus
            value={query}
            placeholder="Find in scrollback"
            aria-label="Find in scrollback"
            onChange={(e) => {
              setQuery(e.target.value);
              terminals.find(session.id, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") terminals.find(session.id, query, e.shiftKey);
              if (e.key === "Escape") closeFind();
            }}
          />
          <button className="icon-btn" aria-label="Previous match" onClick={() => terminals.find(session.id, query, true)}>
            ↑
          </button>
          <button className="icon-btn" aria-label="Next match" onClick={() => terminals.find(session.id, query)}>
            ↓
          </button>
          <button className="icon-btn" aria-label="Close find" onClick={closeFind}>
            ×
          </button>
        </div>
      )}

      <div className="pane-body">
        <div ref={hostRef} className="term-slot" />
        {session.state !== "running" && (
          <div className="pane-overlay">
            <div className="overlay-card">
              <div className={`st ${st.cls}`}>
                {st.icon} {st.label}
              </div>
              {remote ? (
                <p>{st.detail}</p>
              ) : session.state === "recoverable" ? (
                <p>
                  This session’s process ended when NEXUS quit. Local terminals are not kept alive in the
                  background, so it cannot be resumed — but its name, folder and command were saved.
                </p>
              ) : (
                <p>
                  The process ended{session.exitCode != null ? ` with exit code ${session.exitCode}` : ""}.
                </p>
              )}
              <code className="cmdline">
                {remote
                  ? `${hostLabel(session, app.hosts)}: ${[session.program || "login shell", ...session.args].join(" ")}${session.cwd ? `  (in ${session.cwd})` : ""}`
                  : [session.program.split(/[\\/]/).pop(), ...session.args].join(" ")}
              </code>
              {resumable && (
                <p>
                  {kindLabel(session, app.agents)} saved this conversation itself. “Continue conversation”
                  starts a new process and asks it to reopen that conversation; the old process is not
                  brought back.
                </p>
              )}
              <div className="overlay-actions">
                {resumable && (
                  <button className="btn primary" onClick={() => app.startSession(session.id, true)}>
                    Continue conversation
                  </button>
                )}
                {durable && (
                  <button className="btn primary" onClick={() => app.startSession(session.id, true)}>
                    Reattach
                  </button>
                )}
                <button
                  className={`btn ${resumable || durable ? "" : "primary"}`}
                  onClick={() => app.startSession(session.id)}
                  title={durable ? "Attaches if the tmux session still exists, otherwise starts a new one" : undefined}
                >
                  {resumable ? "Start fresh" : durable ? "Start or attach" : remote ? "Connect again (new process)" : "Start as new process"}
                </button>
                <button className="btn" onClick={() => app.closeSession(session.id)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
