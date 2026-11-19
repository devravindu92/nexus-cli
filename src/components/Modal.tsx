import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, parseCommandLine, Session } from "../lib/api";
import { ProjectReview } from "./Project";
import { HostDialog, RemoteSessionDialog } from "./Remote";
import { canResume, kindLabel, ModalState, timeAgo, useApp } from "../lib/state";
import { PastePolicy } from "../lib/terminals";
import { ThemePref } from "../lib/themes";

export function Modal({ modal }: { modal: NonNullable<ModalState> }) {
  const app = useApp();
  const close = () => app.setModal(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        app.setModal(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [app]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`dialog ${modal.kind === "host" || modal.kind === "settings" ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={"title" in modal ? modal.title : modal.kind}>
        {modal.kind === "input" && <InputDialog modal={modal} close={close} />}
        {modal.kind === "confirm" && (
          <>
            <h2>{modal.title}</h2>
            <p>{modal.message}</p>
            {modal.detail && <pre className="dialog-detail">{modal.detail}</pre>}
            <div className="dialog-actions">
              {modal.altLabel && (
                <button
                  className="btn danger-text"
                  onClick={() => {
                    close();
                    modal.onAlt?.();
                  }}
                >
                  {modal.altLabel}
                </button>
              )}
              <span className="spacer" />
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button
                autoFocus
                className={`btn ${modal.danger ? "danger" : "primary"}`}
                onClick={() => {
                  close();
                  modal.onConfirm();
                }}
              >
                {modal.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </>
        )}
        {modal.kind === "host" && <HostDialog initial={modal.host} close={close} />}
        {modal.kind === "remote-session" && (
          <RemoteSessionDialog host={modal.host} placement={modal.placement} close={close} />
        )}
        {modal.kind === "project" && (
          <ProjectReview workspace={modal.workspace} status={modal.status} close={close} />
        )}
        {modal.kind === "closed" && <ClosedSessions />}
        {modal.kind === "settings" && <Settings close={close} />}
      </div>
    </div>
  );
}

function InputDialog({
  modal,
  close,
}: {
  modal: Extract<NonNullable<ModalState>, { kind: "input" }>;
  close: () => void;
}) {
  const [value, setValue] = useState(modal.initial ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        close();
        modal.onSubmit(value);
      }}
    >
      <h2>{modal.title}</h2>
      {modal.label && <p>{modal.label}</p>}
      <input
        autoFocus
        className="text-input"
        value={value}
        placeholder={modal.placeholder}
        aria-label={modal.title}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
      />
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          {modal.confirmLabel ?? "OK"}
        </button>
      </div>
    </form>
  );
}

function ClosedSessions() {
  const app = useApp();
  const [search, setSearch] = useState("");
  const [list, setList] = useState<Session[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .sessionListClosed(search)
      .then((l) => !cancelled && setList(l))
      .catch(() => !cancelled && setList([]));
    return () => {
      cancelled = true;
    };
  }, [search]);

  const forget = (s: Session) =>
    api.sessionForget(s.id).then(() => setList((l) => (l ?? []).filter((x) => x.id !== s.id)));

  return (
    <>
      <h2>Recently closed sessions</h2>
      <p>
        Restoring starts a <strong>new process</strong> with the saved name, folder and command. The old
        process and its output are gone.
      </p>
      <input
        autoFocus
        className="text-input"
        placeholder="Search by name, command or folder"
        aria-label="Search closed sessions"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="closed-list">
        {list && list.length === 0 && <p className="empty-hint">Nothing here.</p>}
        {list?.map((s) => {
          const ws = app.workspaces.find((w) => w.id === s.workspaceId);
          return (
            <div key={s.id} className="row static">
              <span className="row-main">
                <span className="row-title">{s.name}</span>
                <span className="row-sub">
                  {ws?.name ?? "—"} · {kindLabel(s, app.agents)} · closed{" "}
                  {s.closedAt ? timeAgo(s.closedAt) : ""}
                </span>
              </span>
              {canResume(s, app.agents) && (
                <button
                  className="btn"
                  title="Start a new process and ask the agent to continue its saved conversation"
                  onClick={() => app.restoreClosed(s, true)}
                >
                  Continue conversation
                </button>
              )}
              <button className="btn" onClick={() => app.restoreClosed(s)}>
                Restore
              </button>
              <button className="icon-btn" aria-label={`Forget ${s.name}`} title="Forget" onClick={() => forget(s)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Settings({ close }: { close: () => void }) {
  const app = useApp();
  const k = (mac: string, other: string) => (app.isMac ? mac : other);
  const shortcuts: [string, string][] = [
    ["Command palette", k("⌘K", "Ctrl+Shift+K")],
    ["New terminal tab", k("⌘T", "Ctrl+Shift+T")],
    ["Split right", k("⌘D", "Ctrl+Shift+D")],
    ["Split down", k("⌘⇧D", "Ctrl+Shift+E")],
    ["Close session", k("⌘W", "Ctrl+Shift+W")],
    ["Next / previous pane", k("⌘] / ⌘[", "Ctrl+Shift+] / [")],
    ["Switch to tab 1–9", k("⌘1–9", "Alt+1–9")],
    ["Find in scrollback", k("⌘F", "Ctrl+Shift+F")],
    ["Reopen closed session", k("⌘⇧T", "Ctrl+Shift+R")],
    ["Copy / paste", k("⌘C / ⌘V", "Ctrl+Shift+C / V")],
  ];
  const scrollback = Number(app.prefs.scrollback) || 5000;
  const [agentName, setAgentName] = useState("");
  const [agentCommand, setAgentCommand] = useState("");
  const exportSettings = async () => {
    const path = await save({ defaultPath: "nexus-settings.json", title: "Export NEXUS settings" }).catch(() => null);
    if (!path) return;
    api
      .settingsExport(path)
      .then(() => app.toast(`Settings exported to ${path}`))
      .catch((err) => app.toast(String(err)));
  };
  const importSettings = async () => {
    const path = await open({ multiple: false, title: "Import NEXUS settings" }).catch(() => null);
    if (typeof path !== "string") return;
    api
      .settingsImport(path)
      .then((summary) => {
        app.toast(`${summary} Restart NEXUS to apply imported preferences.`);
        app.refreshHosts();
        app.refreshAgents();
      })
      .catch((err) => app.toast(String(err)));
  };
  return (
    <>
      <h2>Settings</h2>
      <div className="setting">
        <label id="theme-label">Theme</label>
        <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
          {(["system", "dark", "light"] as ThemePref[]).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={app.themePref === t}
              className={app.themePref === t ? "on" : ""}
              onClick={() => app.setThemePref(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <label id="font-label">Terminal font size</label>
        <div className="stepper" role="group" aria-labelledby="font-label">
          <button className="btn" aria-label="Smaller" onClick={() => app.setFontSize(app.fontSize - 1)}>
            −
          </button>
          <span>{app.fontSize} px</span>
          <button className="btn" aria-label="Larger" onClick={() => app.setFontSize(app.fontSize + 1)}>
            +
          </button>
        </div>
      </div>
      <div className="setting">
        <label id="paste-label" title="Pasted line breaks are sent as Enter and can run commands immediately.">
          Confirm multi-line paste
        </label>
        <div className="segmented" role="radiogroup" aria-labelledby="paste-label">
          {(
            [
              ["always", "Always", "Ask before every paste that contains a line break"],
              ["auto", "If unsafe", "Ask only when the program has not enabled bracketed paste"],
              ["never", "Never", "Paste without asking"],
            ] as [PastePolicy, string, string][]
          ).map(([value, label, hint]) => (
            <button
              key={value}
              role="radio"
              aria-checked={app.pastePolicy === value}
              className={app.pastePolicy === value ? "on" : ""}
              title={hint}
              onClick={() => app.setPastePolicy(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <label id="scroll-label" title="Lines of history kept per terminal. Fewer lines use less memory.">
          Scrollback per terminal
        </label>
        <div className="segmented" role="radiogroup" aria-labelledby="scroll-label">
          {[1000, 5000, 10000, 50000].map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={scrollback === n}
              className={scrollback === n ? "on" : ""}
              onClick={() => app.setPref("scrollback", String(n))}
            >
              {n.toLocaleString()}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <label id="notify-label" title="Shown only while NEXUS is not the window in front.">
          Notify when an agent
        </label>
        <div className="checks" role="group" aria-labelledby="notify-label">
          {(
            [
              ["notifyPermission", "needs permission"],
              ["notifyCompleted", "finishes its turn"],
            ] as [string, string][]
          ).map(([key, label]) => (
            <label key={key} className="check inline">
              <input
                type="checkbox"
                checked={app.prefs[key] !== "off"}
                onChange={(e) => app.setPref(key, e.target.checked ? "on" : "off")}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <h3>Custom agents</h3>
      <p className="fine">
        Launch profiles for other terminal agents. They start like the built-in ones but report no state.
      </p>
      {app.agents
        .filter((a) => a.custom)
        .map((a) => (
          <div key={a.id} className="row static">
            <span className="row-main">
              <span className="row-title">{a.name}</span>
              <span className="row-sub">
                {[a.program, ...a.args].join(" ")}
                {a.available ? "" : " — not found on PATH"}
              </span>
            </span>
            <button
              className="icon-btn"
              aria-label={`Remove ${a.name}`}
              title="Remove"
              onClick={() => api.customAgentRemove(a.id).then(app.setAgentList).catch((e) => app.toast(String(e)))}
            >
              ×
            </button>
          </div>
        ))}
      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          const argv = parseCommandLine(agentCommand);
          if (!agentName.trim() || argv.length === 0) return;
          api
            .customAgentSave(agentName.trim(), argv[0], argv.slice(1))
            .then((list) => {
              app.setAgentList(list);
              setAgentName("");
              setAgentCommand("");
            })
            .catch((err) => app.toast(String(err)));
        }}
      >
        <input className="text-input" aria-label="Agent name" placeholder="Name" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
        <input className="text-input grow" aria-label="Agent command" placeholder="Command, e.g. my-agent --fast" spellCheck={false} autoCapitalize="off" value={agentCommand} onChange={(e) => setAgentCommand(e.target.value)} />
        <button type="submit" className="btn">
          Add
        </button>
      </form>

      <h3>Move settings between computers</h3>
      <p className="fine">
        Preferences, custom agents and remote machine profiles. There are no passwords or keys to leave
        out, because NEXUS stores none.
      </p>
      <div className="input-row">
        <button className="btn" onClick={exportSettings}>
          Export…
        </button>
        <button className="btn" onClick={importSettings}>
          Import…
        </button>
      </div>

      <h3>Keyboard shortcuts</h3>
      <div className="shortcuts">
        {shortcuts.map(([label, keys]) => (
          <div key={label} className="shortcut">
            <span>{label}</span>
            <kbd>{keys}</kbd>
          </div>
        ))}
      </div>
      <p className="fine">
        NEXUS {app.info.version} · local-first: no account, no telemetry, nothing leaves this computer.
      </p>
      <div className="dialog-actions">
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </>
  );
}
