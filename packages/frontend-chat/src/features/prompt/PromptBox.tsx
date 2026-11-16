import type { AgentSwitch, AttachmentInput, PromptContext, SessionApi } from "@harness/api";
import { errText } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import { Paperclip } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ChatState } from "../../state/reducer";
import { RecoveryCard } from "../interaction/RecoveryCard";
import { CommentChips } from "../review/CommentChip";
import {
   composerKey,
   getReviewComments,
   removeReviewComment,
   setReviewComments,
   useReviewComments,
   withReviewComments,
} from "../review/reviewComments";
import { ConfigBar, type MenuSide } from "./ConfigBar";
import { AttachmentChips } from "./chips/AttachmentChips";
import { ContextChip } from "./chips/ContextChip";
import { btwQuestion } from "./commands";
import { BackgroundJobs } from "./footer/BackgroundJobs";
import { ContextRing } from "./footer/ContextRing";
import { SendStopButton } from "./footer/SendStopButton";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { PrMenuPopup } from "./PromptMenu";
import { type PendingMessage, updatePendingMessages } from "./pendingMessages";
import { lineCount } from "./promptMarkdown";
import { SlashMenu } from "./SlashMenu";
import { useAttachments } from "./useAttachments";
import { useDraft } from "./useDraft";
import { usePendingActions } from "./usePendingActions";
import { usePendingSend } from "./usePendingSend";
import { usePromptMenus } from "./usePromptMenus";

/** Box content width (px) under which the footer's option pickers collapse into one menu. */
const NARROW_BOX = 460;

export type PromptBoxHandle = { focus(): void };

/**
 * The prompt box of the Main Thread, or of a Side Thread (`threadId`). Comments and quotes waiting in it are
 * kept per Thread. In the Main Thread, `/btw <question>` goes to `onSideThread` instead of being sent.
 */
export function PromptBox({
   api,
   state,
   threadId = null,
   onSideThread,
   onSend,
   onConfigChange,
   agentSwitch,
   elevated = false,
   menuSide = "top",
   context,
   ref: handle,
}: {
   api: SessionApi;
   state: ChatState;
   threadId?: string | null;
   /**
    * Starts a Side Thread and sends it `text` (Main Thread only). `item` is the message to show as pending in
    * that Thread once it started; a rejection means it did not start (the prompt box gets the message back).
    */
   onSideThread?: (
      text: string,
      attachments: AttachmentInput[],
      item: PendingMessage,
   ) => Promise<void>;
   /** Sends instead of `api.prompt` (a side chat not started yet), like `onSideThread`. */
   onSend?: (text: string, attachments: AttachmentInput[], item: PendingMessage) => Promise<void>;
   /** A config change stays local instead of `api.setConfigOption` (a side chat not started yet). */
   onConfigChange?: (id: string, value: string) => void;
   /** Quick overlay: an Agent > model menu in the footer (other Agents disabled once `locked`). */
   agentSwitch?: AgentSwitch;
   /** Floats over other apps (Quick overlay): the overlay's shadow. */
   elevated?: boolean;
   /** Where its menus open (below: the Quick overlay's draft, which has room only below). */
   menuSide?: MenuSide;
   /** Quick overlay: a removable context chip; each message sends its attachment while it shows. */
   context?: PromptContext;
   ref?: Ref<PromptBoxHandle>;
}) {
   const [text, setText] = useState("");
   const [lines, setLines] = useState(0);
   const [overflow, setOverflow] = useState(false);
   const ref = useRef<PromptEditorHandle>(null);
   useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);
   const key = composerKey(api.sessionId, threadId);
   const saveDraft = useDraft(key, ref);
   const running = state.turnId !== null;
   const {
      open,
      count,
      index,
      used,
      refs,
      setSel,
      pick,
      pickPr,
      onMenuKey,
      onToken,
      onTextChange,
   } = usePromptMenus({
      text,
      commands: state.commands,
      threadId,
      onSideThread,
      editor: ref,
   });
   const pct = state.usage
      ? Math.min(100, Math.round((state.usage.used / state.usage.size) * 100))
      : null;

   const [error, setError] = useState<string | null>(null);
   const readOnly = state.readOnly;
   const userCount = useMemo(
      () => state.items.filter((i) => i.type === "user").length,
      [state.items],
   );
   const { failed, sending, deliver, retry } = usePendingSend({
      key,
      userCount,
      send: (p) => api.prompt(p.prompt, p.inputs, threadId),
      onError: setError,
   });
   const comments = useReviewComments(key);
   // Width of the box itself (not the window): a side panel or narrow column collapses the option pickers.
   const [narrow, setNarrow] = useState(false);
   const boxRef = useRef<HTMLDivElement>(null);
   useEffect(() => {
      const el = boxRef.current;
      if (!el) return;
      const ro = new ResizeObserver(([e]) => e && setNarrow(e.contentRect.width < NARROW_BOX));
      ro.observe(el);
      return () => ro.disconnect();
   }, []);
   const { attachments, setAttachments, dragging, fileInput, attach, boxHandlers, inputProps } =
      useAttachments({
         key,
         api,
         caps: state.promptCaps,
         boxRef,
         main: threadId === null,
         setError,
      });

   // Restore uses the exact pre-send editor state, not the sent Markdown (re-parsing could turn literal `*x*` into formatting).
   const send = () => {
      const ed = ref.current;
      const t = ed?.getMarkdown().trim() ?? "";
      const sent = getReviewComments(key);
      const files = attachments;
      if (!ed || (!t && sent.length === 0 && files.length === 0) || readOnly) return;
      const snap = ed.snapshot();
      ed.clear();
      setReviewComments(key, []);
      setAttachments([]);
      setError(null);
      // Our `/btw <question>` wins over an Agent command of the same name (Claude Code has one).
      const btw = threadId || !onSideThread ? null : btwQuestion(t);
      // The window context goes as an attachment: the message stays as typed.
      const inputs = [...files.map((a) => a.input), ...(context ? [context.attachment] : [])];
      const prompt = btw ? withReviewComments(btw, sent) : withReviewComments(t, sent);
      const item: PendingMessage = {
         id: crypto.randomUUID(),
         prompt,
         inputs,
         files,
         comments: sent,
         snap,
         status: "sending",
         base: 0,
      };
      if (!btw && !onSend) {
         void deliver(item, () => api.prompt(prompt, inputs, threadId));
         return;
      }
      (btw && onSideThread
         ? onSideThread(prompt, inputs, item)
         : (onSend as NonNullable<typeof onSend>)(prompt, inputs, item)
      ).catch((err) => {
         setError(errText(err));
         ref.current?.restore(snap);
         setAttachments((cur) => [...files, ...cur]);
         // Put them back ahead of any added since.
         setReviewComments(key, [...sent, ...getReviewComments(key)]);
      });
   };
   const editPending = (item: PendingMessage) => {
      const ed = ref.current;
      if (!ed) return;
      if (ed.getMarkdown().trim()) {
         setError("Clear the prompt box to edit this message.");
         return;
      }
      setError(null);
      ed.restore(item.snap);
      setAttachments((cur) => [...item.files, ...cur]);
      setReviewComments(key, [...item.comments, ...getReviewComments(key)]);
      updatePendingMessages(key, (cur) => cur.filter((p) => p.id !== item.id));
   };
   usePendingActions(key, { retry: () => void retry(), edit: editPending });
   const continueWithSummary = async () => {
      const [first, ...rest] = failed;
      if (first) {
         setError(null);
         const ok = await deliver(first, () =>
            api.continueWithSummary(first.prompt, threadId, first.inputs),
         );
         if (!ok) return;
         for (const p of rest) {
            if (!(await deliver(p, () => api.prompt(p.prompt, p.inputs, threadId)))) return;
         }
         return;
      }
      const ed = ref.current;
      const t = ed?.getMarkdown().trim() ?? "";
      const snap = ed?.snapshot();
      ed?.clear();
      setError(null);
      api.continueWithSummary(t || null, threadId).catch((err) => {
         setError(errText(err));
         if (t && snap) ref.current?.restore(snap);
      });
   };

   return (
      <div className="relative mx-auto w-full max-w-3xl px-6 pb-3.5">
         {open?.kind === "slash" && (
            <SlashMenu
               items={open.items}
               index={index}
               side={menuSide}
               onHover={setSel}
               onPick={pick}
            />
         )}
         {open?.kind === "pr" && refs && (
            <PrMenuPopup
               menu={open.menu}
               refs={refs}
               sel={index}
               side={menuSide}
               onSelect={setSel}
               onPick={pickPr}
            />
         )}
         {state.recovery && !sending && (
            <RecoveryCard
               recovery={state.recovery}
               canRetry={failed.length > 0}
               onRetry={() => void retry()}
               onContinue={() => void continueWithSummary()}
            />
         )}
         {error && !(state.recovery && failed.length > 0) && (
            <div role="alert" className="mb-2 whitespace-pre-wrap text-xs text-destructive">
               {error}
            </div>
         )}
         {state.backgroundJobs.length > 0 && <BackgroundJobs jobs={state.backgroundJobs} />}
         <div
            ref={boxRef}
            className={cn(
               "rounded-2xl border bg-card px-3 pb-2 pt-3 transition-colors dark:border-card",
               elevated ? "shadow-overlay" : "shadow-sm",
               dragging
                  ? "border-ring bg-accent/40 dark:border-ring"
                  : "focus-within:border-ring/50 dark:focus-within:border-border",
            )}
            {...boxHandlers}
         >
            <input ref={fileInput} type="file" multiple hidden {...inputProps} />
            {context && <ContextChip context={context} />}
            {attachments.length > 0 && (
               <AttachmentChips
                  items={attachments}
                  onRemove={(id) => setAttachments((cur) => cur.filter((a) => a.id !== id))}
               />
            )}
            {comments.length > 0 && (
               <CommentChips
                  className="pb-1.5"
                  comments={comments}
                  onRemove={(id) => removeReviewComment(key, id)}
               />
            )}
            <PromptEditor
               ref={ref}
               placeholder={
                  running
                     ? "Agent is working... (a message goes to it now)"
                     : sending && (state.restoring || state.process?.state === "starting")
                       ? "Agent is starting... (a message goes to it once ready)"
                       : threadId
                         ? "Ask in this side thread"
                         : "Message the Agent. Type / for commands."
               }
               command={used}
               menuOpen={count > 0}
               onMenuKey={onMenuKey}
               onToken={onToken}
               onChange={(t, md) => {
                  onTextChange(t);
                  setText(t);
                  setLines(lineCount(md));
                  saveDraft(t);
               }}
               onSubmit={send}
               onOverflowChange={setOverflow}
            />
            <div className="flex flex-wrap items-center gap-1 pt-1">
               <Tooltip content="Attach files or images">
                  <button
                     type="button"
                     className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                     aria-label="Attach files or images"
                     disabled={readOnly}
                     onClick={() => void attach().catch((err) => setError(errText(err)))}
                  >
                     <Paperclip className="size-4" />
                  </button>
               </Tooltip>
               {/* Side Threads follow Main's config except the mode, which they own: only the mode picker there. */}
               <ConfigBar
                  compact={narrow}
                  modeOnly={!!threadId}
                  agentSwitch={agentSwitch}
                  side={menuSide}
                  options={state.configOptions}
                  onChange={(id, value) => {
                     setError(null);
                     if (onConfigChange) return onConfigChange(id, value);
                     api.setConfigOption(id, value, threadId).catch((err) =>
                        setError(errText(err)),
                     );
                  }}
               />
               <div className="flex-1" />
               {overflow && (
                  <span className="text-xs tabular-nums text-muted-foreground">{lines} lines</span>
               )}
               {pct != null && (
                  <ContextRing pct={pct} used={state.usage!.used} size={state.usage!.size} />
               )}
               <SendStopButton
                  running={running}
                  disabled={
                     (!text.trim() && comments.length === 0 && attachments.length === 0) || readOnly
                  }
                  onSend={send}
                  onStop={() => {
                     setError(null);
                     api.cancel(threadId).catch((err) => setError(errText(err)));
                  }}
               />
            </div>
         </div>
      </div>
   );
}
