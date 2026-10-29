import { useSyncExternalStore } from "react";

/** A comment on one diff line, waiting in the prompt box until the next send. */
export type ReviewComment = {
  id: string;
  path: string;
  line: number;
  /** "old": the line number is in the old file (a deleted line); "new": in the new file. */
  side: "old" | "new";
  /** The commented line's code, quoted in the prompt. */
  code: string;
  text: string;
};

/** Fence long enough that no backtick run inside `code` closes it. */
function fence(code: string) {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The "Review comments:" section the prompt gets on send. */
export function formatReviewComments(comments: ReviewComment[]): string {
  if (comments.length === 0) return "";
  const parts = comments.map((c) => {
    const f = fence(c.code);
    return `${c.path}:${c.line} (${c.side})\n${f}\n${c.code}\n${f}\n${c.text.trim()}`;
  });
  return ["Review comments:", ...parts].join("\n\n");
}

/** Prompt text plus the review section; either may be empty. */
export function withReviewComments(text: string, comments: ReviewComment[]): string {
  return [text.trim(), formatReviewComments(comments)].filter(Boolean).join("\n\n");
}

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

export const addReviewComment = (sessionId: string, c: Omit<ReviewComment, "id">) =>
  setReviewComments(sessionId, [...getReviewComments(sessionId), { ...c, id: crypto.randomUUID() }]);

export const removeReviewComment = (sessionId: string, id: string) =>
  setReviewComments(sessionId, getReviewComments(sessionId).filter((c) => c.id !== id));

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
