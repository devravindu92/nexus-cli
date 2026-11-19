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

export type PastePolicy = "always" | "auto" | "never";

/** Called instead of pasting when a paste needs the user's confirmation. */
export type PasteGuard = (id: string, text: string, bracketed: boolean) => void;

const entries = new Map<string, Entry>();
const fontOverrides = new Map<string, number>();
let appearance: Appearance = { theme: {}, fontSize: 13, fontFamily: DEFAULT_FONT };
let pastePolicy: PastePolicy = "always";
let pasteGuard: PasteGuard | null = null;

const fontSizeFor = (id: string) => fontOverrides.get(id) ?? appearance.fontSize;

/**
 * Pasted line breaks are sent as Enter, so a multi-line paste can run commands
 * before the user has read them (PRD 7.4). Programs that turn on bracketed
 * paste receive the text as one block instead; "auto" trusts that.
 */
function needsPasteConfirm(text: string, bracketed: boolean): boolean {
  if (pastePolicy === "never" || !/[\r\n]/.test(text)) return false;
  return pastePolicy === "always" || !bracketed;
}

let scrollback = 5000;

function ensure(id: string): Entry {
  let entry = entries.get(id);
  if (entry) return entry;
  const term = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    scrollback,
    fontSize: fontSizeFor(id),
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
  // Capture phase: runs before xterm's own paste handling on its textarea.
  el.addEventListener(
    "paste",
    (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const bracketed = term.modes.bracketedPasteMode;
      if (pasteGuard && needsPasteConfirm(text, bracketed)) {
        e.preventDefault();
        e.stopPropagation();
        pasteGuard(id, text, bracketed);
      }
    },
    true,
  );
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

  /** Paste text; `confirmed` skips the multi-line check (the user said yes). */
  paste(id: string, text: string, confirmed = false) {
    const entry = entries.get(id);
    if (!entry) return;
    const bracketed = entry.term.modes.bracketedPasteMode;
    if (!confirmed && pasteGuard && needsPasteConfirm(text, bracketed)) {
      pasteGuard(id, text, bracketed);
      return;
    }
    entry.term.paste(text);
  },

  setPasteGuard(policy: PastePolicy, guard: PasteGuard | null) {
    pastePolicy = policy;
    pasteGuard = guard;
  },

  /** Per-session font size; null goes back to the global size. */
  setFontOverride(id: string, size: number | null) {
    if ((fontOverrides.get(id) ?? null) === size) return;
    if (size == null) fontOverrides.delete(id);
    else fontOverrides.set(id, size);
    const entry = entries.get(id);
    if (entry) {
      entry.term.options.fontSize = fontSizeFor(id);
      this.fit(id);
    }
  },

  find(id: string, query: string, backwards = false) {
    const entry = entries.get(id);
    if (!entry || !query) return false;
    return backwards ? entry.search.findPrevious(query) : entry.search.findNext(query);
  },

  clearFind(id: string) {
    entries.get(id)?.search.clearDecorations();
  },

  /** Lines kept per terminal. Fewer lines means less memory per session. */
  setScrollback(lines: number) {
    scrollback = lines;
    for (const entry of entries.values()) entry.term.options.scrollback = lines;
  },

  setAppearance(next: Appearance) {
    appearance = next;
    for (const [id, entry] of entries) {
      entry.term.options.theme = next.theme;
      entry.term.options.fontSize = fontSizeFor(id);
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
    fontOverrides.delete(id);
  },
};
