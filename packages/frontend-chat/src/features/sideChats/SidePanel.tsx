import type { AttachmentInput, SessionApi, ThreadInfo } from "@harness/api";
import { Button, cn, DropdownMenuItem, Tooltip } from "@harness/ui";
import { History, LoaderCircle, Plus, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { PanelHeader } from "../../panels/PanelHeader";
import { type ChatState, initialState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import type { PendingMessage } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { PastChats } from "./PastChats";
import { SideDraft, type SideStart, ThreadView } from "./ThreadView";
import { isDraftThread } from "./threadTabs";

/** What a side chat tab shows next to its title: its Agent is working, or a reply came while it was not shown. */
export type SideChatStatus = "working" | "unread" | null;

/** How far the pointer moves before a press on a tab becomes a drag. */
const DRAG_PX = 4;

/** A Side Thread just started here, before its replay arrives. */
const STARTING: ChatState = { ...initialState(), side: true };

/**
 * The side chats: pill tabs in the panel header, one Side Thread per tab. Every open chat stays mounted
 * (hidden) so a half-typed prompt survives switching chats, hiding the panel and moving it.
 */
export function SidePanel({
   api,
   state,
   threads,
   active,
   titleOf,
   statusOf,
   env,
   focus,
   onSelect,
   onClose,
   onMove,
   past,
   onReopen,
   onNew,
   onSendDraft,
   onOpenDiff,
}: {
   api: SessionApi;
   state: ChatState;
   threads: string[];
   active: string | null;
   titleOf: (id: string) => string;
   statusOf: (id: string) => SideChatStatus;
   env: UiEnv;
   focus: { id: string; n: number };
   onSelect: (id: string) => void;
   onClose: (id: string) => void;
   /** Moves tab `id` in front of tab `before` (null: to the end). */
   onMove: (id: string, before: string | null) => void;
   /** Every Side Thread, for Past chats. */
   past: ThreadInfo[];
   onReopen: (id: string) => void;
   onNew: () => void;
   /** First message of a draft tab: starts its Side Thread. */
   onSendDraft: (
      draft: string,
      text: string,
      attachments: AttachmentInput[],
      start: SideStart,
      item: PendingMessage,
   ) => Promise<void>;
   onOpenDiff: (s: DiffScope) => void;
}) {
   const [pastOpen, setPastOpen] = useState(false);
   const strip = useRef<HTMLDivElement>(null);
   /** A drag just ended: the click that follows it is not a click on the tab. */
   const dragged = useRef(false);
   // Dragging a tab sideways moves it, as in the Files panel.
   const press = (e: ReactPointerEvent, id: string) => {
      if (e.button !== 0 || (e.target as Element).closest("[data-tab-close]")) return;
      // The panel header would start dragging the whole panel.
      e.stopPropagation();
      const x0 = e.clientX;
      let moving = false;
      dragged.current = false;
      const move = (m: PointerEvent) => {
         if (!moving && Math.abs(m.clientX - x0) < DRAG_PX) return;
         moving = true;
         dragged.current = true;
         const others = [
            ...(strip.current?.querySelectorAll<HTMLElement>("[data-tab]") ?? []),
         ].filter((el) => el.dataset.tab !== id);
         const before = others.find((el) => {
            const r = el.getBoundingClientRect();
            return r.left + r.width / 2 >= m.clientX;
         });
         onMove(id, before?.dataset.tab ?? null);
      };
      const up = () => {
         window.removeEventListener("pointermove", move);
         window.removeEventListener("pointerup", up);
         window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
   };
   return (
      <>
         <PanelHeader
            className="gap-1 pl-2.5"
            menu={
               <DropdownMenuItem onSelect={() => setPastOpen(true)}>
                  <History /> Past chats
               </DropdownMenuItem>
            }
         >
            <div
               ref={strip}
               role="tablist"
               aria-label="Side chats"
               className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            >
               {threads.map((id) => {
                  const on = id === active;
                  const title = titleOf(id);
                  const status = statusOf(id);
                  return (
                     <div
                        key={id}
                        data-tab={id}
                        onPointerDown={(e) => press(e, id)}
                        onAuxClick={(e) => e.button === 1 && onClose(id)}
                        className={cn(
                           "flex h-[26px] max-w-[170px] shrink-0 items-center gap-1 rounded-md pl-2.5 pr-[3px] text-xs",
                           on
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50",
                           status === "unread" && "font-semibold text-foreground",
                        )}
                     >
                        {status === "working" && (
                           <LoaderCircle
                              aria-label="Working"
                              className="size-3 shrink-0 animate-spin text-sky-500"
                           />
                        )}
                        {status === "unread" && (
                           <span
                              aria-label="New reply"
                              className="size-1.5 shrink-0 rounded-full bg-sky-500"
                           />
                        )}
                        <button
                           role="tab"
                           aria-selected={on}
                           className="min-w-0 truncate"
                           onClick={() => {
                              if (dragged.current) dragged.current = false;
                              else onSelect(id);
                           }}
                        >
                           {title}
                        </button>
                        <button
                           data-tab-close
                           className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-accent-foreground"
                           aria-label={`Close ${title}`}
                           onClick={() => onClose(id)}
                        >
                           <X className="size-3" />
                        </button>
                     </div>
                  );
               })}
               <Tooltip content="New side chat" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-[26px] shrink-0 text-muted-foreground hover:text-accent-foreground"
                     aria-label="New side chat"
                     onClick={onNew}
                  >
                     <Plus />
                  </Button>
               </Tooltip>
            </div>
         </PanelHeader>
         <PastChats
            open={pastOpen}
            onOpenChange={setPastOpen}
            chats={past}
            openIds={threads}
            onPick={onReopen}
         />
         <div className="relative min-h-0 flex-1">
            {threads.map((id) => (
               <div key={id} className={cn("h-full", id !== active && "hidden")}>
                  {isDraftThread(id) ? (
                     <SideDraft
                        api={api}
                        main={state}
                        draftId={id}
                        onSend={(text, files, start, item) =>
                           onSendDraft(id, text, files, start, item)
                        }
                        focusKey={focus.id === id ? focus.n : 0}
                     />
                  ) : (
                     <ThreadView
                        api={api}
                        thread={state.threads[id] ?? STARTING}
                        threadId={id}
                        mainCommands={state.commands}
                        env={env}
                        onOpenDiff={onOpenDiff}
                        focusKey={focus.id === id ? focus.n : 0}
                     />
                  )}
               </div>
            ))}
         </div>
      </>
   );
}
