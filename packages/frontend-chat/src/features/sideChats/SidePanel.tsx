import type { AttachmentInput, SessionApi, ThreadInfo } from "@harness/api";
import { formatAge } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenuItem,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   StatusDot,
   Tooltip,
} from "@harness/ui";
import { History, Plus } from "lucide-react";
import { PanelHeader } from "../../panels/PanelHeader";
import { type PanelTab, PanelTabs } from "../../panels/PanelTabs";
import { type ChatState, initialState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import { InlineList } from "../inlineThreads/InlineList";
import type { InlineModel } from "../inlineThreads/model";
import type { PendingMessage } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { SideDraft, type SideStart, ThreadView } from "./ThreadView";
import { INLINE_TAB, isDraftThread } from "./threadTabs";

/**
 * What a side chat tab shows, as the sidebar does for Sessions: a dot while its Agent works or waits for the
 * user, a bold title for a reply that came while the tab was not shown.
 */
export type SideChatStatus = "working" | "needs_attention" | "unread" | null;

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
   inline,
   inlineCount,
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
   /** The fixed Inline tab's model; null: the tab is hidden. */
   inline: InlineModel | null;
   /** Unresolved Inline Threads and drafts. */
   inlineCount: number;
   titleOf: (id: string) => string;
   statusOf: (id: string) => SideChatStatus;
   env: UiEnv;
   focus: { id: string; n: number };
   onSelect: (id: string) => void;
   onClose: (id: string) => void;
   /** Moves tab `id` in front of tab `before` (null: to the end). */
   onMove: (id: string, before: string | null) => void;
   /** Every Side Thread, newest activity first: Past chats lists the closed ones. */
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
   const closed = past.filter((c) => !threads.includes(c.id));
   const now = Date.now();
   const inlineTab: PanelTab[] = inline
      ? [
           {
              id: INLINE_TAB,
              name: `Inline · ${inlineCount}`,
              ariaLabel: `Inline threads (${inlineCount})`,
              fixed: true,
              after: inline.threads.some((t) => inline.statusOf(t.id) === "running") && (
                 <StatusDot status="working" className="ml-0.5" />
              ),
           },
        ]
      : [];
   return (
      <>
         <PanelHeader
            className="gap-1"
            menu={
               <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={closed.length === 0}>
                     <History /> Past chats
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-64">
                     {closed.map((c) => (
                        <DropdownMenuItem key={c.id} onSelect={() => onReopen(c.id)}>
                           <span className="min-w-0 flex-1 truncate">{c.title ?? "Side chat"}</span>
                           <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                              {formatAge(c.lastAt, now)}
                           </span>
                        </DropdownMenuItem>
                     ))}
                  </DropdownMenuSubContent>
               </DropdownMenuSub>
            }
         >
            <PanelTabs
               label="Side chats"
               tabs={inlineTab.concat(
                  threads.map((id): PanelTab => {
                     const name = titleOf(id);
                     const status = statusOf(id);
                     return {
                        id,
                        name,
                        label: (
                           <>
                              {name}
                              {status === "unread" && (
                                 <span className="sr-only"> (new, not seen)</span>
                              )}
                           </>
                        ),
                        className:
                           status === "unread" ? "font-semibold text-foreground" : undefined,
                        after: (status === "working" || status === "needs_attention") && (
                           <StatusDot status={status} className="ml-0.5" />
                        ),
                     };
                  }),
               )}
               active={active}
               onSelect={onSelect}
               onClose={onClose}
               // Nothing goes in front of the Inline tab.
               onMove={(id, before) =>
                  onMove(id, before === INLINE_TAB ? (threads[0] ?? null) : before)
               }
            >
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
            </PanelTabs>
         </PanelHeader>
         <div className="relative min-h-0 flex-1">
            {inline && active === INLINE_TAB && (
               <InlineList sessionId={api.sessionId} inline={inline} onOpenInSideChats={onReopen} />
            )}
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
