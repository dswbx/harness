import { codec, storedValue } from "@harness/api";
import { useMemo, useSyncExternalStore } from "react";

/**
 * Which artifacts are panels, as the user changed it (per Session, in storage, followed across windows).
 * `closed`: panel ids (render_ui ids, `shared:<id>`) the Agent placed left or right that the user took out of
 * the dock, each with the time of the Agent's call it showed then; the artifact stays in the Artifacts panel.
 * A later call with that id brings the panel back (a write of its file does not): the user sees the Agent still
 * changes it, and can tell it to stop. `added`: artifact keys the user made into a panel (an inline render_ui
 * item, a diagram, a table); they stay until the user closes them.
 */
export type DockedPanels = { closed: Record<string, number>; added: string[] };

export const NO_DOCKED: DockedPanels = { closed: {}, added: [] };

const strings = (v: unknown): string[] =>
   Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const times = (v: unknown): Record<string, number> =>
   typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
           Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"),
        )
      : {};

const isDocked = (v: unknown): v is DockedPanels =>
   typeof v === "object" && v !== null && "closed" in v && "added" in v;

const parse = (raw: string | null): DockedPanels => {
   const v = codec.json(isDocked, NO_DOCKED)(raw);
   return v === NO_DOCKED ? v : { closed: times(v.closed), added: strings(v.added) };
};

const stores = new Map<string, ReturnType<typeof storedValue<DockedPanels>>>();
const storeOf = (sessionId: string) => {
   let s = stores.get(sessionId);
   if (!s) {
      s = storedValue<DockedPanels>({
         key: `harness.chat.dockedPanels.${sessionId}`,
         scope: { session: sessionId },
         parse,
      });
      stores.set(sessionId, s);
   }
   return s;
};

/** The panel id of an artifact the user made into a panel: its render_ui id when it has one, else `a:<key>`. */
export const addedPanelId = (key: string) => (key.startsWith("ui:") ? key.slice(3) : `a:${key}`);

type ArtifactRef = { key: string; placement: string; slotId: string | null; ts: number };

/** Panel `id`, last called at `ts`, is closed: the user closed it and the Agent has not called it since. */
export const isClosed = (d: DockedPanels, id: string, ts: number) =>
   id in d.closed && ts <= d.closed[id]!;

/** The panel id of an artifact the Agent placed left or right (closed or not); null for others. */
export const placedPanelId = (a: Omit<ArtifactRef, "ts">) =>
   (a.placement === "left" || a.placement === "right") && a.slotId ? a.slotId : null;

/** The id of the artifact's panel in the dock now; null when it has none. */
export function panelIdOf(a: ArtifactRef, d: DockedPanels): string | null {
   const placed = placedPanelId(a);
   if (placed) return isClosed(d, placed, a.ts) ? null : placed;
   return d.added.includes(a.key) ? addedPanelId(a.key) : null;
}

/** Takes panel `id` (last called at `ts`) out of the dock: an added one is forgotten, a placed one is closed. */
export function closePanel(d: DockedPanels, id: string, ts: number): DockedPanels {
   const added = d.added.filter((k) => addedPanelId(k) !== id);
   if (added.length < d.added.length) return { ...d, added };
   return d.closed[id] === ts ? d : { ...d, closed: { ...d.closed, [id]: ts } };
}

/**
 * Makes an artifact a panel again: `placedId` is its panel id when the Agent placed it left or right (it is
 * reopened), else its key is added. Returns the state and the panel id.
 */
export function openAsPanel(
   d: DockedPanels,
   key: string,
   placedId: string | null,
): { next: DockedPanels; id: string } {
   if (placedId) {
      const { [placedId]: _, ...closed } = d.closed;
      return { next: { ...d, closed }, id: placedId };
   }
   const id = addedPanelId(key);
   return { next: d.added.includes(key) ? d : { ...d, added: [...d.added, key] }, id };
}

/** The Session's docked panels and a setter that takes the change as a function. */
export function useDockedPanels(sessionId: string) {
   const store = storeOf(sessionId);
   const value = useSyncExternalStore(store.subscribe, store.get);
   return useMemo(
      () => ({
         value,
         update: (f: (d: DockedPanels) => DockedPanels) => {
            const cur = store.get();
            const next = f(cur);
            if (next !== cur) store.set(next);
         },
      }),
      [store, value],
   );
}
