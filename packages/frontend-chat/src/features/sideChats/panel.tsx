import type { AttachmentInput, ThreadInfo } from "@harness/api";
import { errText, threadTitle } from "@harness/api";
import { MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { waitsForUser } from "../../state/waiting";
import { changesPanel } from "../changes/panel";
import { type InlineModel, useInlineThreads } from "../inlineThreads/model";
import { clearDraft } from "../prompt/drafts";
import type { PendingMessage } from "../prompt/pendingMessages";
import { deliverPending } from "../prompt/usePendingSend";
import { useEnv } from "../renderUi/runtime";
import {
   addReviewComment,
   composerKey,
   lineCommentIds,
   setReviewComments,
} from "../review/reviewComments";
import { type SideChatStatus, SidePanel } from "./SidePanel";
import type { SideStart } from "./ThreadView";
import {
   closeThread,
   isDraftThread,
   moveThread,
   newThreadTabId,
   openThread,
   openThreadIds,
   selectThread,
   shownTab,
   takesDraftTab,
   threadStarted,
   useThreadTabs,
} from "./threadTabs";

export type SideChatsModel = {
   /** Open tabs that have something to show. */
   open: string[];
   /** The tab shown: a Side Thread, or `INLINE_TAB`. */
   active: string | null;
   /** The fixed Inline tab's count (unresolved Inline Threads and drafts); null: the tab is hidden. */
   inlineCount: number | null;
   titleOf: (id: string) => string;
   statusOf: (id: string) => SideChatStatus;
   /** Open tabs with a reply not seen yet. */
   unread: number;
   /** A prompt box takes focus in the chat that was just created. */
   focus: { id: string; n: number };
   /** Why the last Side Thread could not start. */
   error: string | null;
   select: (id: string) => void;
   close: (id: string) => void;
   /** Moves tab `id` in front of tab `before` (null: to the end). */
   move: (id: string, before: string | null) => void;
   /** Side Threads in the Session, open or closed, newest activity first. */
   past: ThreadInfo[];
   /** Opens a Side Thread's tab again (or selects it) and shows the panel. */
   reopen: (id: string) => void;
   /** A new side chat tab (an open draft is reused); returns its id. Its Side Thread starts with its first message. */
   newThread: () => string;
   /**
    * Starts a Side Thread now (forked from Main when the Agent can; `start` from a draft tab can pick fresh and a
    * mode), in place of tab `draft` or as a new tab, and sends it `text`. With `item`, that message shows in the
    * new tab at once (pending until the Agent is up) and a failed send stays there to retry: the promise rejects
    * only when the Thread did not start.
    */
   start: (
      text: string,
      attachments: AttachmentInput[],
      opts?: { draft?: string; start?: SideStart; item?: PendingMessage },
   ) => Promise<void>;
   /** "Ask in side thread": a new side chat with the selected text as a quote chip in its prompt box. */
   ask: (quote: string) => void;
   /** Side Threads in the Session (open or not). */
   count: number;
   /** Inline Threads (ADR 0030): anchored Side Threads, their drafts and popover. */
   inline: InlineModel;
};

/** Cmd/Ctrl+Shift+B: a new Side Thread ("by the way"). */
export const isNewSideChatKey = (e: KeyboardEvent) =>
   (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyB";

/**
 * The side chats: one tab per Side Thread, in their own store (`threadTabs.ts`), not in the dock layout.
 * The panel has an icon always and shows once a tab has something to show, and then stays mounted (hidden
 * when closed), so a half-typed prompt survives hiding and moving it. Not in the Quick Overlay, where `/btw`
 * still starts a Side Thread (kept in memory).
 */
export const sideChatsPanel = definePanel<SideChatsModel>({
   id: "side",
   label: "Side chats",
   icon: MessagesSquare,
   placement: { edge: "right" },
   mount: "whileReady",
   useModel: ({ api, state, variant }, self) => {
      const overlay = variant === "overlay";
      const { tabs, apply, tabsRef } = useThreadTabs(api.sessionId, !overlay);
      const inline = useInlineThreads({ api, state, persist: !overlay });
      const selfRef = useRef(self);
      selfRef.current = self;
      const [focus, setFocus] = useState<{ id: string; n: number }>({ id: "", n: 0 });
      const [error, setError] = useState<string | null>(null);
      // Tabs sent from here, by id (draft, then its Thread): their title until the Thread has one. A Thread
      // in it shows before its replay arrives, so the panel neither closes nor waits for it.
      const [sent, setSent] = useState<Record<string, string>>({});

      const open = useMemo(
         () => openThreadIds(tabs.threads, state.threads, sent),
         [tabs, state.threads, sent],
      );
      const draftCount = Object.keys(inline.drafts).length;
      const inlineCount =
         inline.threads.length > 0 || draftCount > 0
            ? inline.threads.filter((t) => !t.resolved).length + draftCount
            : null;
      const active = shownTab(tabs.thread, open, inlineCount !== null);
      const sideThreads = useMemo(
         () => state.threadList.filter((t) => !t.main),
         [state.threadList],
      );
      const titleOf = useCallback(
         (id: string) =>
            sideThreads.find((x) => x.id === id)?.title ??
            sent[id] ??
            (isDraftThread(id) ? "New chat" : "Side chat"),
         [sideThreads, sent],
      );

      // Unread: a Turn ended (`turnEndedAt`) after the tab was last shown, or after this View mounted.
      const [mountedAt] = useState(() => Date.now());
      const [seenAt, setSeenAt] = useState<Record<string, number>>({});
      const shown = self.open ? active : null;
      const shownEnd = shown ? state.threads[shown]?.turnEndedAt : null;
      useEffect(() => {
         if (shown && shownEnd)
            setSeenAt((m) => (m[shown] === shownEnd ? m : { ...m, [shown]: shownEnd }));
      }, [shown, shownEnd]);
      const statusOf = useCallback(
         (id: string): SideChatStatus => {
            const t = state.threads[id];
            if (!t) return null;
            if (waitsForUser(t)) return "needs_attention";
            if (t.turnId) return "working";
            const end = t.turnEndedAt;
            return id !== shown && end && end > (seenAt[id] ?? mountedAt) ? "unread" : null;
         },
         [state.threads, shown, seenAt, mountedAt],
      );
      const unread = useMemo(
         () => open.filter((id) => statusOf(id) === "unread").length,
         [open, statusOf],
      );

      const hasInline = useRef(false);
      hasInline.current = inlineCount !== null;
      const select = useCallback((id: string) => apply((t) => selectThread(t, id)), [apply]);
      const move = useCallback(
         (id: string, before: string | null) => apply((t) => moveThread(t, id, before)),
         [apply],
      );
      // Inline Threads are listed in the Inline tab, not in Past chats.
      const past = useMemo(
         () => sideThreads.filter((t) => !t.anchor).sort((a, b) => b.lastAt - a.lastAt),
         [sideThreads],
      );
      const reopen = useCallback(
         (id: string) => {
            apply((t) => openThread(t, id));
            selfRef.current.show();
         },
         [apply],
      );
      const close = useCallback(
         (id: string) => {
            if (isDraftThread(id)) {
               setReviewComments(composerKey(api.sessionId, id), []);
               clearDraft(composerKey(api.sessionId, id));
            }
            // The last tab hides the panel, unless the Inline tab is there.
            if (apply((t) => closeThread(t, id)).threads.length === 0 && !hasInline.current)
               selfRef.current.hide();
         },
         [api.sessionId, apply],
      );
      const newThread = useCallback(() => {
         const id = newThreadTabId(tabsRef.current, () => crypto.randomUUID());
         apply((t) => openThread(t, id));
         selfRef.current.show();
         setFocus((f) => ({ id, n: f.n + 1 }));
         return id;
      }, [apply, tabsRef]);
      const start = useCallback(
         async (
            text: string,
            attachments: AttachmentInput[],
            {
               draft,
               start: s,
               item,
            }: { draft?: string; start?: SideStart; item?: PendingMessage } = {},
         ) => {
            setError(null);
            const title = threadTitle(text) ?? "Side chat";
            // The tab takes its title at once, in place.
            if (draft) setSent((m) => ({ ...m, [draft]: title }));
            let thread_id: string;
            try {
               ({ thread_id } = await api.startSideThread(s));
            } catch (e) {
               setError(errText(e));
               if (draft)
                  setSent((m) => {
                     const { [draft]: _, ...rest } = m;
                     return rest;
                  });
               throw e;
            }
            // The message shows in the new tab right away: starting the Agent (and forking) takes a while.
            const key = composerKey(api.sessionId, thread_id);
            const send = item
               ? deliverPending(
                    key,
                    item,
                    0,
                    () => api.prompt(text, attachments, thread_id, lineCommentIds(item.comments)),
                    // Its row says it was not sent, with Retry.
                    () => {},
                 )
               : api.prompt(text, attachments, thread_id);
            // A draft tab that closed meanwhile does not take it: a new tab opens, and shows the panel.
            const own = takesDraftTab(tabsRef.current, draft);
            setSent((m) => ({ ...m, [thread_id]: title }));
            apply((t) => threadStarted(t, draft, thread_id));
            if (!own) selfRef.current.show();
            setFocus((f) => ({ id: thread_id, n: f.n + 1 }));
            await send;
         },
         [api, apply, tabsRef],
      );
      const ask = useCallback(
         (quote: string) =>
            addReviewComment(composerKey(api.sessionId, newThread()), {
               kind: "quote",
               quote,
               text: "",
            }),
         [api.sessionId, newThread],
      );

      useEffect(() => {
         // The Quick overlay has no side chats panel.
         if (overlay) return;
         const onKey = (e: KeyboardEvent) => {
            if (!isNewSideChatKey(e)) return;
            e.preventDefault();
            e.stopPropagation();
            newThread();
         };
         window.addEventListener("keydown", onKey, true);
         return () => window.removeEventListener("keydown", onKey, true);
      }, [overlay, newThread]);

      return useMemo(
         () => ({
            open,
            active,
            inlineCount,
            titleOf,
            statusOf,
            unread,
            focus,
            error,
            select,
            close,
            move,
            past,
            reopen,
            newThread,
            start,
            ask,
            count: sideThreads.length,
            inline,
         }),
         [
            open,
            active,
            inlineCount,
            titleOf,
            statusOf,
            unread,
            focus,
            error,
            select,
            close,
            move,
            past,
            reopen,
            newThread,
            start,
            ask,
            sideThreads.length,
            inline,
         ],
      );
   },
   status: (m) => ({
      presence: m.open.length > 0 || m.inlineCount !== null ? "ready" : "icon",
      badge: m.count,
      dot: m.unread > 0,
      tip: "Side chats (⇧⌘B new)",
   }),
   // The icon: hides the panel when shown, else shows the last chat, else starts a new one.
   activate: (m, self) => {
      if (m.active) {
         m.select(m.active);
         self.show();
      } else m.newThread();
   },
   Body: ({ model, ctx }: PanelBodyProps<SideChatsModel>) => {
      const env = useEnv();
      return (
         <SidePanel
            api={ctx.api}
            state={ctx.state}
            threads={model.open}
            active={model.active}
            inline={model.inlineCount === null ? null : model.inline}
            inlineCount={model.inlineCount ?? 0}
            titleOf={model.titleOf}
            statusOf={model.statusOf}
            env={env}
            focus={model.focus}
            onSelect={model.select}
            onClose={model.close}
            onMove={model.move}
            past={model.past}
            onReopen={model.reopen}
            onNew={model.newThread}
            onSendDraft={(id, text, files, start, item) =>
               model.start(text, files, { draft: id, start, item })
            }
            onOpenDiff={(scope) => ctx.open(changesPanel, scope)}
         />
      );
   },
});
