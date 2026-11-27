import { type Stored, storedValue, type TextAnchor } from "@harness/api";

/**
 * What the Inline Threads keep in web storage, per Session (versioned; old, missing or broken data reads as
 * empty, and a bad entry is dropped alone):
 * - drafts: questions not sent yet, by draft id (`draft:<uuid>`): the agent message (`itemId`) and the Anchor.
 *   The text itself is the composer's draft (`prompt/drafts.ts`).
 * - seen: per Inline Thread, the `turnEndedAt` the user last saw in its popover (unread state is frontend-only).
 */
export type InlineDraft = { itemId: string; anchor: TextAnchor };
export type InlineDrafts = Readonly<Record<string, InlineDraft>>;
export type InlineSeen = Readonly<Record<string, number>>;

const VERSION = 1;
const EMPTY = {};

const isAnchor = (a: unknown): a is TextAnchor => {
   const x = a as Partial<TextAnchor> | null;
   return (
      typeof x === "object" &&
      x !== null &&
      typeof x.thread_id === "string" &&
      typeof x.seq === "number" &&
      typeof x.quote === "string" &&
      typeof x.prefix === "string" &&
      typeof x.suffix === "string"
   );
};

/** The entries of a stored JSON object that pass `keep`; anything else is empty. */
function record<T>(raw: string | null, keep: (v: unknown) => v is T): Readonly<Record<string, T>> {
   if (raw === null) return EMPTY;
   let v: unknown;
   try {
      v = JSON.parse(raw);
   } catch {
      return EMPTY;
   }
   if (typeof v !== "object" || v === null || Array.isArray(v)) return EMPTY;
   const out: Record<string, T> = {};
   for (const [k, x] of Object.entries(v)) if (keep(x)) out[k] = x;
   return out;
}

const isDraft = (d: unknown): d is InlineDraft => {
   const x = d as Partial<InlineDraft> | null;
   return typeof x === "object" && x !== null && typeof x.itemId === "string" && isAnchor(x.anchor);
};
const isTime = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t);

export const draftsStore = (sessionId: string): Stored<InlineDrafts> =>
   storedValue({
      key: `harness.chat.inlineDrafts.${sessionId}`,
      scope: { session: sessionId },
      version: VERSION,
      parse: (raw) => record(raw, isDraft),
   });

export const seenStore = (sessionId: string): Stored<InlineSeen> =>
   storedValue({
      key: `harness.chat.inlineSeen.${sessionId}`,
      scope: { session: sessionId },
      version: VERSION,
      parse: (raw) => record(raw, isTime),
   });
