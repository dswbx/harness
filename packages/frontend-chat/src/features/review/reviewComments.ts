import {
   draftKey,
   onSessionForgotten,
   parseDraftKey,
   type Stored,
   storedValue,
   useStoredValue,
} from "@harness/api";
import { useMemo } from "react";
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
const EMPTY: ReviewComment[] = [];
// `sessionId` is the composer key here (see `composerKey`): `sessionId#threadId` for a Side Thread.
const stores = new Map<string, Stored<ReviewComment[]>>();
onSessionForgotten((id) => {
   for (const k of [...stores.keys()]) if (parseDraftKey(k).sessionId === id) stores.delete(k);
});
const storeOf = (sessionId: string) => {
   let s = stores.get(sessionId);
   if (!s) {
      s = storedValue<ReviewComment[]>({
         key: `harness.review-comments.${sessionId}`,
         scope: { session: parseDraftKey(sessionId).sessionId },
         // Corrupt entry: treat as empty.
         parse: (raw) => {
            const v: unknown = raw ? JSON.parse(raw) : null;
            return Array.isArray(v) ? (v as ReviewComment[]) : EMPTY;
         },
      });
      stores.set(sessionId, s);
   }
   return s;
};

export const getReviewComments = (sessionId: string): ReviewComment[] => storeOf(sessionId).get();

export function setReviewComments(sessionId: string, list: ReviewComment[]) {
   const s = storeOf(sessionId);
   if (list.length) s.set(list);
   else s.remove();
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

export const useReviewComments = (sessionId: string): ReviewComment[] =>
   useStoredValue(storeOf(sessionId));

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
