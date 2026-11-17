import type { SessionApi } from "@harness/api";
import { cn, Dialog, DialogContent, DialogTitle, ScrollArea, Tooltip } from "@harness/ui";
import { Info } from "lucide-react";
import { useContext, useMemo, useState } from "react";
import { OpenSession } from "../../../lib/OpenSession";
import type { Item } from "../../../state/reducer";
import { Markdown } from "../../markdown/Markdown";
import { CommentChips } from "../../review/CommentChip";
import { parseReviewComments } from "../../review/reviewComments";
import { SubSessionReportStep } from "../../toolDisplay/SubSessionReport";
import { MessageFooter } from "../MessageFooter";
import { UserAttachments } from "./Attachments";

/** A sent prompt's bubble: its review comments as chips (like the prompt box), then the typed text. */
export function UserText({ text, fromSession }: { text: string; fromSession?: boolean }) {
   const p = useMemo(() => parseReviewComments(text), [text]);
   return (
      <div
         className={cn(
            "max-w-[80%] rounded-2xl border bg-card px-4.5 dark:border-transparent py-2.5 text-card-foreground",
            // Sent by another Session's Agent: a blue tint tells it apart from the user's own.
            fromSession && "border-sky-500/30 bg-sky-500/10 dark:border-sky-500/30",
         )}
      >
         {p.comments.length > 0 && (
            <CommentChips comments={p.comments} className={p.text ? "pb-1.5" : undefined} />
         )}
         {p.text && <Markdown breaks>{p.text}</Markdown>}
      </div>
   );
}

/** "from <Session>" above a prompt another Session's Agent sent: a link when the host can open Sessions. */
function FromSession({
   from,
}: {
   from: { sessionId: string; title: string; subSession: boolean };
}) {
   const open = useContext(OpenSession);
   const title = from.title || "another session";
   return (
      <div className="mb-1 text-ui-sm text-muted-foreground">
         {from.subSession ? "from sub session" : "from"}{" "}
         {open ? (
            <button
               type="button"
               onClick={() => open(from.sessionId)}
               className="text-sky-600 hover:underline dark:text-sky-400"
            >
               {title}
            </button>
         ) : (
            title
         )}
      </div>
   );
}

/** What the core sent the Agent before this message (`<harness_context>`), on request. */
function HarnessContext({ text }: { text: string }) {
   const [open, setOpen] = useState(false);
   const body = text.replace(/^<harness_context>\n?/, "").replace(/\n?<\/harness_context>$/, "");
   return (
      <>
         <Tooltip content="Context the Harness sent the Agent with this message">
            <button
               type="button"
               onClick={() => setOpen(true)}
               className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-accent-foreground"
            >
               <Info className="size-3.5" /> Harness context
            </button>
         </Tooltip>
         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-2xl">
               <DialogTitle>Harness context</DialogTitle>
               <p className="text-xs text-muted-foreground">
                  Sent to the Agent before this message, inside a {"<harness_context>"} block.
               </p>
               <ScrollArea
                  className="max-h-[60vh] rounded-md bg-muted"
                  viewportClassName="max-h-[inherit]"
               >
                  <Markdown className="p-3 text-sm">{body}</Markdown>
               </ScrollArea>
            </DialogContent>
         </Dialog>
      </>
   );
}

/** A user row: a prompt another Session's Agent sent, or the user's own, or the reports of Sub Sessions. */
export function UserMessage({
   item,
   api,
}: {
   item: Extract<Item, { type: "user" }>;
   api: SessionApi;
}) {
   if (item.from?.reports.length)
      return (
         <div className="flex flex-col gap-1.5">
            {item.from.reports.map((r, i) => (
               <SubSessionReportStep key={i} report={r} />
            ))}
         </div>
      );
   return (
      <div className="group flex flex-col items-end">
         {item.attachments.length > 0 && <UserAttachments api={api} items={item.attachments} />}
         {item.from && <FromSession from={item.from} />}
         {item.text && <UserText text={item.text} fromSession={!!item.from} />}
         <MessageFooter text={item.text} ts={item.ts} align="end">
            {item.context && <HarnessContext text={item.context} />}
         </MessageFooter>
      </div>
   );
}
