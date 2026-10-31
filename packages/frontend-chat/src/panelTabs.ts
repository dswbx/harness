/** The right panel: which view is shown, plus the open Side Threads. Pure, so the toggle rules are testable. */
export type PanelView =
  | { kind: "side" }
  | { kind: "changes" }
  | { kind: "terminal" }
  /** The raw Session Log. */
  | { kind: "events" }
  | { kind: "artifacts" }
  /** A right-placed `render_ui` item. */
  | { kind: "slot"; id: string };

export type PanelState = {
  /** Open Side Threads, in tab order. Closing only hides one; it stays in the Session Log (ADR 0018). */
  threads: string[];
  /** The Side Thread shown in the side view. */
  thread: string | null;
  /** The view shown; null: the panel is closed. */
  view: PanelView | null;
};

export const emptyPanel: PanelState = { threads: [], thread: null, view: null };

export const viewKey = (v: PanelView) => (v.kind === "slot" ? `slot:${v.id}` : v.kind);
export const sameView = (a: PanelView | null, b: PanelView | null) => !!a && !!b && viewKey(a) === viewKey(b);

/** Shows `view`. */
export const showView = (s: PanelState, view: PanelView): PanelState => ({ ...s, view });

/** A toolbar button: shows the view, or closes the panel when it is the one shown. */
export const toggleView = (s: PanelState, view: PanelView): PanelState => (sameView(s.view, view) ? { ...s, view: null } : showView(s, view));

/** Opens a Side Thread (appended when new), makes it the active one and shows the side view. */
export function openThread(s: PanelState, id: string): PanelState {
  return { threads: s.threads.includes(id) ? s.threads : [...s.threads, id], thread: id, view: { kind: "side" } };
}

/** Selects an open Side Thread. */
export const selectThread = (s: PanelState, id: string): PanelState => (s.threads.includes(id) ? { ...s, thread: id } : s);

/** Closes a Side Thread; if it was active the neighbour on its left (else right) takes over. The last one closes the panel. */
export function closeThread(s: PanelState, id: string): PanelState {
  const at = s.threads.indexOf(id);
  if (at < 0) return s;
  const threads = s.threads.filter((t) => t !== id);
  const thread = s.thread === id ? (threads[at - 1] ?? threads[at] ?? null) : s.thread;
  const view = threads.length === 0 && s.view?.kind === "side" ? null : s.view;
  return { threads, thread, view };
}

const key = (sessionId: string) => `harness.chat.panel.${sessionId}`;

/** Per Session, so switching Sessions (and restarting the app) keeps it. The Terminal is not restored: it would start a shell. */
export function loadPanel(sessionId: string): PanelState {
  try {
    const v = JSON.parse(localStorage.getItem(key(sessionId)) ?? "null") as { threads?: unknown; thread?: unknown; view?: unknown } | null;
    const threads = Array.isArray(v?.threads) ? v.threads.filter((t): t is string => typeof t === "string") : [];
    const thread = typeof v?.thread === "string" && threads.includes(v.thread) ? v.thread : (threads.at(-1) ?? null);
    const x = v?.view as Record<string, unknown> | null | undefined;
    const view: PanelView | null =
      x?.kind === "side" || x?.kind === "changes" || x?.kind === "events" || x?.kind === "artifacts" ? { kind: x.kind } : x?.kind === "slot" && typeof x.id === "string" ? { kind: "slot", id: x.id } : null;
    return { threads, thread, view };
  } catch {
    return emptyPanel;
  }
}

export function savePanel(sessionId: string, s: PanelState) {
  try {
    const view = s.view?.kind === "terminal" ? null : s.view;
    if (s.threads.length || view) localStorage.setItem(key(sessionId), JSON.stringify({ threads: s.threads, thread: s.thread, view }));
    else localStorage.removeItem(key(sessionId));
  } catch { /* not kept */ }
}
