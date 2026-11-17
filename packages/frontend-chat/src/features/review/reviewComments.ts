import {
   draftKey,
   type LineCommentState,
   onSessionForgotten,
   parseDraftKey,
   type SessionApi,
   type Stored,
   storedValue,
   useStoredValue,
} from "@harness/api";
import { useMemo } from "react";
import {
   type DiffComment,
   type FileComment,
   isLineComment,
   type NewComment,
   type QuoteComment,
   type ReviewComment,
} from "../../state/reviewCommentText";

export * from "../../state/reviewCommentText";

// Store of the Frontend-only quote drafts (ADR 0027: line comments live in the core): localStorage per composer.
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

/** The quote drafts of composer `key`. */
export const getQuotes = (key: string): QuoteComment[] =>
   getReviewComments(key).filter((c): c is QuoteComment => c.kind === "quote");

/** Replaces the quote drafts of composer `key`; anything else stored there (unmigrated line comments) stays. */
export const setQuotes = (key: string, quotes: QuoteComment[]) =>
   setReviewComments(key, [...getReviewComments(key).filter(isLineComment), ...quotes]);

/** The quote drafts of composer `key`, live. */
export function useQuotes(key: string): QuoteComment[] {
   const all = useReviewComments(key);
   return useMemo(() => all.filter((c): c is QuoteComment => c.kind === "quote"), [all]);
}

/** A core line comment in the shape of the prompt text and chips: a diff line has its side, a file line none. */
export const lineToReview = (c: LineCommentState): DiffComment | FileComment =>
   c.side
      ? { id: c.id, path: c.path, line: c.line, side: c.side, code: c.code, text: c.text }
      : { id: c.id, kind: "file", path: c.path, line: c.line, code: c.code, text: c.text };

/** The core ids of the line comments among `comments`: what `api.prompt` marks sent. */
export const lineCommentIds = (comments: readonly ReviewComment[]): string[] =>
   comments.filter(isLineComment).map((c) => c.id);

/** The comments the Files view shows: working-tree lines (no side, or the new side). */
export const fileViewComments = (list: readonly LineCommentState[]) =>
   list.filter((c) => c.side !== "old");

/** Comments still needing attention (pending or open) on `path`. */
export const activeCommentsOn = (list: readonly LineCommentState[], path: string) =>
   list.filter((c) => c.path === path && c.status !== "resolved").length;

const migrating = new Set<string>();

/**
 * One-time move of line comments an earlier version kept in this Frontend's storage into the core (ADR
 * 0027). Each leaves the storage once added; a failure keeps the rest for the next time.
 */
export async function migrateStoredLineComments(api: SessionApi): Promise<void> {
   const key = api.sessionId;
   if (migrating.has(key)) return;
   const old = getReviewComments(key).filter(isLineComment);
   if (old.length === 0) return;
   migrating.add(key);
   try {
      for (const c of old) {
         await api.addComment({
            path: c.path,
            line: c.line,
            side: c.kind === "file" ? null : c.side,
            code: c.code,
            text: c.text,
         });
         removeReviewComment(key, c.id);
      }
   } catch {
      // Still stored: tried again the next time a prompt box opens.
   } finally {
      migrating.delete(key);
   }
}
