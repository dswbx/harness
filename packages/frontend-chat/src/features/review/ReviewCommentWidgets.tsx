import { errText, type LineCommentState, type SessionApi } from "@harness/api";
import { Button, cn, Textarea, Tooltip } from "@harness/ui";
import { Check, CheckCheck, MessageSquare, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import "../changes/diffView.css";

/**
 * The form under a code line (diff or file view). Adds a comment (it goes to the prompt box), or with
 * `initial` edits one. `onSubmit` may reject: the message shows here and the form stays open.
 */
export function CommentForm({
   onSubmit,
   onCancel,
   initial = "",
   submitLabel = "Add to prompt",
   inline = false,
}: {
   onSubmit: (text: string) => void | Promise<void>;
   onCancel: () => void;
   initial?: string;
   submitLabel?: string;
   /** Inside a comment list: no frame of its own. */
   inline?: boolean;
}) {
   const [text, setText] = useState(initial);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const submit = async () => {
      if (!text.trim() || busy) return;
      setBusy(true);
      setError(null);
      try {
         await onSubmit(text);
      } catch (e) {
         setError(errText(e));
      } finally {
         setBusy(false);
      }
   };
   return (
      <div
         className={cn(
            "space-y-1.5 font-sans",
            !inline && "harness-diff-widget border-y bg-muted/40 p-2",
         )}
      >
         <Textarea
            autoFocus
            // Editing: the caret starts after the text, not before it.
            onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
            value={text}
            rows={2}
            placeholder={`Comment for the Agent. Enter ${initial ? "saves" : "adds"}, Shift+Enter new line, Esc cancels.`}
            className="min-h-12 text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
               if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
               } else if (e.key === "Escape") {
                  e.stopPropagation();
                  onCancel();
               }
            }}
         />
         {error && (
            <div role="alert" className="text-xs text-destructive">
               {error}
            </div>
         )}
         <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>
               Cancel
            </Button>
            <Button
               size="sm"
               className="h-6 px-2 text-xs"
               disabled={!text.trim() || busy}
               onClick={() => void submit()}
            >
               {submitLabel}
            </Button>
         </div>
      </div>
   );
}

const iconButton =
   "rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground";

function Pill({ children, tip }: { children: React.ReactNode; tip?: string }) {
   const pill = (
      <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
         {children}
      </span>
   );
   return tip ? <Tooltip content={tip}>{pill}</Tooltip> : pill;
}

/** One comment on a line, by its status (ADR 0027): pending is editable, open can be resolved, resolved is collapsed. */
function CommentRow({
   api,
   comment: c,
   outdated,
}: {
   api: SessionApi;
   comment: LineCommentState;
   outdated: boolean;
}) {
   const [editing, setEditing] = useState(false);
   const [expanded, setExpanded] = useState(false);
   const [error, setError] = useState<string | null>(null);
   // A core refusal (e.g. editing a comment that was just sent) shows for a moment.
   useEffect(() => {
      if (!error) return;
      const t = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(t);
   }, [error]);
   const act = (f: () => Promise<void>) => f().catch((e) => setError(errText(e)));

   if (c.status === "resolved") {
      const by = c.resolvedBy === "agent" ? "Agent" : "you";
      return (
         <div className="text-xs text-muted-foreground">
            <button
               type="button"
               aria-expanded={expanded}
               className={cn(
                  "flex w-full min-w-0 gap-1.5 text-left hover:text-foreground",
                  expanded ? "items-start" : "items-center",
               )}
               onClick={() => setExpanded((v) => !v)}
            >
               <CheckCheck className={cn("size-3 shrink-0", expanded && "mt-0.5")} />
               <span
                  className={cn(
                     "min-w-0 flex-1",
                     expanded ? "whitespace-pre-wrap break-words" : "truncate",
                  )}
               >
                  {c.text}
               </span>
               <Pill>Resolved</Pill>
            </button>
            {expanded && (
               <div className="mt-0.5 pl-[18px] italic">
                  Resolved by {by}
                  {c.note && `: ${c.note}`}
               </div>
            )}
         </div>
      );
   }

   if (editing)
      return (
         <CommentForm
            inline
            initial={c.text}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={async (text) => {
               await api.editComment(c.id, text.trim());
               setEditing(false);
            }}
         />
      );

   return (
      <div className="space-y-0.5">
         <div className="flex items-start gap-1.5 text-xs">
            <MessageSquare className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            <span
               className="min-w-0 flex-1 whitespace-pre-wrap break-words"
               // Double-click edits a pending comment (the pencil does the same).
               onDoubleClick={c.status === "pending" ? () => setEditing(true) : undefined}
            >
               {c.text}
            </span>
            {outdated && <Pill tip="The line changed since this comment">Outdated</Pill>}
            {c.by === "agent" && <Pill>Agent</Pill>}
            {c.status === "pending" ? (
               <>
                  {/* Before the pill: keeps edit away from remove. */}
                  <Tooltip content="Edit comment (or double-click it)">
                     <button
                        className={iconButton}
                        aria-label="Edit comment"
                        onClick={() => setEditing(true)}
                     >
                        <Pencil className="size-3" />
                     </button>
                  </Tooltip>
                  <Pill tip="In the prompt box until you send it">Pending</Pill>
                  <Tooltip content="Remove comment">
                     <button
                        className={iconButton}
                        aria-label="Remove comment"
                        onClick={() => act(() => api.deleteComment(c.id))}
                     >
                        <X className="size-3" />
                     </button>
                  </Tooltip>
               </>
            ) : (
               <>
                  {c.by === "user" && <Pill tip="Sent to the Agent">Sent</Pill>}
                  <Tooltip content="Resolve">
                     <button
                        className={iconButton}
                        aria-label="Resolve comment"
                        onClick={() => act(() => api.resolveComment(c.id))}
                     >
                        <Check className="size-3" />
                     </button>
                  </Tooltip>
               </>
            )}
         </div>
         {error && (
            <div role="alert" className="pl-[18px] text-xs text-destructive">
               {error}
            </div>
         )}
      </div>
   );
}

/** The comments on one code line (diff or file view). `outdated`: ids whose line no longer holds their code. */
export function CommentList({
   api,
   comments,
   outdated,
}: {
   api: SessionApi;
   comments: readonly LineCommentState[];
   outdated?: ReadonlySet<string>;
}) {
   return (
      <div className="harness-diff-widget space-y-1 border-y bg-muted/40 px-2 py-1.5 font-sans">
         {comments.map((c) => (
            <CommentRow key={c.id} api={api} comment={c} outdated={!!outdated?.has(c.id)} />
         ))}
      </div>
   );
}
