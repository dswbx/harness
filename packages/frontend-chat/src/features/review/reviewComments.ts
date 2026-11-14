import { draftKey } from "@harness/api";
import { useMemo, useSyncExternalStore } from "react";
import {
   type DiffComment,
   type FileComment,
   isDiffComment,
   isFileComment,
   type NewComment,
   type ReviewComment,
} from "../../state/reviewCommentText";

export * from "../../state/reviewCommentText";

// Store: localStorage per Session, so the pop-out diff window and the main window share it.
// The `storage` event tells other windows; `listeners` tells this one.
const PREFIX = "harness.review-comments.";
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; list: ReviewComment[] }>();
const EMPTY: ReviewComment[] = [];

function readRaw(sessionId: string): string | null {
   try {
      return localStorage.getItem(PREFIX + sessionId);
   } catch {
      return null;
   }
}

export function getReviewComments(sessionId: string): ReviewComment[] {
   const raw = readRaw(sessionId);
   const hit = cache.get(sessionId);
   if (hit && hit.raw === raw) return hit.list;
   let list = EMPTY;
   try {
      const v: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(v)) list = v as ReviewComment[];
   } catch {
      // Corrupt entry: treat as empty.
   }
   cache.set(sessionId, { raw, list });
   return list;
}

export function setReviewComments(sessionId: string, list: ReviewComment[]) {
   try {
      if (list.length) localStorage.setItem(PREFIX + sessionId, JSON.stringify(list));
      else localStorage.removeItem(PREFIX + sessionId);
   } catch {
      // Storage blocked: comments stay unsaved.
   }
   for (const l of listeners) l();
}

/**
 * Whose composer holds the comments: the Main Thread's (the Session id, as the diff views use it) or a
 * Side Thread's own (its quotes are not sent to Main).
 */
export const composerKey = draftKey;

export const addReviewComment = (sessionId: string, c: NewComment) =>
   setReviewComments(sessionId, [
      ...getReviewComments(sessionId),
      { ...c, id: crypto.randomUUID() } as ReviewComment,
   ]);

export const removeReviewComment = (sessionId: string, id: string) =>
   setReviewComments(
      sessionId,
      getReviewComments(sessionId).filter((c) => c.id !== id),
   );

function subscribe(cb: () => void) {
   listeners.add(cb);
   const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith(PREFIX)) cb();
   };
   window.addEventListener("storage", onStorage);
   return () => {
      listeners.delete(cb);
      window.removeEventListener("storage", onStorage);
   };
}

export function useReviewComments(sessionId: string): ReviewComment[] {
   return useSyncExternalStore(subscribe, () => getReviewComments(sessionId));
}

/** This Session's diff line comments (for the diff views). */
export function useDiffComments(sessionId: string): DiffComment[] {
   const all = useReviewComments(sessionId);
   return useMemo(() => all.filter(isDiffComment), [all]);
}

/** This Session's file line comments (for the Files panel). */
export function useFileComments(sessionId: string): FileComment[] {
   const all = useReviewComments(sessionId);
   return useMemo(() => all.filter(isFileComment), [all]);
}
