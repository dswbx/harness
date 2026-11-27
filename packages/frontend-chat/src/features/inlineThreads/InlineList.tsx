import {
   Button,
   Collapsible,
   CollapsibleContent,
   CollapsibleTrigger,
   cn,
   ScrollArea,
} from "@harness/ui";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { plural } from "../../lib/plural";
import type { ChatState } from "../../state/reducer";
import { getDraft } from "../prompt/drafts";
import { composerKey } from "../review/reviewComments";
import { type InlineModel, type InlineThread, lastReply } from "./model";

/** The plain text of a saved composer draft (Lexical JSON): its text nodes, joined. */
function snapshotText(node: unknown): string {
   const n = node as { text?: unknown; children?: unknown; root?: unknown } | null;
   if (!n || typeof n !== "object") return "";
   if (typeof n.text === "string") return n.text;
   const kids = Array.isArray(n.children) ? n.children : n.root ? [n.root] : [];
   return kids
      .map(snapshotText)
      .filter((s) => s.trim())
      .join(" ");
}

/** The Thread's own messages (user and agent), for "N messages". */
const messageCount = (t: ChatState | null) =>
   t?.items.filter((i) => i.type === "user" || (i.type === "agent" && i.parent === null)).length ??
   0;

function Card({
   label,
   draft,
   quote,
   text,
   children,
}: {
   label: string;
   draft?: boolean;
   quote: string;
   text?: string;
   children: ReactNode;
}) {
   return (
      <li
         aria-label={label}
         className={cn(
            "flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2.5",
            draft && "border-dashed border-sky-500/40",
         )}
      >
         <p
            className={cn(
               "line-clamp-1 text-xs",
               draft ? "text-sky-600 dark:text-sky-300" : "text-amber-700 dark:text-amber-300",
            )}
         >
            “{quote}”
         </p>
         {text && <p className="line-clamp-2 text-ui-sm text-foreground/90">{text}</p>}
         <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
            {children}
         </div>
      </li>
   );
}

function RowAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
   return (
      <Button
         variant="ghost"
         size="sm"
         className="-mr-1.5 ml-auto h-6 px-1.5 text-xs text-muted-foreground"
         onClick={onClick}
      >
         {children}
      </Button>
   );
}

function ThreadState({ inline, t }: { inline: InlineModel; t: InlineThread }) {
   const status = inline.statusOf(t.id);
   const n = plural(messageCount(t.state), "message");
   if (status === "running")
      return (
         <span className="flex items-center gap-1.5 text-sky-600 dark:text-sky-300">
            <span className="size-[7px] animate-pulse rounded-full bg-sky-500" />
            Agent is replying
         </span>
      );
   if (status === "unread")
      return (
         <span className="flex items-center gap-1.5">
            <span className="size-[7px] rounded-full bg-orange-500" />
            Unread · {n}
         </span>
      );
   return <span>{n}</span>;
}

/**
 * The side chats panel's Inline tab (ADR 0030): drafts first, then the open Inline Threads, newest first, then
 * the resolved ones in a collapsed group. "Show in chat" scrolls to the quote and opens its popover.
 */
export function InlineList({ sessionId, inline }: { sessionId: string; inline: InlineModel }) {
   const drafts = Object.entries(inline.drafts);
   const open = inline.threads.filter((t) => !t.resolved);
   const resolved = inline.threads.filter((t) => t.resolved);
   return (
      <ScrollArea className="h-full">
         <div className="flex flex-col gap-2 p-3">
            {drafts.length + open.length > 0 && (
               <ul className="flex flex-col gap-2" aria-label="Inline threads">
                  {drafts.map(([id, d]) => {
                     const snap = getDraft(composerKey(sessionId, id));
                     const text = snap ? snapshotText(snap) : "";
                     const lost = inline.notFound.has(id);
                     return (
                        <Card key={id} label="Draft" draft quote={d.anchor.quote} text={text}>
                           <span>{lost ? "Draft · not found in chat" : "Draft"}</span>
                           {lost ? (
                              <RowAction onClick={() => inline.discard(id)}>Discard</RowAction>
                           ) : (
                              <RowAction onClick={() => inline.showInChat(id)}>
                                 Show in chat
                              </RowAction>
                           )}
                        </Card>
                     );
                  })}
                  {open.map((t) => (
                     <Card
                        key={t.id}
                        label="Inline thread"
                        quote={t.anchor.quote}
                        text={lastReply(t.state)}
                     >
                        {inline.notFound.has(t.id) ? (
                           <span>Not found in chat</span>
                        ) : (
                           <>
                              <ThreadState inline={inline} t={t} />
                              <RowAction onClick={() => inline.showInChat(t.id)}>
                                 Show in chat
                              </RowAction>
                           </>
                        )}
                     </Card>
                  ))}
               </ul>
            )}
            {resolved.length > 0 && (
               <Collapsible>
                  <CollapsibleTrigger className="group flex h-8 items-center gap-1.5 rounded-md px-1 text-ui-sm text-muted-foreground hover:text-foreground">
                     <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                     Resolved · {resolved.length}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                     <ul className="flex flex-col gap-2 pt-1" aria-label="Resolved inline threads">
                        {resolved.map((t) => (
                           <Card
                              key={t.id}
                              label="Resolved inline thread"
                              quote={t.anchor.quote}
                              text={lastReply(t.state)}
                           >
                              <span>Resolved</span>
                              <RowAction onClick={() => inline.resolve(t.id, false)}>
                                 Reopen
                              </RowAction>
                           </Card>
                        ))}
                     </ul>
                  </CollapsibleContent>
               </Collapsible>
            )}
         </div>
      </ScrollArea>
   );
}
