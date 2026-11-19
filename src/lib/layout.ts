// Pure layout model: tabs, each holding a binary split tree of session panes.

export type SplitDir = "row" | "col";

export type PaneNode =
  | { type: "leaf"; id: string; sessionId: string }
  | { type: "split"; id: string; dir: SplitDir; ratio: number; a: PaneNode; b: PaneNode };

export interface Tab {
  id: string;
  root: PaneNode;
  focus: string; // sessionId
}

export interface WorkspaceLayout {
  tabs: Tab[];
  activeTab: string | null;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export const emptyLayout = (): WorkspaceLayout => ({ tabs: [], activeTab: null });

const leaf = (sessionId: string): PaneNode => ({ type: "leaf", id: uid(), sessionId });

export function sessionsIn(node: PaneNode): string[] {
  return node.type === "leaf" ? [node.sessionId] : [...sessionsIn(node.a), ...sessionsIn(node.b)];
}

export function allSessions(layout: WorkspaceLayout): string[] {
  return layout.tabs.flatMap((t) => sessionsIn(t.root));
}

export function findTab(layout: WorkspaceLayout, sessionId: string): Tab | undefined {
  return layout.tabs.find((t) => sessionsIn(t.root).includes(sessionId));
}

export function addTab(layout: WorkspaceLayout, sessionId: string): WorkspaceLayout {
  const tab: Tab = { id: uid(), root: leaf(sessionId), focus: sessionId };
  return { tabs: [...layout.tabs, tab], activeTab: tab.id };
}

function splitNode(node: PaneNode, target: string, dir: SplitDir, sessionId: string): PaneNode {
  if (node.type === "leaf") {
    if (node.sessionId !== target) return node;
    return { type: "split", id: uid(), dir, ratio: 0.5, a: node, b: leaf(sessionId) };
  }
  return {
    ...node,
    a: splitNode(node.a, target, dir, sessionId),
    b: splitNode(node.b, target, dir, sessionId),
  };
}

/** Split the pane showing `target`, placing `sessionId` after it. */
export function splitPane(
  layout: WorkspaceLayout,
  target: string,
  dir: SplitDir,
  sessionId: string,
): WorkspaceLayout {
  const tab = findTab(layout, target);
  if (!tab) return addTab(layout, sessionId);
  return {
    activeTab: tab.id,
    tabs: layout.tabs.map((t) =>
      t.id === tab.id
        ? { ...t, root: splitNode(t.root, target, dir, sessionId), focus: sessionId }
        : t,
    ),
  };
}

function removeNode(node: PaneNode, sessionId: string): PaneNode | null {
  if (node.type === "leaf") return node.sessionId === sessionId ? null : node;
  const a = removeNode(node.a, sessionId);
  const b = removeNode(node.b, sessionId);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

export function removeSession(layout: WorkspaceLayout, sessionId: string): WorkspaceLayout {
  const tabs: Tab[] = [];
  let activeTab = layout.activeTab;
  layout.tabs.forEach((t, index) => {
    const root = removeNode(t.root, sessionId);
    if (!root) {
      if (activeTab === t.id) {
        const neighbour = layout.tabs[index + 1] ?? layout.tabs[index - 1];
        activeTab = neighbour ? neighbour.id : null;
      }
      return;
    }
    const remaining = sessionsIn(root);
    tabs.push({ ...t, root, focus: remaining.includes(t.focus) ? t.focus : remaining[0] });
  });
  return { tabs, activeTab };
}

function mapSplit(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: mapSplit(node.a, splitId, ratio), b: mapSplit(node.b, splitId, ratio) };
}

export function setRatio(layout: WorkspaceLayout, splitId: string, ratio: number): WorkspaceLayout {
  const clamped = Math.min(0.9, Math.max(0.1, ratio));
  return {
    ...layout,
    tabs: layout.tabs.map((t) => ({ ...t, root: mapSplit(t.root, splitId, clamped) })),
  };
}

export function focusSession(layout: WorkspaceLayout, sessionId: string): WorkspaceLayout {
  const tab = findTab(layout, sessionId);
  if (!tab) return layout;
  if (layout.activeTab === tab.id && tab.focus === sessionId) return layout;
  return {
    activeTab: tab.id,
    tabs: layout.tabs.map((t) => (t.id === tab.id ? { ...t, focus: sessionId } : t)),
  };
}

export function moveTab(layout: WorkspaceLayout, from: number, to: number): WorkspaceLayout {
  if (from === to || from < 0 || to < 0 || from >= layout.tabs.length || to >= layout.tabs.length)
    return layout;
  const tabs = [...layout.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { ...layout, tabs };
}

/**
 * Make a stored layout consistent with the sessions that actually exist:
 * drop panes whose session is gone, and give every unplaced session a tab.
 */
export function reconcile(stored: WorkspaceLayout | null, sessionIds: string[]): WorkspaceLayout {
  let layout = stored ?? emptyLayout();
  const known = new Set(sessionIds);
  for (const id of allSessions(layout)) {
    if (!known.has(id)) layout = removeSession(layout, id);
  }
  const placed = new Set(allSessions(layout));
  const previousActive = layout.activeTab;
  for (const id of sessionIds) {
    if (!placed.has(id)) layout = addTab(layout, id);
  }
  const active =
    previousActive && layout.tabs.some((t) => t.id === previousActive)
      ? previousActive
      : (layout.tabs[0]?.id ?? null);
  return { ...layout, activeTab: active };
}

export function parseLayout(json: string | null): WorkspaceLayout | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    if (value && Array.isArray(value.tabs)) return value as WorkspaceLayout;
  } catch {
    /* ignore corrupt layout: fall back to a rebuilt one */
  }
  return null;
}
