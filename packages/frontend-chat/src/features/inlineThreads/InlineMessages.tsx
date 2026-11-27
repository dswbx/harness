import type { SessionApi } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import { Sparkles, User } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { formatRelativeTime, fullMessageTime, useNow } from "../../lib/time";
import type { ChatState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import { useRows } from "../conversation/MessageList";
import { Row } from "../conversation/Row";
import { Working } from "../conversation/Working";
import { Markdown } from "../markdown/Markdown";
import { hasArrived, usePendingMessages } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { CommentChips } from "../review/CommentChip";
import { composerKey, parseReviewComments } from "../review/reviewComments";

/** Above each message: a small avatar, who wrote it, and when. */
function Header({ who, ts }: { who: "user" | "agent"; ts: number | null }) {
   const now = useNow();
   const Icon = who === "user" ? User : Sparkles;
   return (
      <div className="mb-1 flex items-center gap-1.5 text-xs">
         <span
            className={cn(
               "grid size-4 place-items-center rounded-full",
               who === "user" ? "bg-muted text-muted-foreground" : "bg-amber-500/20 text-amber-600",
            )}
         >
            <Icon className="size-2.5" />
         </span>
         <span className="font-medium">{who === "user" ? "You" : "Agent"}</span>
         {ts !== null && (
            <Tooltip content={fullMessageTime(ts)}>
               <time dateTime={new Date(ts).toISOString()} className="text-muted-foreground">
                  {formatRelativeTime(ts, now)}
               </time>
            </Tooltip>
         )}
      </div>
   );
}

/** A prompt as text, without the Anchor's quote that leads the first one (the highlight shows it). */
function PromptText({ text, quote }: { text: string; quote: string }) {
   const p = useMemo(() => parseReviewComments(text), [text]);
   const chips = p.comments.filter((c) => !(c.kind === "quote" && c.quote === quote && !c.text));
   return (
      <>
         {chips.length > 0 && <CommentChips comments={chips} className="pb-1.5" />}
         {p.text && <Markdown breaks>{p.text}</Markdown>}
      </>
   );
}

const Message = ({ children }: { children: ReactNode }) => (
   <div className="min-w-0 text-sm">{children}</div>
);

/** An Inline Thread's messages in its popover: full width, each with a header line. Short, so no virtual list. */
export function InlineMessages({
   api,
   thread,
   threadId,
   quote,
   env,
   onOpenDiff,
}: {
   api: SessionApi;
   thread: ChatState;
   threadId: string;
   quote: string;
   env: UiEnv;
   onOpenDiff: (s: DiffScope) => void;
}) {
   const { ui, rows, subagents } = useRows(thread.items);
   const running = thread.turnId !== null;
   const userCount = useMemo(
      () => thread.items.filter((i) => i.type === "user").length,
      [thread.items],
   );
   const pending = usePendingMessages(composerKey(api.sessionId, threadId)).filter(
      (p) => !hasArrived(p, userCount),
   );
   return (
      <div className="grid gap-4 px-4 pt-3 pb-1">
         {rows.map((row, i) => {
            if (row.type === "user")
               return (
                  <Message key={row.id}>
                     <Header who="user" ts={row.ts} />
                     <PromptText text={row.text} quote={quote} />
                  </Message>
               );
            return (
               <Message key={row.id}>
                  {row.type === "agent" && <Header who="agent" ts={row.ts} />}
                  <Row
                     item={row}
                     api={api}
                     env={env}
                     view={ui.inline.get(row.id)}
                     onOpenDiff={onOpenDiff}
                     subagents={subagents}
                     active={running}
                     streaming={running && i === rows.length - 1}
                     threadId={threadId}
                     side
                     footer={false}
                  />
               </Message>
            );
         })}
         {pending.map((p) => (
            <Message key={p.id}>
               <Header who="user" ts={null} />
               <div className={cn(p.status !== "failed" && "opacity-70")}>
                  <PromptText text={p.prompt} quote={quote} />
               </div>
               {p.status === "failed" && (
                  <p className="mt-1 text-xs text-destructive">
                     Not sent. Open it in side chats to retry.
                  </p>
               )}
            </Message>
         ))}
         {(running || pending.length > 0) && <Working since={thread.turnStartedAt} />}
      </div>
   );
}
