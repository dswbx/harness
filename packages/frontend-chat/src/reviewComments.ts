import { useMemo, useSyncExternalStore } from "react";

/** A comment on one diff line, waiting in the prompt box until the next send. */
export type DiffComment = {
   id: string;
   kind?: "diff";
   path: string;
   line: number;
   /** "old": the line number is in the old file (a deleted line); "new": in the new file. */
   side: "old" | "new";
   /** The commented line's code, quoted in the prompt. */
   code: string;
   text: string;
};

/** A comment on text selected in a chat message, waiting in the prompt box until the next send. */
export type QuoteComment = {
   id: string;
   kind: "quote";
   quote: string;
   /** May be empty for a quote sent without a comment. */
   text: string;
   /**
    * "side_thread": text taken from a Side Thread ("Send to main"). "plan": a quote from the Plan panel.
    * "artifact": a quote from an artifact. No source: a quote from a chat message.
    */
   source?: "side_thread" | "plan" | "artifact";
   /** Which plan or artifact the quote is from ("Plan v2", "Upgrade guide"). */
   label?: string;
};

/** A comment on one line of a file (the Files panel), waiting in the prompt box until the next send. */
export type FileComment = {
   id: string;
   kind: "file";
   path: string;
   line: number;
   /** The commented line's code, quoted in the prompt. */
   code: string;
   text: string;
};

export type ReviewComment = DiffComment | FileComment | QuoteComment;
export type NewComment =
   | Omit<DiffComment, "id">
   | Omit<FileComment, "id">
   | Omit<QuoteComment, "id">;

/** Diff comments saved before `kind` existed have no `kind`. */
export const isDiffComment = (c: ReviewComment): c is DiffComment =>
   c.kind === undefined || c.kind === "diff";
export const isFileComment = (c: ReviewComment): c is FileComment => c.kind === "file";
/** A comment on a code line (diff or file): the "Review comments:" section. */
export const isLineComment = (c: ReviewComment): c is DiffComment | FileComment =>
   c.kind !== "quote";

/** Fence long enough that no backtick run inside `code` closes it. */
function fence(code: string) {
   const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
   return "`".repeat(Math.max(3, longest + 1));
}

const quoted = (s: string) =>
   s
      .trim()
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");

/** `Comments on the plan (Plan v2):` / `Comments on artifact "Upgrade guide":`; no label: `...the plan:` / `...the artifact:`. */
const sourceHeader = (source: "plan" | "artifact", label: string) =>
   source === "plan"
      ? `Comments on the plan${label ? ` (${label})` : ""}:`
      : label
        ? `Comments on artifact "${label}":`
        : "Comments on the artifact:";
const PLAN_HEAD = /^Comments on the plan(?: \((.+)\))?:$/;
const ARTIFACT_HEAD = /^Comments on (?:the artifact|artifact "(.+)"):$/;

/**
 * The sections the prompt gets on send: "Review comments:" (diff and file lines; a diff line has its side),
 * "Comments on the conversation:" (quotes).
 */
export function formatReviewComments(comments: ReviewComment[]): string {
   const diffs = comments.filter(isLineComment).map((c) => {
      const f = fence(c.code);
      const side = c.kind === "file" ? "" : ` (${c.side})`;
      return `${c.path}:${c.line}${side}\n${f}\n${c.code}\n${f}\n${c.text.trim()}`;
   });
   const item = (c: QuoteComment) => [quoted(c.quote), c.text.trim()].filter(Boolean).join("\n\n");
   const quotesOf = (pick: (c: QuoteComment) => boolean) =>
      comments.flatMap((c) => (c.kind === "quote" && pick(c) ? [item(c)] : []));
   const quotes = quotesOf((c) => !c.source);
   const fromSide = quotesOf((c) => c.source === "side_thread");
   // One section per distinct label of a source, in order of first appearance.
   const labelled = (source: "plan" | "artifact") => {
      const labels = [
         ...new Set(
            comments.flatMap((c) =>
               c.kind === "quote" && c.source === source ? [c.label || ""] : [],
            ),
         ),
      ];
      return labels.map((label) =>
         [
            sourceHeader(source, label),
            ...quotesOf((c) => c.source === source && (c.label || "") === label),
         ].join("\n\n"),
      );
   };
   return [
      ...(diffs.length ? [["Review comments:", ...diffs].join("\n\n")] : []),
      ...(quotes.length ? [["Comments on the conversation:", ...quotes].join("\n\n")] : []),
      ...labelled("plan"),
      ...labelled("artifact"),
      ...(fromSide.length ? [["From a side thread:", ...fromSide].join("\n\n")] : []),
   ].join("\n\n");
}

/** Between the comment sections and the typed text. */
const SEPARATOR = "\n\n---\n\n";

/**
 * The review sections, then the prompt text (the order the user sees them in); either may be empty.
 * A leading slash command stays first, so the Agent still sees it.
 */
export function withReviewComments(text: string, comments: ReviewComment[]): string {
   const t = text.trim();
   const parts = [formatReviewComments(comments), t].filter(Boolean);
   return t.startsWith("/") ? parts.reverse().join("\n\n") : parts.join(SEPARATOR);
}

const HEADERS = {
   "Review comments:": "diff",
   "Comments on the conversation:": "quote",
   "From a side thread:": "side",
} as const;
type Section = "diff" | "quote" | "side" | "plan" | "artifact";
type Header = { section: Section; label?: string };
const parseHeader = (l: string | undefined): Header | null => {
   if (l === undefined) return null;
   if (Object.hasOwn(HEADERS, l)) return { section: HEADERS[l as keyof typeof HEADERS] };
   const p = PLAN_HEAD.exec(l);
   if (p) return { section: "plan", label: p[1] };
   const a = ARTIFACT_HEAD.exec(l);
   if (a) return { section: "artifact", label: a[1] };
   return null;
};
/** `path:line (side)` for a diff line, `path:line` for a file line. */
const DIFF_HEAD = /^(.+):(\d+)(?: \((old|new)\))?$/;
const FENCE = /^`{3,}$/;
const isHeader = (l: string | undefined) => parseHeader(l) !== null;

/**
 * The inverse of `withReviewComments`: the comments and the typed text of a sent prompt. Text that does not
 * start with a section header, or does not parse back to itself, comes back untouched with no comments.
 */
export function parseReviewComments(text: string): { comments: ReviewComment[]; text: string } {
   const none = { comments: [], text };
   const lines = text.trim().split("\n");
   if (!isHeader(lines[0])) return none;
   const comments: ReviewComment[] = [];
   let i = 0;
   let section: Section = "diff";
   let label: string | undefined;
   // At a blank line: the section ends there (next header, the separator, or the end).
   const sectionEnd = (j: number) =>
      j >= lines.length ||
      (lines[j] === "" &&
         ((isHeader(lines[j + 1]) && lines[j + 2] === "") ||
            (lines[j + 1] === "---" && lines[j + 2] === "")));
   const itemStart = (j: number) =>
      section === "diff"
         ? DIFF_HEAD.test(lines[j] ?? "") && FENCE.test(lines[j + 1] ?? "")
         : (lines[j] ?? "").startsWith(">");
   // Comment text: up to the next item or the section's end.
   const readText = () => {
      const start = i;
      while (!sectionEnd(i) && !(lines[i] === "" && itemStart(i + 1))) i++;
      return lines.slice(start, i).join("\n");
   };
   while (i < lines.length) {
      const header = parseHeader(lines[i]);
      if (!header || lines[i + 1] !== "") return none;
      section = header.section;
      label = header.label;
      i += 2;
      while (true) {
         if (section === "diff") {
            const m = DIFF_HEAD.exec(lines[i] ?? "");
            const f = lines[i + 1] ?? "";
            if (!m || !FENCE.test(f)) return none;
            const close = lines.indexOf(f, i + 2);
            if (close < 0) return none;
            const code = lines.slice(i + 2, close).join("\n");
            i = close + 1;
            const t = readText();
            const id = String(comments.length);
            const path = m[1] as string;
            const line = Number(m[2]);
            comments.push(
               m[3]
                  ? { id, path, line, side: m[3] as "old" | "new", code, text: t }
                  : { id, kind: "file", path, line, code, text: t },
            );
         } else {
            const start = i;
            while ((lines[i] ?? "").startsWith(">")) i++;
            if (i === start) return none;
            const quote = lines
               .slice(start, i)
               .map((l) => l.replace(/^> ?/, ""))
               .join("\n");
            let t = "";
            if (!sectionEnd(i) && !itemStart(i + 1)) {
               i++;
               t = readText();
            }
            comments.push({
               id: String(comments.length),
               kind: "quote",
               quote,
               text: t,
               ...(section === "side" && { source: "side_thread" as const }),
               ...((section === "plan" || section === "artifact") && {
                  source: section,
                  ...(label && { label }),
               }),
            });
         }
         if (sectionEnd(i)) break;
         i++;
      }
      if (i >= lines.length) break;
      i++;
      if (lines[i] === "---") {
         i += 2;
         break;
      }
   }
   const rest = lines.slice(i).join("\n");
   // Anything ambiguous (e.g. a comment with a quote in it) parses to something else: show it as typed.
   return withReviewComments(rest, comments) === text.trim() ? { comments, text: rest } : none;
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

/**
 * Whose composer holds the comments: the Main Thread's (the Session id, as the diff views use it) or a
 * Side Thread's own (its quotes are not sent to Main).
 */
export const composerKey = (sessionId: string, sideThreadId: string | null) =>
   sideThreadId ? `${sessionId}#${sideThreadId}` : sessionId;

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
