import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { Modal } from "./components/Modal";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { Welcome } from "./components/Welcome";
import { WorkspaceView } from "./components/WorkspaceView";
import {
  ActivityEvent,
  AgentProfile,
  api,
  AppInfo,
  parseCommandLine,
  Session,
  ShellProfile,
  Workspace,
} from "./lib/api";
import {
  addTab,
  emptyLayout,
  focusSession as focusInLayout,
  parseLayout,
  reconcile,
  removeSession,
  sessionsIn,
  splitPane,
  WorkspaceLayout,
} from "./lib/layout";
import { AppContext, Ctx, ModalState, Placement } from "./lib/state";
import { DEFAULT_FONT, PastePolicy, terminals } from "./lib/terminals";
import { resolveTheme, TERMINAL_THEMES, ThemePref } from "./lib/themes";

interface Toast {
  id: number;
  text: string;
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [layouts, setLayouts] = useState<Record<string, WorkspaceLayout>>({});
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [view, setViewState] = useState("dashboard");
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [themePref, setThemePrefState] = useState<ThemePref>("system");
  const [fontSize, setFontSizeState] = useState(13);
  const [pastePolicy, setPastePolicyState] = useState<PastePolicy>("always");
  const [modal, setModalState] = useState<ModalState>(null);
  const [paletteOpen, setPaletteOpenState] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [findFor, setFindFor] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [systemTick, setSystemTick] = useState(0);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const fail = useCallback((err: unknown) => toast(String(err)), [toast]);

  // ---- initial load -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [appInfo, ws, ss, prefs, acts] = await Promise.all([
          api.appInfo(),
          api.workspaceList(),
          api.sessionList(),
          api.prefsGet(),
          api.activityList(),
        ]);
        const stored = await Promise.all(ws.map((w) => api.layoutGet(w.id)));
        if (cancelled) return;
        const next: Record<string, WorkspaceLayout> = {};
        ws.forEach((w, i) => {
          const ids = ss.filter((s) => s.workspaceId === w.id).map((s) => s.id);
          next[w.id] = reconcile(parseLayout(stored[i]), ids);
        });
        savedLayouts.current = Object.fromEntries(
          Object.entries(next).map(([k, v]) => [k, JSON.stringify(v)]),
        );
        setWorkspaces(ws);
        setSessions(ss);
        setLayouts(next);
        setActivity(acts);
        if (prefs.theme === "dark" || prefs.theme === "light" || prefs.theme === "system")
          setThemePrefState(prefs.theme);
        const size = Number(prefs.fontSize);
        if (size >= 9 && size <= 28) setFontSizeState(size);
        if (prefs.pastePolicy === "always" || prefs.pastePolicy === "auto" || prefs.pastePolicy === "never")
          setPastePolicyState(prefs.pastePolicy);
        const last = prefs.lastView;
        if (last && ws.some((w) => w.id === last)) setViewState(last);
        else if (ws.length === 1 && !last) setViewState(ws[0].id);
        setInfo(appInfo);
        // Detection can take a moment (it asks the login shell for PATH).
        api.shells().then((v) => !cancelled && setShells(v)).catch(fail);
        api.agents().then((v) => !cancelled && setAgents(v)).catch(fail);
      } catch (err) {
        if (!cancelled) setFatal(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fail]);

  // ---- backend events -----------------------------------------------------
  useEffect(() => {
    const unSession = listen<Session>("session-changed", (e) => {
      const s = e.payload;
      if (s.state !== "running") terminals.markStopped(s.id);
      setSessions((prev) => prev.map((p) => (p.id === s.id ? s : p)));
    });
    const unActivity = listen("activity-changed", () => {
      api.activityList().then(setActivity).catch(() => {});
    });
    return () => {
      unSession.then((f) => f());
      unActivity.then((f) => f());
    };
  }, []);

  // ---- appearance ---------------------------------------------------------
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setSystemTick((n) => n + 1);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const theme = resolveTheme(themePref);
    document.documentElement.dataset.theme = theme;
    terminals.setAppearance({
      theme: TERMINAL_THEMES[theme],
      fontSize,
      fontFamily: DEFAULT_FONT,
    });
  }, [themePref, fontSize, systemTick]);

  // Per-session font size overrides follow the session records.
  useEffect(() => {
    for (const s of sessions) terminals.setFontOverride(s.id, s.fontSize);
  }, [sessions]);

  // ---- layout persistence (debounced, only what changed) -------------------
  const savedLayouts = useRef<Record<string, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const [id, layout] of Object.entries(layouts)) {
        const json = JSON.stringify(layout);
        if (savedLayouts.current[id] !== json) {
          savedLayouts.current[id] = json;
          api.layoutSave(id, json).catch(() => {});
        }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [layouts]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === view) ?? null,
    [workspaces, view],
  );

  // ---- git branch ---------------------------------------------------------
  useEffect(() => {
    if (!activeWorkspace) {
      setGitBranch(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api
        .workspaceGitBranch(activeWorkspace.id)
        .then((b) => !cancelled && setGitBranch(b))
        .catch(() => {});
    load();
    window.addEventListener("focus", load);
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
      clearInterval(timer);
    };
  }, [activeWorkspace]);

  // ---- actions ------------------------------------------------------------
  const bumpFocus = useCallback(() => setFocusTick((n) => n + 1), []);

  const setView = useCallback(
    (next: string) => {
      setViewState(next);
      api.prefSet("lastView", next).catch(() => {});
      bumpFocus();
    },
    [bumpFocus],
  );

  const setModal = useCallback(
    (m: ModalState) => {
      setModalState(m);
      if (!m) bumpFocus();
    },
    [bumpFocus],
  );

  const setPaletteOpen = useCallback(
    (openState: boolean) => {
      setPaletteOpenState(openState);
      if (!openState) bumpFocus();
    },
    [bumpFocus],
  );

  const setLayout = useCallback(
    (workspaceId: string, fn: (l: WorkspaceLayout) => WorkspaceLayout) => {
      setLayouts((prev) => {
        const current = prev[workspaceId] ?? emptyLayout();
        const next = fn(current);
        return next === current ? prev : { ...prev, [workspaceId]: next };
      });
    },
    [],
  );

  // Latest state for callbacks that must not be re-created constantly.
  const latest = useRef({ layouts, sessions, workspaces, view, shells, modal, paletteOpen, findFor });
  latest.current = { layouts, sessions, workspaces, view, shells, modal, paletteOpen, findFor };

  const focusedSessionId = useCallback((): string | null => {
    const { layouts: ls, view: v } = latest.current;
    const layout = ls[v];
    const tab = layout?.tabs.find((t) => t.id === layout.activeTab);
    return tab?.focus ?? null;
  }, []);

  const addWorkspace = useCallback(async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose a project folder",
      });
      if (!picked || Array.isArray(picked)) return;
      const ws = await api.workspaceCreate(picked);
      setWorkspaces((prev) => (prev.some((w) => w.id === ws.id) ? prev : [...prev, ws]));
      setLayouts((prev) => (prev[ws.id] ? prev : { ...prev, [ws.id]: emptyLayout() }));
      setView(ws.id);
    } catch (err) {
      fail(err);
    }
  }, [fail, setView]);

  const relinkWorkspace = useCallback(
    async (ws: Workspace) => {
      try {
        const picked = await open({
          directory: true,
          multiple: false,
          title: `Locate the folder for “${ws.name}”`,
        });
        if (!picked || Array.isArray(picked)) return;
        const saved = await api.workspaceRelink(ws.id, picked);
        setWorkspaces((prev) => prev.map((w) => (w.id === saved.id ? saved : w)));
        // Session folders inside the old root moved with it.
        setSessions(await api.sessionList());
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  const updateWorkspace = useCallback(
    (ws: Workspace) => {
      api
        .workspaceUpdate(ws)
        .then((saved) => setWorkspaces((prev) => prev.map((w) => (w.id === saved.id ? saved : w))))
        .catch(fail);
    },
    [fail],
  );

  const removeWorkspace = useCallback(
    (ws: Workspace) => {
      setModal({
        kind: "confirm",
        title: `Remove “${ws.name}” from NEXUS?`,
        message:
          "Its sessions will be closed and its layout forgotten. Your project files are not touched.",
        confirmLabel: "Remove workspace",
        danger: true,
        onConfirm: async () => {
          try {
            await api.workspaceRemove(ws.id);
            latest.current.sessions
              .filter((s) => s.workspaceId === ws.id)
              .forEach((s) => terminals.dispose(s.id));
            setSessions((prev) => prev.filter((s) => s.workspaceId !== ws.id));
            setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
            setLayouts((prev) => {
              const { [ws.id]: _removed, ...rest } = prev;
              return rest;
            });
            delete savedLayouts.current[ws.id];
            if (latest.current.view === ws.id) setView("dashboard");
          } catch (err) {
            fail(err);
          }
        },
      });
    },
    [fail, setModal, setView],
  );

  const newSession = useCallback<AppContext["newSession"]>(
    async (spec, placement = "tab") => {
      const wsId = latest.current.view;
      if (!latest.current.workspaces.some((w) => w.id === wsId)) {
        toast("Open a workspace first.");
        return;
      }
      const target = focusedSessionId();
      const size = target ? terminals.size(target) : undefined;
      try {
        const s = await api.sessionCreate({
          ...spec,
          workspaceId: wsId,
          cols: size?.cols,
          rows: size?.rows,
        });
        setSessions((prev) => [...prev, s]);
        setLayout(wsId, (l) =>
          placement !== "tab" && target ? splitPane(l, target, placement, s.id) : addTab(l, s.id),
        );
        bumpFocus();
      } catch (err) {
        fail(err);
      }
    },
    [bumpFocus, fail, focusedSessionId, setLayout, toast],
  );

  const runCommandPrompt = useCallback(
    (placement: Placement = "tab") => {
      setModal({
        kind: "input",
        title: "Run a command",
        label: "Program and arguments. Runs directly in this workspace, without a shell.",
        placeholder: "e.g. npm run dev",
        confirmLabel: "Run",
        onSubmit: (value) => {
          const argv = parseCommandLine(value);
          if (argv.length === 0) return;
          newSession(
            { kind: "command", program: argv[0], args: argv.slice(1), name: value.trim() },
            placement,
          );
        },
      });
    },
    [newSession, setModal],
  );

  const closeSession = useCallback(
    async (id: string) => {
      const s = latest.current.sessions.find((x) => x.id === id);
      if (!s) return;
      try {
        await api.sessionClose(id);
        terminals.dispose(id);
        setSessions((prev) => prev.filter((x) => x.id !== id));
        setLayout(s.workspaceId, (l) => removeSession(l, id));
        bumpFocus();
      } catch (err) {
        fail(err);
      }
    },
    [bumpFocus, fail, setLayout],
  );

  const startSession = useCallback(
    async (id: string, resume = false) => {
      const size = terminals.size(id);
      try {
        const s = await api.sessionStart(id, size?.cols, size?.rows, resume);
        setSessions((prev) => prev.map((p) => (p.id === s.id ? s : p)));
        bumpFocus();
      } catch (err) {
        fail(err);
      }
    },
    [bumpFocus, fail],
  );

  const renameSession = useCallback(
    (s: Session) => {
      setModal({
        kind: "input",
        title: "Rename session",
        initial: s.name,
        confirmLabel: "Rename",
        onSubmit: (name) => {
          if (!name.trim()) return;
          api
            .sessionUpdate(s.id, { name })
            .then((saved) => setSessions((prev) => prev.map((p) => (p.id === saved.id ? saved : p))))
            .catch(fail);
        },
      });
    },
    [fail, setModal],
  );

  const setSessionAccent = useCallback(
    (id: string, accent: string | null) => {
      api
        .sessionUpdate(id, accent ? { accent } : { clearAccent: true })
        .then((saved) => setSessions((prev) => prev.map((p) => (p.id === saved.id ? saved : p))))
        .catch(fail);
    },
    [fail],
  );

  const setSessionFontSize = useCallback(
    (id: string, size: number | null) => {
      const patch =
        size == null ? { clearFontSize: true } : { fontSize: Math.min(28, Math.max(9, size)) };
      api
        .sessionUpdate(id, patch)
        .then((saved) => setSessions((prev) => prev.map((p) => (p.id === saved.id ? saved : p))))
        .catch(fail);
    },
    [fail],
  );

  const restoreClosed = useCallback(
    async (closed: Session, resume = false) => {
      try {
        const s = await api.sessionStart(closed.id, undefined, undefined, resume);
        setSessions((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s]));
        setLayout(s.workspaceId, (l) => (sessionsInLayout(l).includes(s.id) ? l : addTab(l, s.id)));
        setModalState(null);
        setView(s.workspaceId);
      } catch (err) {
        fail(err);
      }
    },
    [fail, setLayout, setView],
  );

  const focusSession = useCallback(
    (id: string) => {
      const s = latest.current.sessions.find((x) => x.id === id);
      if (!s) return;
      setLayout(s.workspaceId, (l) => focusInLayout(l, id));
      if (latest.current.view !== s.workspaceId) setView(s.workspaceId);
      else bumpFocus();
    },
    [bumpFocus, setLayout, setView],
  );

  const setThemePref = useCallback((pref: ThemePref) => {
    setThemePrefState(pref);
    api.prefSet("theme", pref).catch(() => {});
  }, []);

  const setFontSize = useCallback((size: number) => {
    const clamped = Math.min(28, Math.max(9, size));
    setFontSizeState(clamped);
    api.prefSet("fontSize", String(clamped)).catch(() => {});
  }, []);

  const setPastePolicy = useCallback((policy: PastePolicy) => {
    setPastePolicyState(policy);
    api.prefSet("pastePolicy", policy).catch(() => {});
  }, []);

  // Multi-line pastes are held until the user confirms (PRD 7.4).
  useEffect(() => {
    terminals.setPasteGuard(pastePolicy, (id, text, bracketed) => {
      const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      const shown = lines.slice(0, 12).map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l));
      if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`);
      const count = lines.length === 1 ? "a line break" : `${lines.length} lines`;
      setModal({
        kind: "confirm",
        title: `Paste ${count} into the terminal?`,
        message: bracketed
          ? "The program in this terminal receives pasted text as one block, but check it before you continue."
          : "Each line break is sent as Enter, so commands can start running straight away.",
        detail: shown.join("\n"),
        confirmLabel: "Paste",
        onConfirm: () => {
          terminals.paste(id, text, true);
          terminals.focus(id);
        },
      });
    });
    return () => terminals.setPasteGuard(pastePolicy, null);
  }, [pastePolicy, setModal]);

  const refreshAgents = useCallback(() => {
    api.agents().then(setAgents).catch(fail);
    api.shells().then(setShells).catch(fail);
  }, [fail]);

  // ---- keyboard shortcuts ---------------------------------------------------
  const isMac = info?.platform === "macos";
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      const st = latest.current;
      if (e.key === "Escape" && st.paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      const mod = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      const layout = st.layouts[st.view];
      const digit = /^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
      const tabSwitch = digit > 0 && (isMac ? mod && !e.shiftKey : e.altKey && !e.ctrlKey && !e.metaKey);

      let handled = true;
      if (tabSwitch) {
        const tab = layout?.tabs[digit - 1];
        if (tab) {
          setLayout(st.view, (l) => ({ ...l, activeTab: tab.id }));
          bumpFocus();
        }
      } else if (!mod) {
        handled = false;
      } else if (e.code === "KeyK" || e.code === "KeyP") {
        setPaletteOpen(!st.paletteOpen);
      } else if (st.modal || st.paletteOpen) {
        handled = false;
      } else if (e.code === "KeyT" && isMac && e.shiftKey) {
        reopenLastClosed();
      } else if (e.code === "KeyR" && !isMac) {
        reopenLastClosed();
      } else if (e.code === "KeyT") {
        newSession({ kind: "shell" }, "tab");
      } else if (e.code === "KeyD") {
        newSession({ kind: "shell" }, isMac && e.shiftKey ? "col" : "row");
      } else if (e.code === "KeyE" && !isMac) {
        newSession({ kind: "shell" }, "col");
      } else if (e.code === "KeyW") {
        const id = focusedSessionId();
        if (id) closeSession(id);
      } else if (e.code === "KeyF") {
        const id = focusedSessionId();
        if (id) setFindFor(st.findFor === id ? null : id);
      } else if (e.code === "BracketRight" || e.code === "BracketLeft") {
        const tab = layout?.tabs.find((t) => t.id === layout.activeTab);
        if (tab) {
          const ids = sessionsIn(tab.root);
          const step = e.code === "BracketRight" ? 1 : -1;
          const next = ids[(ids.indexOf(tab.focus) + step + ids.length) % ids.length];
          focusSession(next);
        }
      } else if (!isMac && e.code === "KeyC") {
        const id = focusedSessionId();
        const text = id ? terminals.selection(id) : "";
        if (text) writeText(text).catch(() => {});
      } else if (!isMac && e.code === "KeyV") {
        const id = focusedSessionId();
        if (id) readText().then((text) => text && terminals.paste(id, text)).catch(() => {});
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const reopenLastClosed = () => {
      api
        .sessionListClosed()
        .then((list) => {
          const st = latest.current;
          const candidate =
            list.find((s) => s.workspaceId === st.view) ??
            list.find((s) => st.workspaces.some((w) => w.id === s.workspaceId));
          if (candidate) restoreClosed(candidate);
          else toast("No recently closed sessions.");
        })
        .catch(fail);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    info,
    isMac,
    bumpFocus,
    closeSession,
    fail,
    focusSession,
    focusedSessionId,
    newSession,
    restoreClosed,
    setLayout,
    setPaletteOpen,
    toast,
  ]);

  if (fatal) {
    return (
      <div className="fatal">
        <h1>NEXUS could not start</h1>
        <p>{fatal}</p>
      </div>
    );
  }
  if (!info) return <div className="boot" />;

  const ctx: AppContext = {
    info,
    isMac: !!isMac,
    shells,
    agents,
    workspaces,
    sessions,
    layouts,
    activity,
    view,
    activeWorkspace,
    gitBranch,
    themePref,
    fontSize,
    pastePolicy,
    focusTick,
    findFor,
    setView,
    addWorkspace,
    updateWorkspace,
    removeWorkspace,
    relinkWorkspace,
    newSession,
    runCommandPrompt,
    closeSession,
    startSession,
    renameSession,
    setSessionAccent,
    setSessionFontSize,
    restoreClosed,
    focusSession,
    setLayout,
    setModal,
    setPaletteOpen,
    setThemePref,
    setFontSize,
    setPastePolicy,
    setFindFor,
    refreshAgents,
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app ${isMac ? "is-mac" : ""}`}>
        <Sidebar />
        <main className="main">
          {activeWorkspace ? (
            <WorkspaceView key={activeWorkspace.id} workspace={activeWorkspace} />
          ) : workspaces.length === 0 ? (
            <Welcome />
          ) : (
            <Dashboard />
          )}
        </main>
        {paletteOpen && <Palette />}
        {modal && <Modal modal={modal} />}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function sessionsInLayout(l: WorkspaceLayout): string[] {
  return l.tabs.flatMap((t) => sessionsIn(t.root));
}
