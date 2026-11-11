import type { AttachmentInput, SessionApi } from "@harness/api";
import { ScrollArea, ToggleGroup, ToggleGroupItem } from "@harness/ui";
import { MessagesSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { groupConfigOptions } from "./configGroups";
import type { DiffScope } from "./DiffPanel";
import { MessageList, useRows } from "./Messages";
import { PromptBox, type PromptBoxHandle } from "./PromptBox";
import type { UiEnv } from "./RenderUi";
import { type ChatState, initialState } from "./reducer";
import { ScrollUnder } from "./ScrollUnder";

/** A Side Thread in the right panel: its messages (opening with how it started) and its own prompt box. */
export function ThreadView({
   api,
   thread,
   threadId,
   env,
   onOpenDiff,
   focusKey,
}: {
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
   const sideEnv = useMemo<UiEnv>(
      () => ({ ...env, send: (text) => api.prompt(text, [], threadId) }),
      [env, api, threadId],
   );
   useEffect(() => {
      if (focusKey) prompt.current?.focus();
   }, [focusKey]);

   return (
      <aside
         className="flex h-full w-full min-w-0 flex-col border-l bg-background"
         aria-label="Side chat"
      >
         <ScrollUnder
            bottom={<PromptBox ref={prompt} api={api} state={thread} threadId={threadId} />}
         >
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
      <div
         aria-hidden
         className="relative w-52 rounded-lg border bg-card px-3.5 pt-9 pb-3.5 shadow-sm"
      >
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

/** How a side chat starts: from the conversation so far, or without it. */
export type SideStart = { source: "fork" | "fresh"; mode?: string };

const START_TEXT: Record<SideStart["source"], string> = {
   fork: "Knows what the Main Thread read and decided. Not added to the Main Thread's context.",
   fresh: "New agent session in the same workspace, without this conversation. Good for an independent review.",
};

/**
 * A side chat not started yet: its Side Thread starts on the first message, so opening one costs nothing.
 * What it starts from and its mode are picked here and stay local until then.
 */
export function SideDraft({
   api,
   main,
   draftId,
   onSend,
   focusKey,
}: {
   api: SessionApi;
   /** The Main Thread: its mode option and the Agent's asking mode (the default here). */
   main: ChatState;
   draftId: string;
   onSend: (text: string, attachments: AttachmentInput[], start: SideStart) => Promise<void>;
   focusKey: number;
}) {
   const prompt = useRef<PromptBoxHandle>(null);
   const [source, setSource] = useState<SideStart["source"]>("fork");
   const [picked, setPicked] = useState<string | null>(null);
   const mainMode = useMemo(
      () => groupConfigOptions(main.configOptions).mode,
      [main.configOptions],
   );
   const mode = mainMode ? (picked ?? main.sideMode ?? mainMode.currentValue) : undefined;
   const draft = useMemo<ChatState>(
      () => ({
         ...initialState(),
         configOptions: mainMode && mode ? [{ ...mainMode, currentValue: mode }] : [],
      }),
      [mainMode, mode],
   );
   useEffect(() => {
      if (focusKey) prompt.current?.focus();
   }, [focusKey]);
   return (
      <aside
         className="flex h-full w-full min-w-0 flex-col border-l bg-background"
         aria-label="New side chat"
      >
         <ScrollArea className="min-h-0 flex-1">
            <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 py-6 text-center">
               <div className="grid justify-items-center gap-3">
                  <p className="text-sm font-medium">Ask on the side</p>
                  <ToggleGroup
                     type="single"
                     aria-label="Start from"
                     value={source}
                     onValueChange={(v) => {
                        if (v) setSource(v as SideStart["source"]);
                     }}
                  >
                     <ToggleGroupItem value="fork">Full conversation</ToggleGroupItem>
                     <ToggleGroupItem value="fresh">Nothing</ToggleGroupItem>
                  </ToggleGroup>
                  <p className="max-w-72 text-[13px] text-muted-foreground">{START_TEXT[source]}</p>
               </div>
               {/* Starting from a selection always uses the conversation: hint only for that choice. */}
               {source === "fork" && (
                  <>
                     <SelectionHint />
                     <p className="max-w-60 text-xs text-muted-foreground">
                        Or select text in the chat and pick{" "}
                        <span className="font-medium text-foreground">Ask in side thread</span> to
                        start one with a quote.
                     </p>
                  </>
               )}
            </div>
         </ScrollArea>
         <PromptBox
            ref={prompt}
            api={api}
            state={draft}
            threadId={draftId}
            onSend={(text, files) => onSend(text, files, { source, ...(mode && { mode }) })}
            onConfigChange={(_, value) => setPicked(value)}
         />
      </aside>
   );
}
