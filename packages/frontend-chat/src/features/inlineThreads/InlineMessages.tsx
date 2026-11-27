import type { SessionApi } from "@harness/api";
import { cn } from "@harness/ui";
import { useMemo } from "react";
import type { ChatState } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import { useRows } from "../conversation/MessageList";
import { Row } from "../conversation/Row";
import { Working } from "../conversation/Working";
import { PendingRow } from "../prompt/pending/PendingRow";
import { hasArrived, usePendingMessages } from "../prompt/pendingMessages";
import type { UiEnv } from "../renderUi/RenderUi";
import { composerKey, parseReviewComments, withReviewComments } from "../review/reviewComments";

/** A prompt without the Anchor's quote that leads the first one (the highlight shows it). */
function withoutQuote(text: string, quote: string): string {
   const p = parseReviewComments(text);
   const rest = p.comments.filter((c) => !(c.kind === "quote" && c.quote === quote && !c.text));
   return rest.length === p.comments.length ? text : withReviewComments(p.text, rest);
}

/**
 * An Inline Thread's messages in its popover, drawn like the chat (and the Quick overlay's chat): the same
 * `Row`s and pending rows, without the actions under agent messages. Short, so no virtual list.
 */
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
   const { ui, rows: all, subagents } = useRows(thread.items);
   const rows = useMemo(
      () =>
         all.map((r) => {
            if (r.type !== "user") return r;
            const text = withoutQuote(r.text, quote);
            return text === r.text ? r : { ...r, text };
         }),
      [all, quote],
   );
   const running = thread.turnId !== null;
   const userCount = useMemo(
      () => thread.items.filter((i) => i.type === "user").length,
      [thread.items],
   );
   const composer = composerKey(api.sessionId, threadId);
   const pending = usePendingMessages(composer)
      .filter((p) => !hasArrived(p, userCount))
      .map((p) => {
         const prompt = withoutQuote(p.prompt, quote);
         return prompt === p.prompt ? p : { ...p, prompt };
      });
   return (
      <div className="@container px-4 pt-3 pb-1">
         <div className="flex flex-col gap-6">
            {rows.map((row, i) => (
               <Row
                  key={row.id}
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
               />
            ))}
         </div>
         {/* A pending row keeps the space below it (as in the chat's list). */}
         {pending.length > 0 && (
            <div className={cn(rows.length > 0 && "mt-6")}>
               {pending.map((p) => (
                  <PendingRow key={p.id} item={p} state={thread} composer={composer} />
               ))}
            </div>
         )}
         {(running || pending.length > 0) && (
            <div className={cn(pending.length === 0 && rows.length > 0 && "mt-6")}>
               <Working since={thread.turnStartedAt} />
            </div>
         )}
      </div>
   );
}
