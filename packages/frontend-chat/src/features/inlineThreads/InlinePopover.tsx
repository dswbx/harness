import type { SessionApi } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
   Popover,
   PopoverAnchor,
   PopoverContent,
   ScrollArea,
   Tooltip,
} from "@harness/ui";
import {
   ChevronLeft,
   ChevronRight,
   CircleCheck,
   Ellipsis,
   PanelRight,
   RotateCcw,
   Trash2,
   X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { groupConfigOptions } from "../../state/configGroups";
import { type ChatState, initialState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import { PromptBox, type PromptBoxHandle } from "../prompt/PromptBox";
import type { UiEnv } from "../renderUi/RenderUi";
import { type AnchorRegistry, isDraftAnchor } from "./anchors";
import { InlineMessages } from "./InlineMessages";
import type { InlineModel } from "./model";

const iconButton = "size-7 text-muted-foreground hover:text-accent-foreground";

function IconButton({
   label,
   onClick,
   children,
}: {
   label: string;
   onClick: () => void;
   children: ReactNode;
}) {
   return (
      <Tooltip content={label}>
         <Button
            size="icon"
            variant="ghost"
            className={iconButton}
            aria-label={label}
            onClick={onClick}
         >
            {children}
         </Button>
      </Tooltip>
   );
}

/**
 * The popover beside highlighted text: the Inline Threads (and drafts) the user opened there, newest first,
 * one at a time with a switcher. A draft shows only its composer. One instance per chat.
 */
export function InlinePopover({
   api,
   state,
   inline,
   registry,
   env,
   onOpenDiff,
   onShowInSideChats,
}: {
   api: SessionApi;
   /** The Main Thread's state. */
   state: ChatState;
   inline: InlineModel;
   registry: AnchorRegistry;
   env: UiEnv;
   onOpenDiff: (s: DiffScope) => void;
   onShowInSideChats: (id: string) => void;
}) {
   const ids = inline.openIds;
   const [page, setPage] = useState(0);
   const idsKey = ids?.join(",") ?? "";
   // biome-ignore lint/correctness/useExhaustiveDependencies: a new set of ids starts at the first.
   useEffect(() => setPage(0), [idsKey]);
   const id = ids ? (ids[Math.min(page, ids.length - 1)] ?? null) : null;

   // Where it points: the range the chat found for `id`. Kept while its message is still on screen (a
   // draft just sent: its Thread finds the same text a moment later). Closed while it is scrolled away.
   useSyncExternalStore(registry.subscribe, registry.getVersion);
   const last = useRef<{ id: string; range: Range; row: Element } | null>(null);
   const found = id ? registry.get(id) : null;
   if (id && found) last.current = { id, ...found };
   // The kept range is for the same id only, or for the Thread its draft was just sent as.
   const kept =
      id && last.current && (last.current.id === id || inline.sentAs(last.current.id) === id)
         ? last.current
         : null;
   const target = found ?? (kept?.row.isConnected ? kept : null);
   const virtualRef = useMemo(
      () =>
         target && {
            current: {
               getBoundingClientRect: () => target.range.getBoundingClientRect(),
               contextElement: target.row,
            },
         },
      [target?.range, target?.row, target],
   );

   const draft = id !== null && isDraftAnchor(id);
   const thread = id && !draft ? (inline.threads.find((t) => t.id === id) ?? null) : null;
   const quote = draft ? (inline.drafts[id]?.anchor.quote ?? "") : (thread?.anchor.quote ?? "");
   const threadState = useMemo(
      () => (thread ? (state.threads[thread.id] ?? null) : null),
      [thread, state.threads],
   );
   const shownState = useMemo(() => threadState ?? initialState(), [threadState]);

   // The draft's composer: Main's mode option, set to the asking mode until the user picks one.
   const [picked, setPicked] = useState<string | null>(null);
   // biome-ignore lint/correctness/useExhaustiveDependencies: each draft starts with the asking mode.
   useEffect(() => setPicked(null), [id]);
   const mainMode = useMemo(
      () => groupConfigOptions(state.configOptions).mode,
      [state.configOptions],
   );
   const mode = mainMode ? (picked ?? state.sideMode ?? mainMode.currentValue) : undefined;
   const draftState = useMemo<ChatState>(
      () => ({
         ...initialState(),
         commands: state.commands,
         configOptions: mainMode && mode ? [{ ...mainMode, currentValue: mode }] : [],
      }),
      [mainMode, mode, state.commands],
   );

   const prompt = useRef<PromptBoxHandle>(null);
   const open = !!ids && !!target && !!id;
   // A new draft takes focus.
   useEffect(() => {
      if (open && draft) requestAnimationFrame(() => prompt.current?.focus());
   }, [open, draft]);

   if (!open || !virtualRef) return null;
   return (
      <Popover open onOpenChange={(o) => !o && inline.close()}>
         <PopoverAnchor virtualRef={virtualRef} />
         <PopoverContent
            side="bottom"
            align="start"
            hideWhenDetached
            aria-label={draft ? "New inline question" : "Inline thread"}
            className="w-[min(30rem,calc(100vw-2rem))] p-0"
            onOpenAutoFocus={(e) => e.preventDefault()}
            // With text in a draft, only Close or Esc closes it: the popover may cover text the user wants to read.
            onInteractOutside={(e) => {
               if (ids.some((x) => isDraftAnchor(x) && inline.hasContent(x))) e.preventDefault();
            }}
            // Esc in the composer's "/" or "#" menu closes that menu (the editor handles it), not the popover.
            onEscapeKeyDown={(e) => {
               if (prompt.current?.menuOpen()) e.preventDefault();
            }}
         >
            <ScrollArea
               className="max-h-[var(--radix-popover-content-available-height)]"
               viewportClassName="max-h-[inherit]"
            >
               <div className="sticky top-0 z-10 flex items-center gap-0.5 border-b bg-popover px-2 py-1">
                  {ids.length > 1 && (
                     <div className="flex items-center text-xs tabular-nums text-muted-foreground">
                        <IconButton
                           label="Newer"
                           onClick={() => setPage((p) => Math.max(0, p - 1))}
                        >
                           <ChevronLeft />
                        </IconButton>
                        {Math.min(page, ids.length - 1) + 1}/{ids.length}
                        <IconButton
                           label="Older"
                           onClick={() => setPage((p) => Math.min(ids.length - 1, p + 1))}
                        >
                           <ChevronRight />
                        </IconButton>
                     </div>
                  )}
                  <span className="truncate px-1 text-xs font-medium text-muted-foreground">
                     {draft ? "New question" : thread?.resolved ? "Resolved" : "Inline thread"}
                  </span>
                  <div className="flex-1" />
                  {thread && (
                     <>
                        {thread.resolved ? (
                           <IconButton
                              label="Reopen"
                              onClick={() => inline.resolve(thread.id, false)}
                           >
                              <RotateCcw />
                           </IconButton>
                        ) : (
                           <IconButton
                              label="Resolve"
                              onClick={() => inline.resolve(thread.id, true)}
                           >
                              <CircleCheck />
                           </IconButton>
                        )}
                        <IconButton
                           label="Open in side chats"
                           onClick={() => {
                              inline.close();
                              onShowInSideChats(thread.id);
                           }}
                        >
                           <PanelRight />
                        </IconButton>
                     </>
                  )}
                  {draft && (
                     <DropdownMenu>
                        <Tooltip content="More">
                           <DropdownMenuTrigger asChild>
                              <Button
                                 size="icon"
                                 variant="ghost"
                                 className={iconButton}
                                 aria-label="More"
                              >
                                 <Ellipsis />
                              </Button>
                           </DropdownMenuTrigger>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                           <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => inline.discard(id)}
                           >
                              <Trash2 /> Discard draft
                           </DropdownMenuItem>
                        </DropdownMenuContent>
                     </DropdownMenu>
                  )}
                  <IconButton label="Close" onClick={() => inline.close()}>
                     <X />
                  </IconButton>
               </div>
               {thread && (
                  <InlineMessages
                     api={api}
                     thread={shownState}
                     threadId={thread.id}
                     quote={quote}
                     env={env}
                     onOpenDiff={onOpenDiff}
                  />
               )}
               {/* The Side Thread prompt box without the context ring; space above it when messages show. */}
               <div className={cn("*:px-3 *:pb-3", thread ? "pt-6" : "pt-2")}>
                  {draft ? (
                     <PromptBox
                        key={id}
                        ref={prompt}
                        api={api}
                        state={draftState}
                        threadId={id}
                        contextRing={false}
                        onSend={(text, files, item) => inline.send(id, text, files, item, mode)}
                        onConfigChange={(_, value) => setPicked(value)}
                     />
                  ) : (
                     thread && (
                        <PromptBox
                           key={thread.id}
                           ref={prompt}
                           api={api}
                           state={shownState}
                           threadId={thread.id}
                           contextRing={false}
                           commands={
                              shownState.commands.length ? shownState.commands : state.commands
                           }
                        />
                     )
                  )}
               </div>
            </ScrollArea>
         </PopoverContent>
      </Popover>
   );
}
