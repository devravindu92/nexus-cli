// NEXUS Web: read-only view of what linked desktops chose to sync.
// All text from the server is inserted with textContent, never as HTML.
(() => {
  const app = document.getElementById("app");
  let view = "login";
  let timer = null;

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "style") node.style.cssText = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Nexus-Web": "1" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed."), { status: res.status });
    return data;
  }

  const ago = (ts, now) => {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };

  const STATUS = {
    online: "● Online",
    stale: "◐ Not seen recently",
    offline: "○ Offline",
    revoked: "✕ Access revoked",
  };
  const SESSION = { running: "● Running", exited: "■ Exited", recoverable: "◌ Not running" };
  const AGENT = { working: "Working", waiting: "Waiting for input", permission: "⚠ Needs permission", completed: "Finished turn" };

  function authForm(mode) {
    const error = el("div", { class: "error", role: "alert" });
    const email = el("input", { type: "email", id: "email", autocomplete: "username", required: "" });
    const password = el("input", { type: "password", id: "password", required: "", minlength: mode === "signup" ? "10" : "1", autocomplete: mode === "signup" ? "new-password" : "current-password" });
    const code = el("input", { type: "password", id: "code", autocomplete: "off" });
    const form = el("form", {
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = "";
          try {
            await api("POST", mode === "signup" ? "/api/signup" : "/api/login", { email: email.value, password: password.value, code: code.value });
            view = "home";
            render();
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      el("label", { for: "email" }, "Email"), email,
      el("label", { for: "password" }, mode === "signup" ? "Password (at least 10 characters)" : "Password"), password,
      mode === "signup" ? [el("label", { for: "code" }, "Sign-up code (from whoever runs this server)"), code] : null,
      el("p", {}, el("button", { class: "primary", type: "submit" }, mode === "signup" ? "Create account" : "Sign in")),
      error,
    );
    return el("div", {},
      el("header", {}, el("h1", {}, "NEXUS Web")),
      el("p", { class: "muted" }, "See the workspaces and sessions your linked desktops have synced."),
      el("div", { class: "card" }, form),
      el("p", { class: "small" },
        el("button", { onclick: () => { view = mode === "signup" ? "login" : "signup"; render(); } },
          mode === "signup" ? "I already have an account" : "Create an account")),
    );
  }

  function pairCard() {
    const out = el("div", {});
    const start = async () => {
      try {
        const { code, expiresInSeconds } = await api("POST", "/api/devices/pair-code");
        out.replaceChildren(
          el("div", { class: "code", "aria-label": "Pairing code" }, code),
          el("p", { class: "small muted" }, `In NEXUS on your computer open Settings → Web companion, enter this code and choose Link. It works once and expires in ${Math.round(expiresInSeconds / 60)} minutes.`),
        );
      } catch (err) {
        out.replaceChildren(el("div", { class: "error" }, err.message));
      }
    };
    return el("div", { class: "card" }, el("div", { class: "row" }, el("h3", {}, "Link a computer"), el("button", { onclick: start }, "Get a pairing code")), out);
  }

  function deviceCard(d, now) {
    const s = d.state;
    const wsName = (id) => s?.workspaces.find((w) => w.id === id)?.name ?? "—";
    const act = async (path, question) => {
      if (question && !confirm(question)) return;
      await api("POST", path, { id: d.id }).catch((e) => alert(e.message));
      load();
    };
    const attention = (s?.sessions ?? []).filter((x) => x.state === "running" && x.agentState === "permission").length;
    return el("div", { class: "card" },
      el("div", { class: "row" },
        el("h3", {}, d.name), el("span", { class: "tag" }, d.platform || "desktop"),
        el("span", { class: `status ${d.status}` }, STATUS[d.status]),
        attention ? el("span", { class: "status attention" }, `⚠ ${attention} agent${attention === 1 ? " needs" : "s need"} permission`) : null,
        el("span", { style: "flex:1" }),
        d.status === "revoked"
          ? el("button", { onclick: () => act("/api/devices/forget") }, "Remove from list")
          : el("button", { class: "danger", onclick: () => act("/api/devices/revoke", `Revoke ${d.name}? It stops syncing at once and its synced data is deleted from the web.`) }, "Revoke access"),
      ),
      el("p", { class: "small muted" },
        d.status === "revoked" ? "This computer can no longer sync." :
        `Last heard from ${ago(d.lastSeenAt, now)} · data synced ${ago(d.syncedAt, now)}. This is a snapshot, not a live view.`),
      !s ? null : [
        el("h2", {}, `Workspaces (${s.workspaces.length})`),
        s.workspaces.length === 0 ? el("p", { class: "muted small" }, "None synced.") :
        el("table", {}, el("tr", {}, el("th", {}, "Workspace"), el("th", {}, "Folder"), el("th", {}, "Sessions")),
          s.workspaces.map((w) => {
            const mine = s.sessions.filter((x) => x.workspaceId === w.id);
            return el("tr", {},
              el("td", {}, el("span", { class: "dot", style: `background:${w.accent || "#888"}` }), w.name, w.tags.map((t) => el("span", { class: "tag" }, t))),
              el("td", { class: "muted" }, w.path),
              el("td", {}, `${mine.filter((x) => x.state === "running").length} running of ${mine.length}`));
          })),
        el("h2", {}, `Sessions (${s.sessions.length})`),
        s.sessions.length === 0 ? el("p", { class: "muted small" }, "None.") :
        el("table", {}, el("tr", {}, el("th", {}, "Session"), el("th", {}, "Workspace"), el("th", {}, "Runs on"), el("th", {}, "State at last sync")),
          s.sessions.map((x) => el("tr", {},
            el("td", {}, x.name, el("span", { class: "tag" }, x.kind === "agent" ? (x.agent || "agent") : x.kind)),
            el("td", { class: "muted" }, wsName(x.workspaceId)),
            el("td", {}, x.remote ? `⇄ ${x.host}${x.durable ? " (tmux)" : ""}` : "Local"),
            el("td", {}, SESSION[x.state] || x.state,
              x.kind === "agent" && x.state === "running" ? ` · ${AGENT[x.agentState] || "State unknown"}` : "")))),
        s.hosts.length ? [
          el("h2", {}, `Remote machines (${s.hosts.length})`),
          el("table", {}, el("tr", {}, el("th", {}, "Machine"), el("th", {}, "Host"), el("th", {}, "Last check from this computer")),
            s.hosts.map((h) => el("tr", {},
              el("td", {}, h.name, h.environment ? el("span", { class: "tag" }, h.environment) : null),
              el("td", { class: "muted" }, h.target),
              el("td", {}, h.reachable == null ? "Not checked" : `${h.reachable ? "● Reachable" : "✕ Failed"} · ${ago(h.checkedAt, now)}`)))),
        ] : null,
        s.activity.length ? [
          el("h2", {}, "Recent activity"),
          el("table", {}, s.activity.slice(0, 15).map((a) => el("tr", {}, el("td", {}, a.message), el("td", { class: "muted" }, ago(a.ts, now))))),
        ] : null,
      ],
    );
  }

  async function load() {
    let data;
    try {
      data = await api("GET", "/api/overview");
    } catch (err) {
      if (err.status === 401) { view = "login"; return render(); }
      app.replaceChildren(el("div", { class: "error" }, err.message));
      return;
    }
    const now = data.serverTime;
    const wipe = async () => {
      if (!confirm("Delete everything your computers have synced? Your computers are not affected and will sync again unless you pause or unlink them.")) return;
      await api("POST", "/api/account/delete-data").catch((e) => alert(e.message));
      load();
    };
    const close = async () => {
      const password = prompt("This deletes your account, linked devices and all synced data. Enter your password to confirm.");
      if (!password) return;
      try { await api("POST", "/api/account/delete", { password }); view = "login"; render(); } catch (e) { alert(e.message); }
    };
    app.replaceChildren(...[
      el("header", {}, el("h1", {}, "NEXUS Web"), el("span", { class: "spacer" }), el("span", { class: "muted small" }, data.email),
        el("button", { onclick: load }, "Refresh"),
        el("button", { onclick: async () => { await api("POST", "/api/logout").catch(() => {}); view = "login"; render(); } }, "Sign out")),
      el("div", { class: "card note small" },
        "This page shows names and states your computers synced: workspaces, sessions, remote machines and recent activity. It never receives commands, terminal output, passwords or keys, and it cannot open or control a terminal. Live terminal access from the browser is not available in this version."),
      data.devices.length === 0 ? el("p", { class: "muted" }, "No computers linked yet.") : data.devices.map((d) => deviceCard(d, now)),
      pairCard(),
      el("h2", {}, "Account activity"),
      el("div", { class: "card" }, el("table", {}, data.audit.map((a) => el("tr", {}, el("td", {}, a.event), el("td", { class: "muted" }, a.detail), el("td", { class: "muted" }, ago(a.ts, now)))))),
      el("h2", {}, "Your data"),
      el("div", { class: "row" }, el("button", { class: "danger", onclick: wipe }, "Delete all synced data"), el("button", { class: "danger", onclick: close }, "Delete account")),
    ].flat());
  }

  function render() {
    clearInterval(timer);
    if (view === "home") {
      load();
      // Do not redraw while a pairing code is on screen.
      timer = setInterval(() => !document.hidden && !document.querySelector(".code") && load(), 30000);
    } else {
      app.replaceChildren(authForm(view));
    }
  }

  view = "home";
  render();
})();
