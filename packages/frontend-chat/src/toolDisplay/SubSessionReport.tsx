import type { SubSessionReport } from "@harness/api";
import {
   TraceCollapsible,
   TraceCollapsibleContent,
   TraceCollapsibleTrigger,
   TraceDescription,
   TraceDetail,
   TraceIcon,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import { BotMessageSquare } from "lucide-react";
import { useContext, useState } from "react";
import { Markdown } from "../Markdown";
import { OpenSession } from "../OpenSession";
import { STEP_TEXT } from "../ToolCard";
import { formatDuration } from "../time";
import { Fold } from "./TraceDisplay";

/** A collapsed line's taste of the reply: its first line, cut short. */
function preview(reply: string): string {
   const line = reply.trim().split("\n")[0]!.trim();
   return `"${line.length > 60 ? `${line.slice(0, 60)}…` : line}"`;
}

/**
 * What the Harness told the Agent about one Sub Session (its Turn ended, or it waits for the user),
 * as a trace step: collapsed, its title and a taste of the reply; open, where it came from, what
 * it was asked, and the reply.
 */
export function SubSessionReportStep({ report: r }: { report: SubSessionReport }) {
   const openSession = useContext(OpenSession);
   const waits = r.kind === "needs_user";
   const [open, setOpen] = useState(false);
   const stop = r.stop_reason && r.stop_reason !== "end_turn" ? r.stop_reason : null;
   const metas = waits
      ? ["waits for you"]
      : [
           stop,
           !r.reply && "no reply",
           !open && r.reply && preview(r.reply),
           r.duration_ms != null && formatDuration(r.duration_ms),
        ];
   return (
      <TraceCollapsible open={open} onOpenChange={setOpen}>
         <TraceCollapsibleTrigger>
            <TraceLine status={r.stop_reason === "error" ? "error" : undefined}>
               <TraceIcon>
                  <BotMessageSquare />
               </TraceIcon>
               <TraceTitle>
                  <TraceVerb>Message from sub session</TraceVerb>
                  <TraceDetail>{r.title}</TraceDetail>
               </TraceTitle>
               {metas.map(
                  (m, i) =>
                     m && (
                        <TraceDescription
                           key={i}
                           className={waits ? "text-amber-600 dark:text-amber-400" : undefined}
                        >
                           {m}
                        </TraceDescription>
                     ),
               )}
            </TraceLine>
         </TraceCollapsibleTrigger>
         <TraceCollapsibleContent className="space-y-3">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-sm">
               <span className="font-mono">From</span>
               {openSession ? (
                  <button
                     type="button"
                     onClick={() => openSession(r.session_id)}
                     className="truncate text-left text-sky-600 hover:underline dark:text-sky-400"
                  >
                     {r.title}
                  </button>
               ) : (
                  <span className="truncate text-foreground">{r.title}</span>
               )}
               <span className="font-mono">Status</span>
               <span className="text-foreground">
                  {waits
                     ? "waits for you to answer a permission request there"
                     : [
                          stop ? `stopped (${stop})` : "finished",
                          r.duration_ms != null && formatDuration(r.duration_ms),
                       ]
                          .filter(Boolean)
                          .join(" · ")}
               </span>
            </div>
            {r.asked && (
               <Fold label="Asked" defaultOpen>
                  <Markdown className={STEP_TEXT}>{r.asked}</Markdown>
               </Fold>
            )}
            {r.reply && (
               <Fold label="Reply" defaultOpen>
                  <Markdown className={`${STEP_TEXT} text-foreground`}>{r.reply}</Markdown>
               </Fold>
            )}
         </TraceCollapsibleContent>
      </TraceCollapsible>
   );
}
