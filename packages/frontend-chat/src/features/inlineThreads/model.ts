import type { AttachmentInput, SessionApi, TextAnchor } from "@harness/api";
import { useStoredValue } from "@harness/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextQuote } from "../../lib/textQuote";
import type { ChatState } from "../../state/reducer";
import { clearDraft, getDraft, getDraftAttachments, setDraft } from "../prompt/drafts";
import type { PendingMessage } from "../prompt/pendingMessages";
import { deliverPending } from "../prompt/usePendingSend";
import {
   composerKey,
   getReviewComments,
   parseReviewComments,
   setReviewComments,
   withReviewComments,
} from "../review/reviewComments";
import { draftsStore, type InlineDrafts, seenStore } from "./store";

/** An Inline Thread of the Session: a Side Thread with an Anchor (ADR 0031). */
export type InlineThread = {
   id: string;
   anchor: TextAnchor;
   /** The anchored Main Thread agent message (`e{seq}`). */
   itemId: string;
   resolved: boolean;
   /** Its Thread's state; null until its replay is here. */
   state: ChatState | null;
};

export type InlineStatus = "running" | "unread" | null;

export type InlineModel = {
   /** Inline Threads, newest first (resolved ones too). */
   threads: InlineThread[];
   /** Questions not sent yet, by draft id (`draft:<uuid>`). */
   drafts: InlineDrafts;
   /** The ids (Threads and drafts) the popover shows; null: closed. */
   openIds: string[] | null;
   /** The draft whose composer the popover shows, if any. */
   composing: string | null;
   /** "Show in chat": the chat scrolls to the message of the Thread (or draft) and opens it. */
   reveal: { id: string; n: number } | null;
   /** Threads and drafts whose quote was looked for in the chat and not found. */
   notFound: ReadonlySet<string>;
   statusOf: (id: string) => InlineStatus;
   /** Whether a draft has something in its composer (text, quotes, attachments) or is being sent. */
   hasContent: (draftId: string) => boolean;
   /** The Thread a draft was sent as (this mount only); null if it was not. */
   sentAs: (draftId: string) => string | null;
   /** "Ask inline" on `quote` in agent message `itemId`: a new draft, shown at once. Null: not anchorable. */
   begin: (itemId: string, quote: TextQuote) => string | null;
   /** Sends a draft's first message: the Inline Thread starts (forked), and the draft goes. */
   send: (
      draftId: string,
      text: string,
      attachments: AttachmentInput[],
      item: PendingMessage,
      mode?: string,
   ) => Promise<void>;
   open: (ids: string[]) => void;
   /** An explicit close (Close, Esc): drafts without text go, the others stay. */
   close: () => void;
   /** Removes a draft, its text and its highlight. */
   discard: (draftId: string) => void;
   resolve: (id: string, resolved: boolean) => void;
   showInChat: (id: string) => void;
   /** Whether the chat found the quote of a Thread or draft (rows report it when they look). */
   markFound: (id: string, found: boolean) => void;
};

/** The agent message an item id names (`e{seq}`); null for other ids. */
export const seqOfItem = (itemId: string): number | null => {
   const m = /^e(\d+)$/.exec(itemId);
   return m ? Number(m[1]) : null;
};

/** The text of a Thread's last agent message. */
export function lastReply(t: ChatState | null): string {
   for (let i = (t?.items.length ?? 0) - 1; i >= 0; i--) {
      const it = t!.items[i]!;
      if (it.type === "agent" && it.parent === null) return it.text;
   }
   return "";
}

const isDraftId = (id: string) => id.startsWith("draft:");

/** The Inline Threads of a Session: its anchored Side Threads, drafts, popover and unread state. */
export function useInlineThreads({
   api,
   state,
   persist = true,
}: {
   api: SessionApi;
   state: ChatState;
   /** False: nothing is written to storage (the Quick Overlay). */
   persist?: boolean;
}): InlineModel {
   const sessionId = api.sessionId;
   const drafts$ = useMemo(() => draftsStore(sessionId), [sessionId]);
   const seen$ = useMemo(() => seenStore(sessionId), [sessionId]);
   const drafts = useStoredValue(drafts$);
   const seen = useStoredValue(seen$);
   const [openIds, setOpenIds] = useState<string[] | null>(null);
   const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
   const [notFound, setNotFound] = useState<ReadonlySet<string>>(() => new Set());
   const [mountedAt] = useState(() => Date.now());
   // Threads started here whose `ThreadStarted` has not come back yet: their Anchor, so the highlight stays.
   const [started, setStarted] = useState<Record<string, { itemId: string; anchor: TextAnchor }>>(
      {},
   );

   const threads = useMemo(() => {
      const out: InlineThread[] = [];
      const listed = new Set<string>();
      for (const t of state.threadList) {
         if (t.main || !t.anchor) continue;
         listed.add(t.id);
         out.push({
            id: t.id,
            anchor: t.anchor,
            itemId: `e${t.anchor.seq}`,
            resolved: t.resolved,
            state: state.threads[t.id] ?? null,
         });
      }
      for (const [id, s] of Object.entries(started))
         if (!listed.has(id)) out.push({ id, ...s, resolved: false, state: null });
      return out.reverse();
   }, [state.threadList, state.threads, started]);

   const statusOf = useCallback(
      (id: string): InlineStatus => {
         const t = state.threads[id];
         if (!t) return null;
         if (t.turnId) return "running";
         const end = t.turnEndedAt;
         return end && !openIds?.includes(id) && end > (seen[id] ?? mountedAt) ? "unread" : null;
      },
      [state.threads, openIds, seen, mountedAt],
   );

   // An open Thread is seen, up to its newest reply.
   const openEnds = (openIds ?? [])
      .map((id) => `${id}:${state.threads[id]?.turnEndedAt ?? ""}`)
      .join(",");
   const seenRef = useRef(seen);
   seenRef.current = seen;
   const threadsRef = useRef(state.threads);
   threadsRef.current = state.threads;
   useEffect(() => {
      if (!openEnds || !persist) return;
      const next = { ...seenRef.current };
      let changed = false;
      for (const part of openEnds.split(",")) {
         const id = part.slice(0, part.lastIndexOf(":"));
         const end = threadsRef.current[id]?.turnEndedAt;
         if (end && next[id] !== end) {
            next[id] = end;
            changed = true;
         }
      }
      if (changed) seen$.set(next);
   }, [openEnds, persist, seen$]);

   // Drafts whose first message is on its way (the fork can take seconds), and what drafts were sent as.
   const sending = useRef(new Set<string>());
   const sentTo = useRef(new Map<string, string>());
   const hasContent = useCallback(
      (draftId: string) => {
         const key = composerKey(sessionId, draftId);
         return (
            sending.current.has(draftId) ||
            getDraft(key) !== null ||
            getReviewComments(key).length > 0 ||
            getDraftAttachments(key).length > 0
         );
      },
      [sessionId],
   );
   const sentAs = useCallback((draftId: string) => sentTo.current.get(draftId) ?? null, []);
   const discard = useCallback(
      (draftId: string) => {
         const key = composerKey(sessionId, draftId);
         clearDraft(key);
         setReviewComments(key, []);
         const { [draftId]: _, ...rest } = drafts$.get();
         if (persist) drafts$.set(rest);
         setOpenIds((ids) => {
            const left = ids?.filter((x) => x !== draftId) ?? null;
            return left?.length ? left : null;
         });
      },
      [sessionId, drafts$, persist],
   );
   const begin = useCallback(
      (itemId: string, quote: TextQuote) => {
         const seq = seqOfItem(itemId);
         if (seq === null || !state.mainThreadId || !persist) return null;
         const id = `draft:${crypto.randomUUID()}`;
         drafts$.set({
            ...drafts$.get(),
            [id]: { itemId, anchor: { thread_id: state.mainThreadId, seq, ...quote } },
         });
         setOpenIds([id]);
         return id;
      },
      [state.mainThreadId, persist, drafts$],
   );
   const send = useCallback(
      async (
         draftId: string,
         text: string,
         attachments: AttachmentInput[],
         item: PendingMessage,
         mode?: string,
      ) => {
         const draft = drafts$.get()[draftId];
         if (!draft) throw new Error("This draft is gone.");
         if (sending.current.has(draftId)) throw new Error("This question is already being sent.");
         const { anchor } = draft;
         // The quote leads the first prompt, like a quote chip.
         const typed = parseReviewComments(text);
         const prompt = withReviewComments(typed.text, [
            { id: "anchor", kind: "quote", quote: anchor.quote, text: "" },
            ...typed.comments,
         ]);
         // Rejects when the Thread did not start: the composer gets its text back. The text is also stored
         // again here, since the popover may have closed meanwhile.
         sending.current.add(draftId);
         let thread_id: string;
         try {
            ({ thread_id } = await api.startSideThread({
               source: "fork",
               ...(mode && { mode }),
               anchor,
            }));
         } catch (err) {
            if (drafts$.get()[draftId] && item.snap)
               setDraft(composerKey(sessionId, draftId), item.snap);
            throw err;
         } finally {
            sending.current.delete(draftId);
         }
         sentTo.current.set(draftId, thread_id);
         setStarted((m) => ({ ...m, [thread_id]: { itemId: draft.itemId, anchor } }));
         const sent = deliverPending(
            composerKey(sessionId, thread_id),
            { ...item, prompt },
            0,
            () => api.prompt(prompt, attachments, thread_id),
            // Its row says it was not sent, with Retry.
            () => {},
         );
         const key = composerKey(sessionId, draftId);
         clearDraft(key);
         setReviewComments(key, []);
         const { [draftId]: _, ...rest } = drafts$.get();
         drafts$.set(rest);
         setOpenIds((ids) => (ids?.includes(draftId) ? [thread_id] : ids));
         await sent;
      },
      [api, sessionId, drafts$],
   );
   const open = useCallback((ids: string[]) => setOpenIds(ids.length ? ids : null), []);
   const openRef = useRef(openIds);
   openRef.current = openIds;
   const close = useCallback(() => {
      for (const id of openRef.current ?? []) if (isDraftId(id) && !hasContent(id)) discard(id);
      setOpenIds(null);
   }, [hasContent, discard]);
   const resolve = useCallback(
      (id: string, resolved: boolean) => {
         api.resolveSideThread(id, resolved).catch((e) => console.error("resolve failed", e));
      },
      [api],
   );
   const showInChat = useCallback(
      (id: string) => setReveal((r) => ({ id, n: (r?.n ?? 0) + 1 })),
      [],
   );
   const markFound = useCallback(
      (id: string, found: boolean) =>
         setNotFound((s) => {
            if (s.has(id) !== found) return s;
            const next = new Set(s);
            if (found) next.delete(id);
            else next.add(id);
            return next;
         }),
      [],
   );

   // Drafts with nothing in their composer go when the model loads and when it goes (a reload, a Session
   // switch): an empty draft would otherwise stay forever (highlight, empty card).
   useEffect(() => {
      if (!persist) return;
      const prune = () => {
         const all = drafts$.get();
         const left = Object.fromEntries(Object.entries(all).filter(([id]) => hasContent(id)));
         if (Object.keys(left).length !== Object.keys(all).length) drafts$.set(left);
      };
      prune();
      return prune;
   }, [persist, drafts$, hasContent]);

   // A Thread started here shows from the list once its `ThreadStarted` is folded in.
   useEffect(() => {
      setStarted((m) => {
         const left = Object.keys(m).filter((id) => !state.threadList.some((t) => t.id === id));
         return left.length === Object.keys(m).length
            ? m
            : Object.fromEntries(left.map((id) => [id, m[id]!]));
      });
   }, [state.threadList]);

   const composing = openIds?.find(isDraftId) ?? null;
   return useMemo(
      () => ({
         threads,
         drafts,
         openIds,
         composing,
         reveal,
         notFound,
         statusOf,
         hasContent,
         sentAs,
         begin,
         send,
         open,
         close,
         discard,
         resolve,
         showInChat,
         markFound,
      }),
      [
         threads,
         drafts,
         openIds,
         composing,
         reveal,
         notFound,
         statusOf,
         hasContent,
         sentAs,
         begin,
         send,
         open,
         close,
         discard,
         resolve,
         showInChat,
         markFound,
      ],
   );
}
