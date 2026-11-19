// Registry of live xterm instances. Terminals outlive React components so
// switching tabs/workspaces is instant and keeps scrollback.
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ITheme, Terminal } from "@xterm/xterm";
import { api } from "./api";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  opened: boolean;
  subscribed: boolean;
  everSubscribed: boolean;
}

export interface Appearance {
  theme: ITheme;
  fontSize: number;
  fontFamily: string;
}

export const DEFAULT_FONT =
  'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

const entries = new Map<string, Entry>();
let appearance: Appearance = { theme: {}, fontSize: 13, fontFamily: DEFAULT_FONT };

function ensure(id: string): Entry {
  let entry = entries.get(id);
  if (entry) return entry;
  const term = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    scrollback: 10000,
    fontSize: appearance.fontSize,
    fontFamily: appearance.fontFamily,
    theme: appearance.theme,
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.onData((data) => {
    api.terminalWrite(id, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    api.terminalResize(id, cols, rows).catch(() => {});
  });
  const el = document.createElement("div");
  el.className = "term-host";
  entry = { term, fit, search, el, opened: false, subscribed: false, everSubscribed: false };
  entries.set(id, entry);
  return entry;
}

export const terminals = {
  /** Place the terminal's DOM into `container` and size it. */
  mount(id: string, container: HTMLElement) {
    const entry = ensure(id);
    if (entry.el.parentElement !== container) container.appendChild(entry.el);
    if (!entry.opened) {
      entry.term.open(entry.el);
      entry.opened = true;
    }
    this.fit(id);
  },

  unmount(id: string, container: HTMLElement) {
    const entry = entries.get(id);
    if (entry && entry.el.parentElement === container) container.removeChild(entry.el);
  },

  fit(id: string) {
    const entry = entries.get(id);
    if (!entry || !entry.opened || !entry.el.isConnected) return;
    if (entry.el.clientWidth < 20 || entry.el.clientHeight < 20) return;
    try {
      entry.fit.fit();
    } catch {
      /* element not measurable yet */
    }
  },

  /** Stream process output into the terminal (idempotent per process run). */
  async subscribe(id: string) {
    const entry = ensure(id);
    if (entry.subscribed) return;
    entry.subscribed = true;
    if (entry.everSubscribed) {
      entry.term.write("\r\n\x1b[2m──── new process ────\x1b[0m\r\n");
    }
    entry.everSubscribed = true;
    const ok = await api
      .terminalSubscribe(id, (bytes) => entry.term.write(bytes))
      .catch(() => false);
    if (!ok) {
      entry.subscribed = false;
      return;
    }
    // Make sure the PTY matches the visible size.
    api.terminalResize(id, entry.term.cols, entry.term.rows).catch(() => {});
  },

  /** The process ended: the next run needs a fresh subscription. */
  markStopped(id: string) {
    const entry = entries.get(id);
    if (entry) entry.subscribed = false;
  },

  focus(id: string) {
    entries.get(id)?.term.focus();
  },

  size(id: string): { cols: number; rows: number } | undefined {
    const entry = entries.get(id);
    return entry?.opened ? { cols: entry.term.cols, rows: entry.term.rows } : undefined;
  },

  selection(id: string): string {
    return entries.get(id)?.term.getSelection() ?? "";
  },

  paste(id: string, text: string) {
    entries.get(id)?.term.paste(text);
  },

  find(id: string, query: string, backwards = false) {
    const entry = entries.get(id);
    if (!entry || !query) return false;
    return backwards ? entry.search.findPrevious(query) : entry.search.findNext(query);
  },

  clearFind(id: string) {
    entries.get(id)?.search.clearDecorations();
  },

  setAppearance(next: Appearance) {
    appearance = next;
    for (const [id, entry] of entries) {
      entry.term.options.theme = next.theme;
      entry.term.options.fontSize = next.fontSize;
      entry.term.options.fontFamily = next.fontFamily;
      this.fit(id);
    }
  },

  dispose(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.term.dispose();
    entry.el.remove();
    entries.delete(id);
  },
};
