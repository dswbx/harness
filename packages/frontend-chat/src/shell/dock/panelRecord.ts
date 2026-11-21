import type { ComponentType } from "react";
import { useEffect, useMemo } from "react";
import { sessionJson } from "../../lib/jsonStore";
import type { PanelFamily } from "../../panels/contract";
import { FAMILIES } from "../panels";
import type { HostedPanel } from "../usePanelHost";

/**
 * The panels a Session had when it was last loaded, kept per Session next to its layout. Until the log is
 * here, they stand in for the panels that only exist after it (render_ui panels, a Side chat's tab, the
 * plan): their zones open at once and their stripe icons show, so the layout does not shift when the log
 * arrives. A hint only: once the log is here, the real statuses decide alone.
 */
const KEY = (sessionId: string) => `harness.chat.dockPanels.${sessionId}`;

/** One panel with an icon. `icon`: a family instance's icon name. `ready`: it could show. */
export type RecordedPanel = { id: string; label: string; icon?: string; ready: boolean };

/** A stored record; null when nothing is stored or any part of it is invalid. */
export function parseRecord(raw: unknown): RecordedPanel[] | null {
   const list = raw && typeof raw === "object" ? (raw as { panels?: unknown }).panels : undefined;
   if (!Array.isArray(list)) return null;
   const out: RecordedPanel[] = [];
   for (const p of list) {
      if (!p || typeof p !== "object") return null;
      const { id, label, icon, ready } = p as Record<string, unknown>;
      if (typeof id !== "string" || !id || typeof label !== "string") return null;
      if (typeof ready !== "boolean" || (icon !== undefined && typeof icon !== "string"))
         return null;
      out.push(icon ? { id, label, icon, ready } : { id, label, ready });
   }
   return out;
}

export const loadRecord = (sessionId: string) =>
   parseRecord(sessionJson(KEY(sessionId), sessionId).get());

export const saveRecord = (sessionId: string, panels: RecordedPanel[]) =>
   sessionJson(KEY(sessionId), sessionId).set({ panels });

/** The record of what can show now: the available panels, in host order. */
export function recordOf(
   entries: HostedPanel[],
   available: ReadonlySet<string>,
   renderable: ReadonlySet<string>,
): RecordedPanel[] {
   return entries.flatMap((e) =>
      available.has(e.id)
         ? [
              e.iconName
                 ? { id: e.id, label: e.label, icon: e.iconName, ready: renderable.has(e.id) }
                 : { id: e.id, label: e.label, ready: renderable.has(e.id) },
           ]
         : [],
   );
}

/**
 * Before the log is here: the recorded panels join the available and renderable ones. `placeholders`
 * (id to label): the recorded ready panels that cannot really show yet; they get an empty frame.
 */
export function beforeLoad(
   record: RecordedPanel[],
   now: { available: ReadonlySet<string>; renderable: ReadonlySet<string> },
) {
   const available = new Set(now.available);
   const renderable = new Set(now.renderable);
   const placeholders = new Map<string, string>();
   for (const p of record) {
      available.add(p.id);
      if (!p.ready || now.renderable.has(p.id)) continue;
      renderable.add(p.id);
      placeholders.set(p.id, p.label);
   }
   return { available, renderable, placeholders };
}

export type PanelHint = { label: string; icon?: ComponentType<{ className?: string }> };

const NO_PLACEHOLDERS: ReadonlyMap<string, string> = new Map();
const NO_HINTS: ReadonlyMap<string, PanelHint> = new Map();

/**
 * The panels the dock shows: `available` and `renderable` as they are, and before the log is here
 * (`loaded` false) with the Session's record added (`beforeLoad`); `hints` give the recorded panels' labels
 * and icons. Writes the record while loaded. The Quick overlay neither reads nor writes it.
 */
export function usePanelRecord(o: {
   sessionId: string;
   overlay: boolean;
   loaded: boolean;
   entries: HostedPanel[];
   available: ReadonlySet<string>;
   renderable: ReadonlySet<string>;
   /** The families whose `iconOf` maps a recorded icon name back (default: the registry). */
   // biome-ignore lint/suspicious/noExplicitAny: families of different model types
   families?: readonly PanelFamily<any>[];
}) {
   const { sessionId, overlay, loaded, entries, available, renderable, families = FAMILIES } = o;
   const record = useMemo(() => (overlay ? null : loadRecord(sessionId)), [overlay, sessionId]);

   // Only from the loaded state: the empty one before the log never replaces it.
   const next =
      loaded && !overlay ? JSON.stringify(recordOf(entries, available, renderable)) : null;
   useEffect(() => {
      if (next !== null) saveRecord(sessionId, JSON.parse(next));
   }, [sessionId, next]);

   return useMemo(() => {
      if (loaded || !record)
         return { available, renderable, placeholders: NO_PLACEHOLDERS, hints: NO_HINTS };
      const hints = new Map<string, PanelHint>();
      for (const p of record) {
         const family = families.find((f) => p.id.startsWith(`${f.prefix}:`));
         hints.set(p.id, { label: p.label, icon: p.icon ? family?.iconOf?.(p.icon) : undefined });
      }
      return { ...beforeLoad(record, { available, renderable }), hints };
   }, [loaded, record, available, renderable, families]);
}
