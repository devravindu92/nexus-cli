import { useCallback, useEffect, useState } from "react";
import { api, ProjectConfigStatus, ProjectSession, Workspace } from "../lib/api";
import { useApp } from "../lib/state";

/** Show argument boundaries: a review must not hide where one argument ends. */
const quoteArg = (arg: string) =>
  /^[A-Za-z0-9_\-./:=@%+,]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;

function sessionCommand(s: ProjectSession): string {
  if (s.kind === "command") return s.command.map(quoteArg).join(" ");
  if (s.kind === "agent") return [`agent: ${s.agent}`, ...s.args.map(quoteArg)].join(" ");
  return "your default shell";
}

/**
 * A slim bar shown when the project folder contains `.nexus/workspace.json`.
 * It never starts anything by itself: the file is untrusted until reviewed.
 */
export function ProjectBanner({ workspace }: { workspace: Workspace }) {
  const app = useApp();
  const [status, setStatus] = useState<ProjectConfigStatus | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(() => {
    api.projectConfigGet(workspace.id).then(setStatus).catch(() => setStatus(null));
  }, [workspace.id]);

  // Re-read when the window regains focus (the file may have been edited)
  // and after sessions start or a dialog closes (trust may have changed).
  const sessionCount = app.sessions.length;
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load, sessionCount, app.focusTick]);

  if (!status?.exists || hidden) return null;
  const count = status.config?.sessions.length ?? 0;

  if (status.error)
    return (
      <div className="banner warn" role="status">
        <span>
          ⚠ <code>.nexus/workspace.json</code> cannot be used: {status.error}
        </span>
        <button className="icon-btn" aria-label="Dismiss" onClick={() => setHidden(true)}>
          ×
        </button>
      </div>
    );
  if (count === 0) return null;

  const startTrusted = () =>
    api
      .projectConfigStart(workspace.id)
      .then((started) => {
        app.adoptSessions(started);
        setHidden(true);
      })
      .catch((err) => {
        app.toast(String(err));
        load();
      });

  return (
    <div className="banner" role="status">
      <span>
        {status.trusted
          ? `This project defines ${count} startup session${count === 1 ? "" : "s"} you have reviewed.`
          : status.changedSinceTrust
            ? `⚠ The project's startup sessions changed since you reviewed them. Nothing will run until you review them again.`
            : `This project defines ${count} startup session${count === 1 ? "" : "s"}. Nothing runs until you have reviewed them.`}
      </span>
      {status.trusted && (
        <button className="btn" onClick={startTrusted}>
          Start them
        </button>
      )}
      <button
        className={`btn ${status.trusted ? "" : "primary"}`}
        onClick={() => app.setModal({ kind: "project", workspace, status })}
      >
        {status.trusted ? "View" : "Review"}
      </button>
      <button className="icon-btn" aria-label="Dismiss" onClick={() => setHidden(true)}>
        ×
      </button>
    </div>
  );
}

/** Shows exactly what the project config would start, before anything runs. */
export function ProjectReview({
  workspace,
  status,
  close,
}: {
  workspace: Workspace;
  status: ProjectConfigStatus;
  close: () => void;
}) {
  const app = useApp();
  const config = status.config;
  if (!config) return null;

  const trustAndStart = () => {
    close();
    api
      .projectConfigStart(workspace.id, config)
      .then(app.adoptSessions)
      .catch((err) => app.toast(String(err)));
  };
  const untrust = () => {
    close();
    api.projectConfigUntrust(workspace.id).catch(() => {});
  };

  return (
    <>
      <h2>Startup sessions for {workspace.name}</h2>
      <p>
        These come from <code>.nexus/workspace.json</code> inside the project, so anyone who can change the
        project can change them. Check that you recognise every command. They run on this computer, as you.
      </p>
      {config.description && <p className="fine">{config.description}</p>}
      <div className="review-list">
        {config.sessions.map((s, i) => (
          <div key={i} className="review-row">
            <div className="row-title">
              {s.name} <span className="chip">{s.kind}</span>
            </div>
            <pre className="dialog-detail">{sessionCommand(s)}</pre>
            <div className="row-sub">in {s.cwd ? `${workspace.rootPath}/${s.cwd}` : workspace.rootPath}</div>
          </div>
        ))}
      </div>
      <p className="fine">
        Your approval covers this exact file. If it changes in any way, NEXUS asks again before running anything.
      </p>
      <div className="dialog-actions">
        {status.trusted && (
          <button className="btn danger-text" onClick={untrust}>
            Withdraw approval
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={close}>
          {status.trusted ? "Close" : "Not now"}
        </button>
        <button className="btn primary" onClick={trustAndStart}>
          {status.trusted ? "Start sessions" : "Trust and start"}
        </button>
      </div>
    </>
  );
}
