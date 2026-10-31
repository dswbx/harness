/** The right panel: open tabs and the one shown. Pure, so the toggle rules are testable. */
export type PanelTab =
  | { kind: "changes" }
  | { kind: "terminal" }
  /** A right-placed `render_ui` item. */
  | { kind: "slot"; id: string }
  /** A Side Thread (ADR 0018). Closing only hides it; it stays in the Session Log. */
  | { kind: "thread"; id: string };

export type PanelState = { tabs: PanelTab[]; active: PanelTab | null };

export const emptyPanel: PanelState = { tabs: [], active: null };

export const tabKey = (t: PanelTab) => (t.kind === "slot" || t.kind === "thread" ? `${t.kind}:${t.id}` : t.kind);
export const sameTab = (a: PanelTab | null, b: PanelTab | null) => !!a && !!b && tabKey(a) === tabKey(b);

/** Opens `tab` (appended when new) and shows it. */
export function openTab(s: PanelState, tab: PanelTab): PanelState {
  const known = s.tabs.find((t) => sameTab(t, tab));
  return { tabs: known ? s.tabs : [...s.tabs, tab], active: known ?? tab };
}

/** Closes `tab`; if it was shown, the neighbour on its left (else right) takes over. */
export function closeTab(s: PanelState, tab: PanelTab): PanelState {
  const at = s.tabs.findIndex((t) => sameTab(t, tab));
  if (at < 0) return s;
  const tabs = s.tabs.filter((_, i) => i !== at);
  const active = sameTab(s.active, tab) ? (tabs[at - 1] ?? tabs[at] ?? null) : s.active;
  return { tabs, active };
}

/** A toolbar button: shows the tab, or closes it when it is the one shown. */
export const toggleTab = (s: PanelState, tab: PanelTab): PanelState => (sameTab(s.active, tab) ? closeTab(s, tab) : openTab(s, tab));

const key = (sessionId: string) => `harness.chat.panelTabs.${sessionId}`;

/** Per Session, so switching Sessions (and restarting the app) keeps it. The Terminal is not restored: it would start a shell. */
export function loadPanel(sessionId: string): PanelState {
  try {
    const v = JSON.parse(localStorage.getItem(key(sessionId)) ?? "null") as { tabs?: unknown; active?: unknown } | null;
    const ok = (t: unknown): t is PanelTab => {
      const x = t as Record<string, unknown> | null;
      return !!x && (x.kind === "changes" || ((x.kind === "slot" || x.kind === "thread") && typeof x.id === "string"));
    };
    const tabs = Array.isArray(v?.tabs) ? v.tabs.filter(ok) : [];
    const active = ok(v?.active) ? tabs.find((t) => sameTab(t, v.active as PanelTab)) ?? null : null;
    return { tabs, active };
  } catch {
    return emptyPanel;
  }
}

export function savePanel(sessionId: string, s: PanelState) {
  try {
    const tabs = s.tabs.filter((t) => t.kind !== "terminal");
    if (tabs.length) localStorage.setItem(key(sessionId), JSON.stringify({ tabs, active: s.active?.kind === "terminal" ? null : s.active }));
    else localStorage.removeItem(key(sessionId));
  } catch { /* not kept */ }
}
