import { useEffect, useMemo, useRef, useState } from "react";
import { api, Session } from "../lib/api";
import { describeState, kindLabel, useApp } from "../lib/state";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function Palette() {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState<Session[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.sessionListClosed().then(setClosed).catch(() => {});
  }, []);

  const items = useMemo<Item[]>(() => {
    const k = (mac: string, other: string) => (app.isMac ? mac : other);
    const out: Item[] = [];
    const inWorkspace = !!app.activeWorkspace;
    if (inWorkspace) {
      out.push(
        { id: "new-term", group: "Actions", label: "New terminal", hint: k("⌘T", "Ctrl+Shift+T"), run: () => app.newSession({ kind: "shell" }) },
        { id: "split-r", group: "Actions", label: "Split right", hint: k("⌘D", "Ctrl+Shift+D"), run: () => app.newSession({ kind: "shell" }, "row") },
        { id: "split-d", group: "Actions", label: "Split down", hint: k("⌘⇧D", "Ctrl+Shift+E"), run: () => app.newSession({ kind: "shell" }, "col") },
        { id: "run-cmd", group: "Actions", label: "Run a command…", run: () => app.runCommandPrompt() },
      );
      for (const s of app.shells)
        out.push({ id: `sh-${s.id}`, group: "New terminal", label: s.name, hint: s.program, run: () => app.newSession({ kind: "shell", profileId: s.id }) });
      for (const a of app.agents.filter((x) => x.available))
        out.push({ id: `ag-${a.id}`, group: "Launch agent", label: a.name, hint: a.program, run: () => app.newSession({ kind: "agent", profileId: a.id }) });
    }
    out.push(
      { id: "add-ws", group: "Actions", label: "Add project folder…", run: app.addWorkspace },
      { id: "dash", group: "Go to", label: "Dashboard", run: () => app.setView("dashboard") },
      { id: "closed", group: "Go to", label: "Recently closed sessions", run: () => app.setModal({ kind: "closed" }) },
      { id: "settings", group: "Go to", label: "Settings & shortcuts", run: () => app.setModal({ kind: "settings" }) },
      { id: "theme-dark", group: "Appearance", label: "Theme: Dark", run: () => app.setThemePref("dark") },
      { id: "theme-light", group: "Appearance", label: "Theme: Light", run: () => app.setThemePref("light") },
      { id: "theme-sys", group: "Appearance", label: "Theme: Follow system", run: () => app.setThemePref("system") },
    );
    for (const ws of app.workspaces)
      out.push({ id: `ws-${ws.id}`, group: "Workspaces", label: ws.name, hint: ws.rootPath.replace(app.info.homeDir, "~"), run: () => app.setView(ws.id) });
    for (const s of app.sessions) {
      const ws = app.workspaces.find((w) => w.id === s.workspaceId);
      out.push({
        id: `s-${s.id}`,
        group: "Sessions",
        label: s.name,
        hint: `${ws?.name ?? ""} · ${kindLabel(s, app.agents)} · ${describeState(s).label}`,
        run: () => app.focusSession(s.id),
      });
    }
    for (const s of closed) {
      const ws = app.workspaces.find((w) => w.id === s.workspaceId);
      if (!ws) continue;
      out.push({ id: `c-${s.id}`, group: "Restore closed (new process)", label: s.name, hint: ws.name, run: () => app.restoreClosed(s) });
    }
    return out;
  }, [app, closed]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return items;
    return items.filter((it) => {
      const hay = `${it.group} ${it.label} ${it.hint ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (item?: Item) => {
    if (!item) return;
    app.setPaletteOpen(false);
    item.run();
  };

  let lastGroup = "";
  return (
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && app.setPaletteOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          className="palette-input"
          placeholder="Search actions, workspaces and sessions"
          aria-label="Command palette search"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[index]);
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 && <div className="empty-hint">No matches.</div>}
          {filtered.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item ${i === index ? "on" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(item)}
                >
                  <span>{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
