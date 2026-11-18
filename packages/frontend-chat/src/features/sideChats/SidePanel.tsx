import type { AttachmentInput, SessionApi, ThreadInfo } from "@harness/api";
import { Button, cn, DropdownMenuItem, StatusDot, Tooltip } from "@harness/ui";
import { History, Plus } from "lucide-react";
import { useState } from "react";
import { PanelHeader } from "../../panels/PanelHeader";
import { type PanelTab, PanelTabs } from "../../panels/PanelTabs";
import { type ChatState, initialState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import type { PendingMessage } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { PastChats } from "./PastChats";
import { SideDraft, type SideStart, ThreadView } from "./ThreadView";
import { isDraftThread } from "./threadTabs";

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
   return (
      <>
         <PanelHeader
            className="gap-1"
            menu={
               <DropdownMenuItem onSelect={() => setPastOpen(true)}>
                  <History /> Past chats
               </DropdownMenuItem>
            }
         >
            <PanelTabs
               label="Side chats"
               tabs={threads.map((id): PanelTab => {
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
                     className: status === "unread" ? "font-semibold text-foreground" : undefined,
                     after: (status === "working" || status === "needs_attention") && (
                        <StatusDot status={status} className="ml-0.5" />
                     ),
                  };
               })}
               active={active}
               onSelect={onSelect}
               onClose={onClose}
               onMove={onMove}
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
