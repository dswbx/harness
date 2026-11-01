/**
 * Where the chat's panels sit: six zones, one open panel per zone, sizes, and the open Side Threads.
 * Pure, so the rules (and the geometry the dock draws from) are testable. ADR 0019.
 */
export const ZONES = ["leftTop", "leftBottom", "bottomLeft", "bottomRight", "rightBottom", "rightTop"] as const;
export type Zone = (typeof ZONES)[number];

export const ZONE_LABEL: Record<Zone, string> = {
  leftTop: "Left top",
  leftBottom: "Left bottom",
  bottomLeft: "Bottom left",
  bottomRight: "Bottom right",
  rightBottom: "Right bottom",
  rightTop: "Right top",
};

export const isLeftZone = (z: Zone) => z === "leftTop" || z === "leftBottom";
export const isRightZone = (z: Zone) => z === "rightTop" || z === "rightBottom";
export const isBottomZone = (z: Zone) => z === "bottomLeft" || z === "bottomRight";

export const BASE_PANELS = ["side", "changes", "terminal", "events", "artifacts"] as const;
/** A panel: one of the built-in ones, or a `render_ui` item placed left or right (`slot:<id>`). */
export type PanelId = (typeof BASE_PANELS)[number] | `slot:${string}`;
export const slotPanel = (id: string): PanelId => `slot:${id}`;
export const isSlotPanel = (id: PanelId): id is `slot:${string}` => id.startsWith("slot:");
export const slotIdOf = (id: PanelId) => (isSlotPanel(id) ? id.slice(5) : null);
const isPanelId = (x: unknown): x is PanelId => typeof x === "string" && ((BASE_PANELS as readonly string[]).includes(x) || (x.startsWith("slot:") && x.length > 5));

export type Sizes = {
  /** Width of the left zones, of the right zones, height of the bottom zones (px). */
  left: number;
  right: number;
  bottom: number;
  /** Share of the sides' height the top zone takes when both halves are open; of the width the bottom-left zone takes when both bottom zones are open. */
  leftSplit: number;
  rightSplit: number;
  bottomSplit: number;
};

export type Layout = {
  /** Panels per zone, in stripe order. */
  zones: Record<Zone, PanelId[]>;
  /** The panel shown in each zone. */
  open: Record<Zone, PanelId | null>;
  sizes: Sizes;
  /** The panel grown to near full-screen (only while open). */
  expanded: PanelId | null;
  /** Open Side Threads, in tab order. Closing only hides one; it stays in the Session Log (ADR 0018). */
  threads: string[];
  /** The Side Thread shown in the side chats panel. */
  thread: string | null;
};

export const DEFAULT_SIZES: Sizes = { left: 280, right: 380, bottom: 240, leftSplit: 0.5, rightSplit: 0.55, bottomSplit: 0.5 };

const DEFAULT_ZONE: Record<(typeof BASE_PANELS)[number], Zone> = {
  changes: "leftTop",
  artifacts: "leftBottom",
  terminal: "bottomLeft",
  events: "bottomRight",
  side: "rightTop",
};

const noOpen = (): Record<Zone, PanelId | null> => ({ leftTop: null, leftBottom: null, bottomLeft: null, bottomRight: null, rightBottom: null, rightTop: null });

export function defaultLayout(): Layout {
  return {
    zones: { leftTop: ["changes"], leftBottom: ["artifacts"], bottomLeft: ["terminal"], bottomRight: ["events"], rightBottom: [], rightTop: ["side"] },
    open: noOpen(),
    sizes: { ...DEFAULT_SIZES },
    expanded: null,
    threads: [],
    thread: null,
  };
}

export function zoneOf(l: Layout, id: PanelId): Zone | null {
  return ZONES.find((z) => l.zones[z].includes(id)) ?? null;
}

export const isOpen = (l: Layout, id: PanelId) => ZONES.some((z) => l.open[z] === id);

/** The expanded panel only stays expanded while it is open. */
function settle(l: Layout): Layout {
  return l.expanded && !isOpen(l, l.expanded) ? { ...l, expanded: null } : l;
}

const setOpen = (l: Layout, zone: Zone, id: PanelId | null): Layout => settle({ ...l, open: { ...l.open, [zone]: id } });

/** A stripe icon or shortcut: opens the panel in its zone, or hides it when it is the one shown there. */
export function toggle(l: Layout, id: PanelId): Layout {
  const z = zoneOf(l, id);
  return z ? setOpen(l, z, l.open[z] === id ? null : id) : l;
}

/** Opens the panel in its zone (replacing what that zone showed). */
export function show(l: Layout, id: PanelId): Layout {
  const z = zoneOf(l, id);
  return z && l.open[z] !== id ? setOpen(l, z, id) : l;
}

/** Hides the panel if it is open; it keeps its stripe icon. */
export function hide(l: Layout, id: PanelId): Layout {
  const z = zoneOf(l, id);
  return z && l.open[z] === id ? setOpen(l, z, null) : l;
}

/**
 * Moves a panel to `zone`, at `index` of that zone's list as it was before the move (default: the end).
 * A panel that was open stays open in its new zone, replacing what that zone showed.
 */
export function move(l: Layout, id: PanelId, to: Zone, index?: number): Layout {
  const from = zoneOf(l, id);
  if (!from) return l;
  const zones = { ...l.zones, [from]: l.zones[from].filter((p) => p !== id) };
  const at = l.zones[from].indexOf(id);
  const list = from === to ? zones[from] : [...l.zones[to]];
  let i = index ?? l.zones[to].length;
  if (from === to && i > at) i--;
  i = Math.max(0, Math.min(list.length, i));
  zones[to] = [...list.slice(0, i), id, ...list.slice(i)];
  const open = { ...l.open };
  if (open[from] === id) {
    open[from] = null;
    open[to] = id;
  }
  return settle({ ...l, zones, open });
}

/** Grows an open panel to near full-screen, or shrinks (null). */
export const expand = (l: Layout, id: PanelId | null): Layout => (id === null ? (l.expanded ? { ...l, expanded: null } : l) : isOpen(l, id) ? { ...l, expanded: id } : l);

export const resize = (l: Layout, patch: Partial<Sizes>): Layout => ({ ...l, sizes: { ...l.sizes, ...patch } });

/** Opens a Side Thread (appended when new), makes it the active one and shows the side chats panel. */
export function openThread(l: Layout, id: string): Layout {
  return show({ ...l, threads: l.threads.includes(id) ? l.threads : [...l.threads, id], thread: id }, "side");
}

/** Selects an open Side Thread. */
export const selectThread = (l: Layout, id: string): Layout => (l.threads.includes(id) ? { ...l, thread: id } : l);

/** Closes a Side Thread; if it was active the neighbour on its left (else right) takes over. The last one hides the panel. */
export function closeThread(l: Layout, id: string): Layout {
  const at = l.threads.indexOf(id);
  if (at < 0) return l;
  const threads = l.threads.filter((t) => t !== id);
  const thread = l.thread === id ? (threads[at - 1] ?? threads[at] ?? null) : l.thread;
  const next = { ...l, threads, thread };
  return threads.length === 0 ? hide(next, "side") : next;
}

/** "Reset layout": default places and sizes; open Side Threads stay (and the panel shows when there are any). */
export function resetLayout(l: Layout): Layout {
  const next: Layout = { ...defaultLayout(), threads: l.threads, thread: l.thread };
  return l.threads.length ? show(next, "side") : next;
}

/**
 * Makes the layout agree with the panels that exist: built-in ones missing from `zones` go to their
 * default zone, ids that are neither built-in nor a slot are dropped, and `slots` not placed yet go to
 * their default zone (right top or left top). A slot the Agent removed keeps its spot (and comes back
 * there if re-added); it just has no icon. Returns `l` itself when nothing changes.
 */
export function reconcile(l: Layout, slots: { id: PanelId; zone: Zone }[]): Layout {
  const seen = new Set<PanelId>();
  const zones = {} as Record<Zone, PanelId[]>;
  let changed = false;
  for (const z of ZONES) {
    zones[z] = l.zones[z].filter((id) => {
      const ok = isPanelId(id) && !seen.has(id);
      if (ok) seen.add(id);
      else changed = true;
      return ok;
    });
  }
  for (const id of BASE_PANELS) {
    if (!seen.has(id)) {
      zones[DEFAULT_ZONE[id]].push(id);
      seen.add(id);
      changed = true;
    }
  }
  for (const s of slots) {
    if (!seen.has(s.id)) {
      zones[s.zone].push(s.id);
      seen.add(s.id);
      changed = true;
    }
  }
  const open = { ...l.open };
  for (const z of ZONES) {
    if (open[z] && !zones[z].includes(open[z]!)) {
      open[z] = null;
      changed = true;
    }
  }
  return changed ? settle({ ...l, zones, open }) : l;
}

export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_CHAT = 360;
const MIN_LEFT = 180;
const MIN_RIGHT = 220;
const MIN_BOTTOM = 120;
/** Height the chat keeps above the bottom zones. */
const MIN_CHAT_H = 220;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export type Geometry = {
  /** Rect per zone that has an open panel. */
  zones: Partial<Record<Zone, Rect>>;
  chat: Rect;
  /** Widths of the left and right columns, height of the bottom row, height above it (all 0 when nothing is open). */
  left: number;
  right: number;
  bottom: number;
  top: number;
};

/**
 * Rects (px, in a `w` x `h` dock) of the chat and every open zone. Sides split their height when both
 * halves are open, the bottom splits its width only when both bottom zones are open and spans the full
 * width under the sides, the chat keeps at least 360 px (the side columns shrink together to fit).
 */
export function computeRects(l: Layout, w: number, h: number): Geometry {
  const o = l.open;
  const s = l.sizes;
  const hasL = !!(o.leftTop || o.leftBottom);
  const hasR = !!(o.rightTop || o.rightBottom);
  const hasB = !!(o.bottomLeft || o.bottomRight);
  const bottom = hasB ? clamp(s.bottom, MIN_BOTTOM, h - MIN_CHAT_H) : 0;
  const top = h - bottom;
  let left = hasL ? s.left : 0;
  let right = hasR ? s.right : 0;
  const room = Math.max(0, w - MIN_CHAT);
  if (left + right > room) {
    const k = room / (left + right);
    left = Math.round(left * k);
    right = Math.round(right * k);
  }
  const zones: Partial<Record<Zone, Rect>> = {};
  if (hasL) {
    if (o.leftTop && o.leftBottom) {
      const t = Math.round(top * s.leftSplit);
      zones.leftTop = { x: 0, y: 0, w: left, h: t };
      zones.leftBottom = { x: 0, y: t, w: left, h: top - t };
    } else zones[o.leftTop ? "leftTop" : "leftBottom"] = { x: 0, y: 0, w: left, h: top };
  }
  if (hasR) {
    if (o.rightTop && o.rightBottom) {
      const t = Math.round(top * s.rightSplit);
      zones.rightTop = { x: w - right, y: 0, w: right, h: t };
      zones.rightBottom = { x: w - right, y: t, w: right, h: top - t };
    } else zones[o.rightTop ? "rightTop" : "rightBottom"] = { x: w - right, y: 0, w: right, h: top };
  }
  if (hasB) {
    if (o.bottomLeft && o.bottomRight) {
      const bw = Math.round(w * s.bottomSplit);
      zones.bottomLeft = { x: 0, y: top, w: bw, h: bottom };
      zones.bottomRight = { x: bw, y: top, w: w - bw, h: bottom };
    } else zones[o.bottomLeft ? "bottomLeft" : "bottomRight"] = { x: 0, y: top, w, h: bottom };
  }
  return { zones, chat: { x: left, y: 0, w: w - left - right, h: top }, left, right, bottom, top };
}

export type ResizeKind = keyof Sizes;

/** The value a drag may set, given the current geometry of the dock. */
export function clampSize(kind: ResizeKind, v: number, g: Geometry, w: number, h: number): number {
  switch (kind) {
    case "left": return Math.round(clamp(v, MIN_LEFT, Math.max(MIN_LEFT, w - MIN_CHAT - g.right)));
    case "right": return Math.round(clamp(v, MIN_RIGHT, Math.max(MIN_RIGHT, w - MIN_CHAT - g.left)));
    case "bottom": return Math.round(clamp(v, MIN_BOTTOM, Math.max(MIN_BOTTOM, h - MIN_CHAT_H)));
    case "bottomSplit": return clamp(v, 0.2, 0.8);
    default: return clamp(v, 0.15, 0.85);
  }
}

/** The layout with `id` shown in `zone` (and not where it was shown): what a drop would give, for the preview. */
export function withShownIn(l: Layout, id: PanelId, zone: Zone): Layout {
  const open = { ...l.open };
  for (const z of ZONES) if (open[z] === id) open[z] = null;
  open[zone] = id;
  return { ...l, open };
}

/** The layout with what cannot render (no icon, no content) taken out of `open`, for geometry and drawing. The stored layout keeps it, so it comes back. */
export function shownOpen(l: Layout, renderable: ReadonlySet<PanelId>): Layout {
  let changed = false;
  const open = { ...l.open };
  for (const z of ZONES) {
    if (open[z] && !renderable.has(open[z]!)) {
      open[z] = null;
      changed = true;
    }
  }
  if (!changed) return l;
  return { ...l, open, expanded: l.expanded && ZONES.some((z) => open[z] === l.expanded) ? l.expanded : null };
}

const KEY = (sessionId: string) => `harness.chat.layout.${sessionId}`;
const OLD_KEY = (sessionId: string) => `harness.chat.panel.${sessionId}`;

const num = (x: unknown, d: number, min: number, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : d);

/** Reads a stored layout, dropping what is invalid. The Terminal is never open again (it would start a shell), nothing is expanded. */
export function parseLayout(raw: unknown): Layout {
  const d = defaultLayout();
  const v = (raw ?? {}) as { zones?: Record<string, unknown>; open?: Record<string, unknown>; sizes?: Record<string, unknown>; threads?: unknown; thread?: unknown };
  const seen = new Set<PanelId>();
  const zones = noZones();
  for (const z of ZONES) {
    const list = v.zones?.[z];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (isPanelId(id) && !seen.has(id)) {
        seen.add(id);
        zones[z].push(id);
      }
    }
  }
  const open = noOpen();
  for (const z of ZONES) {
    const id = v.open?.[z];
    if (isPanelId(id) && id !== "terminal" && zones[z].includes(id)) open[z] = id;
  }
  const sz = v.sizes ?? {};
  const sizes: Sizes = {
    left: num(sz.left, d.sizes.left, 100, 4000),
    right: num(sz.right, d.sizes.right, 100, 4000),
    bottom: num(sz.bottom, d.sizes.bottom, 60, 4000),
    leftSplit: num(sz.leftSplit, d.sizes.leftSplit, 0.1, 0.9),
    rightSplit: num(sz.rightSplit, d.sizes.rightSplit, 0.1, 0.9),
    bottomSplit: num(sz.bottomSplit, d.sizes.bottomSplit, 0.1, 0.9),
  };
  const threads = Array.isArray(v.threads) ? v.threads.filter((t): t is string => typeof t === "string") : [];
  const thread = typeof v.thread === "string" && threads.includes(v.thread) ? v.thread : (threads.at(-1) ?? null);
  // Nothing stored for the zones at all: the defaults (reconcile fills in any panel a stored layout lacks).
  return seen.size === 0 ? { ...d, open: noOpen(), sizes, threads, thread } : { zones, open, sizes, expanded: null, threads, thread };
}

const noZones = (): Record<Zone, PanelId[]> => ({ leftTop: [], leftBottom: [], bottomLeft: [], bottomRight: [], rightBottom: [], rightTop: [] });

/** The old right-panel state (`harness.chat.panel.<id>`: threads, active thread, one view) as a layout: its view opens in its zone. */
export function migratePanel(raw: unknown): Layout {
  const v = (raw ?? {}) as { threads?: unknown; thread?: unknown; view?: unknown };
  const threads = Array.isArray(v.threads) ? v.threads.filter((t): t is string => typeof t === "string") : [];
  const thread = typeof v.thread === "string" && threads.includes(v.thread) ? v.thread : (threads.at(-1) ?? null);
  const x = v.view as Record<string, unknown> | null | undefined;
  const id: PanelId | null =
    x?.kind === "side" || x?.kind === "changes" || x?.kind === "events" || x?.kind === "artifacts" ? x.kind : x?.kind === "slot" && typeof x.id === "string" && x.id ? slotPanel(x.id) : null;
  const base: Layout = { ...defaultLayout(), threads, thread };
  if (!id) return base;
  // A slot is not in the default zones yet: it was right-placed, so it starts in right top.
  const withId = isSlotPanel(id) ? { ...base, zones: { ...base.zones, rightTop: [...base.zones.rightTop, id] } } : base;
  return show(withId, id);
}

function readJson(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s === null ? undefined : JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Per Session, so switching Sessions (and restarting the app) keeps it. Migrates the old right-panel key. */
export function loadLayout(sessionId: string): Layout {
  const stored = readJson(KEY(sessionId));
  if (stored !== undefined) return parseLayout(stored);
  const old = readJson(OLD_KEY(sessionId));
  return old !== undefined ? migratePanel(old) : defaultLayout();
}

export function saveLayout(sessionId: string, l: Layout) {
  try {
    const open = { ...l.open };
    for (const z of ZONES) if (open[z] === "terminal") open[z] = null;
    const out = { zones: l.zones, open, sizes: l.sizes, threads: l.threads, thread: l.thread };
    const plain = out.threads.length === 0 && ZONES.every((z) => !open[z]) && JSON.stringify(out.zones) === JSON.stringify(defaultLayout().zones) && JSON.stringify(out.sizes) === JSON.stringify(DEFAULT_SIZES);
    if (plain) localStorage.removeItem(KEY(sessionId));
    else localStorage.setItem(KEY(sessionId), JSON.stringify(out));
    localStorage.removeItem(OLD_KEY(sessionId));
  } catch { /* not kept */ }
}
