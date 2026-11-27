import { draftStorageKey, parseDraftKey, storedValue } from "@harness/api";
import { useCallback, useSyncExternalStore } from "react";
import type { PendingAttachment } from "./attachments";
import type { PromptSnapshot } from "./promptMarkdown";

/**
 * Half-written prompts, kept per composer (`composerKey`) so they survive switching Sessions or Threads.
 * The editor content goes to localStorage (it also survives a restart); attachments stay in memory
 * (image previews are data URLs, too big to store).
 */
const store = (key: string) =>
   storedValue<PromptSnapshot | null>({
      key: draftStorageKey(key),
      scope: { session: parseDraftKey(key).sessionId },
      parse: (raw) => (raw ? (JSON.parse(raw) as PromptSnapshot) : null),
      sync: false,
   });

export function getDraft(key: string): PromptSnapshot | null {
   return store(key).get();
}

/**
 * Stores `snap` for `key`; `null` (an empty box) removes it. False when it could not be saved
 * (storage full or blocked): the draft stays unsaved; the host is told once through `onStorageFailure`.
 */
export function setDraft(key: string, snap: PromptSnapshot | null): boolean {
   const s = store(key);
   return snap ? s.set(snap) : s.remove();
}

const EMPTY: PendingAttachment[] = [];
const files = new Map<string, PendingAttachment[]>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
   listeners.add(l);
   return () => listeners.delete(l);
};

export function updateDraftAttachments(
   key: string,
   f: (cur: PendingAttachment[]) => PendingAttachment[],
) {
   const next = f(files.get(key) ?? EMPTY);
   if (next.length) files.set(key, next);
   else files.delete(key);
   for (const l of listeners) l();
}

/** The attachments waiting in `key`'s composer (memory only: gone after a reload). */
export const getDraftAttachments = (key: string): PendingAttachment[] => files.get(key) ?? EMPTY;

/** Drops everything waiting in `key`'s composer (e.g. a closed side chat tab). */
export function clearDraft(key: string) {
   setDraft(key, null);
   if (files.has(key)) updateDraftAttachments(key, () => EMPTY);
}

/** The attachments waiting in `key`'s composer, with a setter like `useState`'s. */
export function useDraftAttachments(key: string) {
   const list = useSyncExternalStore(subscribe, () => files.get(key) ?? EMPTY);
   const set = useCallback(
      (v: PendingAttachment[] | ((cur: PendingAttachment[]) => PendingAttachment[])) =>
         updateDraftAttachments(key, typeof v === "function" ? v : () => v),
      [key],
   );
   return [list, set] as const;
}
