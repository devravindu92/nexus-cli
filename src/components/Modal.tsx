import { useEffect, useState } from "react";
import { api, Session } from "../lib/api";
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
      <div className="dialog" role="dialog" aria-modal="true" aria-label={"title" in modal ? modal.title : modal.kind}>
        {modal.kind === "input" && <InputDialog modal={modal} close={close} />}
        {modal.kind === "confirm" && (
          <>
            <h2>{modal.title}</h2>
            <p>{modal.message}</p>
            {modal.detail && <pre className="dialog-detail">{modal.detail}</pre>}
            <div className="dialog-actions">
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
