import type { AttachmentInput, SessionApi } from "@harness/api";
import { Button, cn, Tooltip } from "@harness/ui";
import { LoaderCircle, Plus, X } from "lucide-react";
import { PanelHeader } from "../../panels/PanelHeader";
import { type ChatState, initialState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import type { PendingMessage } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { SideDraft, type SideStart, ThreadView } from "./ThreadView";
import { isDraftThread } from "./threadTabs";

/** What a side chat tab shows next to its title: its Agent is working, or a reply came while it was not shown. */
export type SideChatStatus = "working" | "unread" | null;

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
   return (
      <>
         <PanelHeader className="gap-1 pl-2.5">
            <div
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
                           onClick={() => onSelect(id)}
                        >
                           {title}
                        </button>
                        <button
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
