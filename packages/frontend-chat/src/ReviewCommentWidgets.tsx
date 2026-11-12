import { Button, Textarea, Tooltip } from "@harness/ui";
import { MessageSquare, X } from "lucide-react";
import { useState } from "react";
import "./diffView.css";
import { type ReviewComment, removeReviewComment } from "./reviewComments";

/** The form under a code line (diff or file view): the comment goes to the prompt box on submit. */
export function CommentForm({
   onSubmit,
   onCancel,
}: {
   onSubmit: (text: string) => void;
   onCancel: () => void;
}) {
   const [text, setText] = useState("");
   const submit = () => text.trim() && onSubmit(text);
   return (
      <div className="harness-diff-widget space-y-1.5 border-y bg-muted/40 p-2 font-sans">
         <Textarea
            autoFocus
            value={text}
            rows={2}
            placeholder="Comment for the Agent. Enter adds, Shift+Enter new line, Esc cancels."
            className="min-h-12 text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
               if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
               } else if (e.key === "Escape") {
                  e.stopPropagation();
                  onCancel();
               }
            }}
         />
         <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>
               Cancel
            </Button>
            <Button size="sm" className="h-6 px-2 text-xs" disabled={!text.trim()} onClick={submit}>
               Add to prompt
            </Button>
         </div>
      </div>
   );
}

/** The saved comments on one code line (diff or file view), each with a remove button. */
export function CommentList({
   sessionId,
   comments,
}: {
   sessionId: string;
   comments: ReviewComment[];
}) {
   return (
      <div className="harness-diff-widget space-y-1 border-y bg-muted/40 px-2 py-1.5 font-sans">
         {comments.map((c) => (
            <div key={c.id} className="flex items-start gap-1.5 text-xs">
               <MessageSquare className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
               <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.text}</span>
               <Tooltip content="Remove comment">
                  <button
                     className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                     aria-label="Remove comment"
                     onClick={() => removeReviewComment(sessionId, c.id)}
                  >
                     <X className="size-3" />
                  </button>
               </Tooltip>
            </div>
         ))}
      </div>
   );
}
