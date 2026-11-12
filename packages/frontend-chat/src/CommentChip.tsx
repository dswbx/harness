import { cn, ScrollArea, Tooltip } from "@harness/ui";
import { ClipboardList, Layers, MessageSquare, X } from "lucide-react";
import { InlineMarkdown, Markdown } from "./Markdown";
import type { ReviewComment } from "./reviewComments";

const sourceIcon = (c: ReviewComment) =>
   c.kind === "quote" && c.source === "plan"
      ? ClipboardList
      : c.kind === "quote" && c.source === "artifact"
        ? Layers
        : MessageSquare;

/** The whole comment, for the chip's tooltip: the quote or diff line, then the comment as Markdown. */
function CommentDetail({ c }: { c: ReviewComment }) {
   return (
      <ScrollArea className="max-h-80" viewportClassName="max-h-[inherit]">
         {c.kind === "quote" && c.label && <div className="text-muted-foreground">{c.label}</div>}
         {c.kind === "quote" ? (
            <div className="my-1 whitespace-pre-wrap border-l-2 pl-2 text-muted-foreground">
               {c.quote}
            </div>
         ) : (
            <>
               <div className="font-mono text-muted-foreground">
                  {c.path}:{c.line} ({c.side})
               </div>
               <pre className="my-1 overflow-hidden font-mono">{c.code}</pre>
            </>
         )}
         {c.text && (
            <Markdown
               breaks
               className="text-xs [--typeset-flow:0.5em] [--typeset-size:var(--text-xs)]"
            >
               {c.text}
            </Markdown>
         )}
      </ScrollArea>
   );
}

/** A review comment as a chip (prompt box and sent message); `onRemove`: show a remove button. */
export function CommentChip({
   comment: c,
   onRemove,
}: {
   comment: ReviewComment;
   onRemove?: () => void;
}) {
   const Icon = sourceIcon(c);
   return (
      <Tooltip className="max-w-96" content={<CommentDetail c={c} />}>
         <span
            className={cn(
               "flex max-w-full items-center gap-1 rounded-md border bg-muted py-0.5 pl-1.5 text-xs",
               onRemove ? "pr-0.5" : "pr-1.5",
            )}
         >
            <Icon className="size-3 shrink-0 text-muted-foreground" />
            {c.kind === "quote" ? (
               <>
                  {c.label && (
                     <span className="min-w-0 max-w-28 shrink-0 truncate text-muted-foreground">
                        {c.label}
                     </span>
                  )}
                  <span className="min-w-0 max-w-40 shrink-0 truncate text-muted-foreground">
                     “{c.quote}”
                  </span>
               </>
            ) : (
               <span className="shrink-0 font-mono text-muted-foreground">
                  {c.path.split("/").pop()}:{c.line}
               </span>
            )}
            {c.text && (
               <span className="min-w-0 max-w-64 truncate">
                  <InlineMarkdown>{c.text}</InlineMarkdown>
               </span>
            )}
            {onRemove && (
               <button
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  aria-label={
                     c.kind === "quote" ? "Remove comment" : `Remove comment on ${c.path}:${c.line}`
                  }
                  onClick={onRemove}
               >
                  <X className="size-3" />
               </button>
            )}
         </span>
      </Tooltip>
   );
}

/** Review comments as a row of chips; `onRemove`: they can be removed (the prompt box). */
export function CommentChips({
   comments,
   onRemove,
   className,
}: {
   comments: ReviewComment[];
   onRemove?: (id: string) => void;
   className?: string;
}) {
   return (
      <div className={cn("flex flex-wrap gap-1", className)} aria-label="Review comments">
         {comments.map((c) => (
            <CommentChip key={c.id} comment={c} onRemove={onRemove && (() => onRemove(c.id))} />
         ))}
      </div>
   );
}
