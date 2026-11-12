import type { SharedArtifactEntry } from "@harness/api";

/**
 * When the user last saw each Shared Artifact (its `updated_ms` then), kept in localStorage.
 * `since`: when this record started; artifacts not in `seen` count as seen at `since`, so a first
 * run shows no dots, but an artifact made or changed after it does.
 */
export type SharedSeen = { since: number; seen: Record<string, number> };

export const isSharedSeen = (v: unknown): v is SharedSeen =>
   typeof v === "object" &&
   v !== null &&
   typeof (v as SharedSeen).since === "number" &&
   typeof (v as SharedSeen).seen === "object" &&
   (v as SharedSeen).seen !== null;

/** Artifacts whose title contains `query` (case-insensitive), most recently updated first. */
export function visibleShared(list: readonly SharedArtifactEntry[], query: string) {
   const q = query.trim().toLowerCase();
   return list
      .filter((e) => !q || e.meta.title.toLowerCase().includes(q))
      .sort((a, b) => b.meta.updated_ms - a.meta.updated_ms);
}

/** The change dot: updated since the user last saw it, and not open now. */
export function hasChanged(
   e: SharedArtifactEntry,
   seen: SharedSeen,
   selected: string | null,
): boolean {
   if (e.meta.id === selected) return false;
   return e.meta.updated_ms > (seen.seen[e.meta.id] ?? seen.since);
}

/** `seen` with `id` marked seen at `updated`; the same object when nothing changes. */
export function markSeen(seen: SharedSeen, id: string, updated: number): SharedSeen {
   if ((seen.seen[id] ?? seen.since) >= updated) return seen;
   return { ...seen, seen: { ...seen.seen, [id]: updated } };
}
