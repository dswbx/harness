import { Plus, X } from "lucide-react";
import type { AttachmentInput, SessionApi } from "@harness/api";
import { Button, Tooltip, cn } from "@harness/ui";
import type { DiffScope } from "./DiffPanel";
import { PanelHeader } from "./PanelHeader";
import type { ChatState } from "./reducer";
import type { UiEnv } from "./RenderUi";
import { isDraftThread } from "./panelLayout";
import { SideDraft, ThreadView } from "./ThreadView";

/**
 * The side chats: pill tabs in the panel header, one Side Thread per tab. Every open chat stays mounted
 * (hidden) so a half-typed prompt survives switching chats, hiding the panel and moving it.
 */
export function SidePanel({ api, state, threads, active, titleOf, env, focus, onSelect, onClose, onNew, onSendDraft, onOpenDiff }: {
  api: SessionApi;
  state: ChatState;
  threads: string[];
  active: string | null;
  titleOf: (id: string) => string;
  env: UiEnv;
  focus: { id: string; n: number };
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** First message of a draft tab: starts its Side Thread. */
  onSendDraft: (draft: string, text: string, attachments: AttachmentInput[]) => Promise<void>;
  onOpenDiff: (s: DiffScope) => void;
}) {
  return (
    <>
      <PanelHeader className="gap-1 pl-2.5">
        <div role="tablist" aria-label="Side chats" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {threads.map((id) => {
            const on = id === active;
            const title = titleOf(id);
            return (
              <div key={id} className={cn("flex h-[26px] max-w-[170px] shrink-0 items-center gap-1 rounded-md pl-2.5 pr-[3px] text-xs", on ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}>
                <button role="tab" aria-selected={on} className="min-w-0 truncate" onClick={() => onSelect(id)}>{title}</button>
                <button className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-accent-foreground" aria-label={`Close ${title}`} onClick={() => onClose(id)}>
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <Tooltip content="New side chat" side="bottom">
            <Button size="icon" variant="ghost" className="size-[26px] shrink-0 text-muted-foreground hover:text-accent-foreground" aria-label="New side chat" onClick={onNew}>
              <Plus />
            </Button>
          </Tooltip>
        </div>
      </PanelHeader>
      <div className="relative min-h-0 flex-1">
        {threads.map((id) => (
          <div key={id} className={cn("h-full", id !== active && "hidden")}>
            {isDraftThread(id) ? (
              <SideDraft api={api} draftId={id} onSend={(text, files) => onSendDraft(id, text, files)} focusKey={focus.id === id ? focus.n : 0} />
            ) : (
              <ThreadView api={api} thread={state.threads[id]!} threadId={id} env={env} onOpenDiff={onOpenDiff} focusKey={focus.id === id ? focus.n : 0} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}
