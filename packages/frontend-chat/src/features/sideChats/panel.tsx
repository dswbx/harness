import type { AttachmentInput } from "@harness/api";
import { MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../lib/errors";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { changesPanel } from "../changes/panel";
import { clearDraft } from "../prompt/drafts";
import { useEnv } from "../renderUi/runtime";
import { addReviewComment, composerKey, setReviewComments } from "../review/reviewComments";
import { SidePanel } from "./SidePanel";
import type { SideStart } from "./ThreadView";
import {
   activeThreadId,
   closeThread,
   isDraftThread,
   newThreadTabId,
   openThread,
   openThreadIds,
   selectThread,
   takesDraftTab,
   threadStarted,
   useThreadTabs,
} from "./threadTabs";

export type SideChatsModel = {
   /** Open tabs that have something to show. */
   open: string[];
   active: string | null;
   titleOf: (id: string) => string;
   /** A prompt box takes focus in the chat that was just created. */
   focus: { id: string; n: number };
   /** Why the last Side Thread could not start. */
   error: string | null;
   select: (id: string) => void;
   close: (id: string) => void;
   /** A new side chat tab (an open draft is reused); returns its id. Its Side Thread starts with its first message. */
   newThread: () => string;
   /**
    * Starts a Side Thread now (forked from Main when the Agent can; `start` from a draft tab can pick fresh and a
    * mode), in place of tab `draft` or as a new tab, and sends it `text`.
    */
   start: (
      text: string,
      attachments: AttachmentInput[],
      draft?: string,
      start?: SideStart,
   ) => Promise<void>;
   /** "Ask in side thread": a new side chat with the selected text as a quote chip in its prompt box. */
   ask: (quote: string) => void;
   /** Side Threads in the Session (open or not). */
   count: number;
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
      const selfRef = useRef(self);
      selfRef.current = self;
      const [focus, setFocus] = useState<{ id: string; n: number }>({ id: "", n: 0 });
      const [error, setError] = useState<string | null>(null);

      const open = useMemo(() => openThreadIds(tabs.threads, state.threads), [tabs, state.threads]);
      const active = activeThreadId(tabs.thread, open);
      const sideThreads = useMemo(
         () => state.threadList.filter((t) => !t.main),
         [state.threadList],
      );
      const titleOf = useCallback(
         (id: string) =>
            isDraftThread(id)
               ? "New chat"
               : (sideThreads.find((x) => x.id === id)?.title ?? "Side chat"),
         [sideThreads],
      );

      const select = useCallback((id: string) => apply((t) => selectThread(t, id)), [apply]);
      const close = useCallback(
         (id: string) => {
            if (isDraftThread(id)) {
               setReviewComments(composerKey(api.sessionId, id), []);
               clearDraft(composerKey(api.sessionId, id));
            }
            // The last tab hides the panel.
            if (apply((t) => closeThread(t, id)).threads.length === 0) selfRef.current.hide();
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
         async (text: string, attachments: AttachmentInput[], draft?: string, s?: SideStart) => {
            setError(null);
            let thread_id: string;
            try {
               ({ thread_id } = await api.startSideThread(s));
            } catch (e) {
               setError(errorMessage(e));
               throw e;
            }
            // A draft tab that closed meanwhile does not take it: a new tab opens, and shows the panel.
            const own = takesDraftTab(tabsRef.current, draft);
            apply((t) => threadStarted(t, draft, thread_id));
            if (!own) selfRef.current.show();
            setFocus((f) => ({ id: thread_id, n: f.n + 1 }));
            await api.prompt(text, attachments, thread_id);
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
            titleOf,
            focus,
            error,
            select,
            close,
            newThread,
            start,
            ask,
            count: sideThreads.length,
         }),
         [
            open,
            active,
            titleOf,
            focus,
            error,
            select,
            close,
            newThread,
            start,
            ask,
            sideThreads.length,
         ],
      );
   },
   status: (m) => ({
      presence: m.open.length > 0 ? "ready" : "icon",
      badge: m.count,
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
            titleOf={model.titleOf}
            env={env}
            focus={model.focus}
            onSelect={model.select}
            onClose={model.close}
            onNew={model.newThread}
            onSendDraft={(id, text, files, start) => model.start(text, files, id, start)}
            onOpenDiff={(scope) => ctx.open(changesPanel, scope)}
         />
      );
   },
});
