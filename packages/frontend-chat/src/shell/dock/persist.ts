import { sessionJson } from "../../lib/jsonStore";
import {
   DEFAULT_SIZES,
   defaultLayout,
   type Layout,
   noOpen,
   noZones,
   type Sizes,
   show,
   ZONES,
} from "./model";

/**
 * A Session's layout in localStorage, by version. Panel ids in it are persisted: they never change.
 * - v0: `harness.chat.panel.<id>`, the old right-panel state (one view); migrated by `migratePanel`.
 * - v1: `harness.chat.layout.<id>` without a `v` field: `{ zones, open, sizes }` (and, in older builds, the Side chats tabs).
 * - v2: the same key, `{ v: 2, zones, open, sizes }`. The Side chats tabs have their own key (`threadTabs.ts`).
 * A value of a later version is read as far as it matches v2.
 */
const KEY = (sessionId: string) => `harness.chat.layout.${sessionId}`;
const OLD_KEY = (sessionId: string) => `harness.chat.panel.${sessionId}`;
/** The Side chats tabs' key (owned by `features/sideChats/threadTabs.ts`); only checked for here. */
const TABS_KEY = (sessionId: string) => `harness.chat.sideThreads.${sessionId}`;

const VERSION = 2;

const num = (x: unknown, d: number, min: number, max: number) =>
   typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : d;

const isId = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/**
 * Reads a stored layout (v1 or v2), dropping what is invalid. An id that no panel registers is kept in its
 * place (a newer build may know it); duplicates go. The Terminal is restored open like every panel; nothing
 * is expanded.
 */
export function parseLayout(raw: unknown): Layout {
   const d = defaultLayout();
   const v = (raw ?? {}) as {
      zones?: Record<string, unknown>;
      open?: Record<string, unknown>;
      sizes?: Record<string, unknown>;
   };
   const seen = new Set<string>();
   const zones = noZones();
   for (const z of ZONES) {
      const list = v.zones?.[z];
      if (!Array.isArray(list)) continue;
      for (const id of list) {
         if (isId(id) && !seen.has(id)) {
            seen.add(id);
            zones[z].push(id);
         }
      }
   }
   const open = noOpen();
   for (const z of ZONES) {
      const id = v.open?.[z];
      if (isId(id) && zones[z].includes(id)) open[z] = id;
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
   // Nothing stored for the zones at all: the defaults (reconcile fills in any panel a stored layout lacks).
   return seen.size === 0
      ? { ...d, open: noOpen(), sizes }
      : { zones, open, sizes, expanded: null };
}

/** The old right-panel state (`harness.chat.panel.<id>`: one view; its threads went to the Side chats tabs) as a layout: its view opens in its zone. */
export function migratePanel(raw: unknown): Layout {
   const v = (raw ?? {}) as { view?: unknown };
   const x = v.view as Record<string, unknown> | null | undefined;
   const id: string | null =
      x?.kind === "side" || x?.kind === "changes" || x?.kind === "events" || x?.kind === "artifacts"
         ? x.kind
         : x?.kind === "slot" && typeof x.id === "string" && x.id
           ? `slot:${x.id}`
           : null;
   const base = defaultLayout();
   if (!id) return base;
   // A slot is not in the default zones yet: it was right-placed, so it starts in right top.
   const withId = id.startsWith("slot:")
      ? { ...base, zones: { ...base.zones, rightTop: [...base.zones.rightTop, id] } }
      : base;
   return show(withId, id);
}

const readJson = (key: string, sessionId: string): unknown => sessionJson(key, sessionId).get();

/** Per Session, so switching Sessions (and restarting the app) keeps it. Migrates the old right-panel key. */
export function loadLayout(sessionId: string): Layout {
   const stored = readJson(KEY(sessionId), sessionId);
   if (stored !== undefined) return parseLayout(stored);
   const old = readJson(OLD_KEY(sessionId), sessionId);
   return old !== undefined ? migratePanel(old) : defaultLayout();
}

/** Open Side Thread tabs an older value kept in its `threads` field. */
const hasOldTabs = (v: unknown) =>
   v && typeof v === "object" && Array.isArray((v as { threads?: unknown }).threads)
      ? (v as { threads: unknown[] }).threads.length > 0
      : false;

export function saveLayout(sessionId: string, l: Layout) {
   try {
      const open = l.open;
      // The Side chats tabs keep their own key. Until it exists, the `threads`/`thread` fields of the value
      // this replaces (v1, or the v0 key) travel along untouched, so no tab is lost whatever the order of the
      // two writes. An older build reads them too.
      const prev = readJson(KEY(sessionId), sessionId) ?? readJson(OLD_KEY(sessionId), sessionId);
      const kept: Record<string, unknown> = {};
      if (hasOldTabs(prev) && !sessionJson(TABS_KEY(sessionId), sessionId).has()) {
         for (const k of ["threads", "thread"]) {
            const p = prev as Record<string, unknown>;
            if (k in p) kept[k] = p[k];
         }
      }
      const out = { v: VERSION, zones: l.zones, open, sizes: l.sizes, ...kept };
      const plain =
         Object.keys(kept).length === 0 &&
         ZONES.every((z) => !open[z]) &&
         JSON.stringify(out.zones) === JSON.stringify(defaultLayout().zones) &&
         JSON.stringify(out.sizes) === JSON.stringify(DEFAULT_SIZES);
      const own = sessionJson(KEY(sessionId), sessionId);
      if (plain) own.remove();
      else own.set(out);
      sessionJson(OLD_KEY(sessionId), sessionId).remove();
   } catch {
      /* not kept */
   }
}
