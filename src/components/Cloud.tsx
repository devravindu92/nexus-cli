import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { api, CloudStatus } from "../lib/api";
import { timeAgo, useApp } from "../lib/state";

/**
 * Settings section for the optional web companion. Nothing is sent anywhere
 * until the user links this computer with a code from their own server.
 */
export function CloudSettings() {
  const app = useApp();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.cloudStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const un = listen("cloud-changed", refresh);
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

  const run = async (action: () => Promise<CloudStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setError(String(err));
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;

  if (!status.linked) {
    return (
      <>
        <h3>Web companion (optional)</h3>
        <p className="fine">
          Off. If you link this computer to a NEXUS Web server, it uploads the names and states of your
          workspaces, sessions and remote machines so you can see them in a browser. It never uploads
          commands, terminal output, passwords or keys, and the web page cannot control this computer.
        </p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.cloudLink(url, code, name || "My computer"));
          }}
        >
          <div className="form-grid">
            <label className="wide">
              Server address
              <input className="text-input" value={url} placeholder="https://…" spellCheck={false} autoCapitalize="off" onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label>
              Pairing code <span className="opt">from the web page</span>
              <input className="text-input" value={code} placeholder="XXXX-XXXX" spellCheck={false} autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} />
            </label>
            <label>
              Name for this computer
              <input className="text-input" value={name} placeholder="My computer" onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <div className="input-row">
            <button type="submit" className="btn" disabled={busy || !url.trim() || !code.trim()}>
              {busy ? "Linking…" : "Link this computer"}
            </button>
          </div>
        </form>
        {error && (
          <div className="callout bad" role="alert">
            {error}
          </div>
        )}
      </>
    );
  }

  const selected: string[] | null = (() => {
    try {
      const v = JSON.parse(app.prefs.cloudWorkspaces ?? "null");
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  })();
  const isOn = (id: string) => selected === null || selected.includes(id);
  const toggle = (id: string) => {
    const all = app.workspaces.map((w) => w.id);
    const current = selected ?? all;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    app.setPref("cloudWorkspaces", JSON.stringify(next));
    setPreview(null);
  };

  return (
    <>
      <h3>Web companion</h3>
      <div className={`callout ${status.lastError ? "bad" : status.paused ? "warn" : "ok"}`} role="status">
        <strong>
          {status.lastError ? "✕ Not syncing" : status.paused ? "❙❙ Paused" : "● Linked and syncing"}
        </strong>{" "}
        as “{status.deviceName}” to {status.url}
        <div>
          {status.lastError ??
            (status.lastSyncAt ? `Last upload ${timeAgo(status.lastSyncAt)}.` : "Nothing uploaded yet.")}
        </div>
      </div>
      <div className="input-row">
        <button className="btn" disabled={busy} onClick={() => run(api.cloudSyncNow)}>
          Sync now
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            app.setPref("cloudPaused", status.paused ? "off" : "on");
            setTimeout(refresh, 200);
          }}
        >
          {status.paused ? "Resume" : "Pause"}
        </button>
        <button className="btn" onClick={() => (preview ? setPreview(null) : api.cloudPreview().then(setPreview).catch((e) => setError(String(e))))}>
          {preview ? "Hide what is sent" : "Show what is sent"}
        </button>
      </div>
      {preview && <pre className="dialog-detail">{preview}</pre>}
      <p className="fine">Workspaces to include:</p>
      <div className="checks">
        {app.workspaces.map((w) => (
          <label key={w.id} className="check inline">
            <input type="checkbox" checked={isOn(w.id)} onChange={() => toggle(w.id)} />
            <span>{w.name}</span>
          </label>
        ))}
        <label className="check inline">
          <input
            type="checkbox"
            checked={app.prefs.cloudIncludeHosts !== "off"}
            onChange={(e) => {
              app.setPref("cloudIncludeHosts", e.target.checked ? "on" : "off");
              setPreview(null);
            }}
          />
          <span>Remote machine names</span>
        </label>
      </div>
      <div className="input-row">
        <button
          className="btn danger-text"
          disabled={busy}
          title="Removes what this computer uploaded and pauses syncing"
          onClick={() => run(api.cloudDeleteData)}
        >
          Delete my synced data
        </button>
        <button className="btn danger-text" disabled={busy} onClick={() => run(api.cloudUnlink)}>
          Unlink this computer
        </button>
      </div>
      {error && (
        <div className="callout bad" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
