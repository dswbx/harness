import { useEffect, useMemo, useRef } from "react";
import { MessagesSquare } from "lucide-react";
import type { AttachmentInput, SessionApi } from "@harness/api";
import type { DiffScope } from "./DiffPanel";
import { MessageList, useRows } from "./Messages";
import { PromptBox, type PromptBoxHandle } from "./PromptBox";
import { ScrollUnder } from "./ScrollUnder";
import { initialState, type ChatState } from "./reducer";
import type { UiEnv } from "./RenderUi";

/** A Side Thread in the right panel: its messages (opening with how it started) and its own prompt box. */
export function ThreadView({ api, thread, threadId, env, onOpenDiff, focusKey }: {
  api: SessionApi;
  thread: ChatState;
  threadId: string;
  env: UiEnv;
  onOpenDiff: (s: DiffScope) => void;
  /** Changes when the prompt box should take focus (the chat was just created). */
  focusKey: number;
}) {
  const prompt = useRef<PromptBoxHandle>(null);
  const { ui, rows, subagents } = useRows(thread.items);
  const sideEnv = useMemo<UiEnv>(() => ({ ...env, send: (text) => api.prompt(text, [], threadId) }), [env, api, threadId]);
  useEffect(() => {
    if (focusKey) prompt.current?.focus();
  }, [focusKey]);

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l bg-background" aria-label="Side chat">
      <ScrollUnder bottom={<PromptBox ref={prompt} api={api} state={thread} threadId={threadId} />}>
        {(inset) => (
          <MessageList
            api={api}
            state={thread}
            threadId={threadId}
            side
            env={sideEnv}
            ui={ui}
            rows={rows}
            subagents={subagents}
            onOpenDiff={onOpenDiff}
            empty="Ask a question. The Main Thread never sees this."
            inset={inset}
          />
        )}
      </ScrollUnder>
    </aside>
  );
}

/** Two lines of a chat message, part of one selected, under the "Ask in side thread" pill: where else side chats start. */
function SelectionHint() {
  return (
    <div aria-hidden className="relative w-52 rounded-lg border bg-card px-3.5 pt-9 pb-3.5 shadow-sm">
      <div className="absolute top-2.5 left-9 flex items-center gap-1 rounded-md border bg-popover px-1.5 py-0.5 text-[10px] font-medium text-popover-foreground shadow-md">
        <MessagesSquare className="size-3" /> Ask in side thread
      </div>
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-8 rounded-full bg-muted-foreground/30" />
        <span className="h-3 w-24 rounded-sm bg-primary/25 ring-1 ring-primary/40" />
        <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
      </div>
      <div className="mt-2 h-1.5 w-36 rounded-full bg-muted-foreground/20" />
      <div className="mt-2 h-1.5 w-28 rounded-full bg-muted-foreground/20" />
    </div>
  );
}

/** A side chat not started yet: its Side Thread forks from Main on the first message, so opening one costs nothing. */
export function SideDraft({ api, draftId, onSend, focusKey }: {
  api: SessionApi;
  draftId: string;
  onSend: (text: string, attachments: AttachmentInput[]) => Promise<void>;
  focusKey: number;
}) {
  const prompt = useRef<PromptBoxHandle>(null);
  const empty = useMemo(initialState, []);
  useEffect(() => {
    if (focusKey) prompt.current?.focus();
  }, [focusKey]);
  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l bg-background" aria-label="New side chat">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 text-center">
        <div className="grid gap-1">
          <p className="text-sm font-medium">Ask on the side</p>
          <p className="text-[13px] text-muted-foreground">Your first message starts this chat from the conversation so far. The Main Thread never sees it.</p>
        </div>
        <SelectionHint />
        <p className="max-w-60 text-xs text-muted-foreground">Or select text in the chat and pick <span className="font-medium text-foreground">Ask in side thread</span> to start one with a quote.</p>
      </div>
      <PromptBox ref={prompt} api={api} state={empty} threadId={draftId} onSend={onSend} />
    </aside>
  );
}
