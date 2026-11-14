import type { SubSessionToolSummary } from "@harness/api";
import { cn, TraceIcon, TraceLine, TraceTitle, TraceVerb } from "@harness/ui";
import { FileCheck } from "lucide-react";
import { useContext } from "react";
import { OpenSession } from "../../../lib/OpenSession";
import { Markdown } from "../../markdown/Markdown";
import { STEP_TEXT } from "../blocks";
import type { Tool } from "../group";
import { SUB_STATUS } from "../stepView";
import { CallBody } from "./CallBody";
import { Fold } from "./Fold";

/** A sub session call: its config, the prompt or message sent, a link to it, and (wait) its reply. */
export function SubSessionBody({
   tool,
   summary: s,
}: {
   tool: Tool;
   summary: SubSessionToolSummary;
}) {
   const open = useContext(OpenSession);
   const meta = [s.model, s.effort && `effort ${s.effort}`, s.branch].filter(Boolean);
   const sent = s.prompt ?? s.text;
   if (s.sessions)
      return (
         <>
            {s.sessions.length === 0 && (
               <div className="text-ui-sm text-muted-foreground">No sub sessions</div>
            )}
            {s.sessions.map((row) => (
               <div key={row.sessionId} className="flex items-baseline gap-2 text-ui-sm">
                  {open ? (
                     <button
                        type="button"
                        onClick={() => open(row.sessionId)}
                        className="truncate text-sky-600 hover:underline dark:text-sky-400"
                     >
                        {row.title}
                     </button>
                  ) : (
                     <span className="truncate">{row.title}</span>
                  )}
                  <span className="shrink-0 font-mono text-muted-foreground">
                     {[
                        row.repo,
                        row.status && row.status !== "idle" ? SUB_STATUS[row.status] : "idle",
                        row.archived && "archived",
                     ]
                        .filter(Boolean)
                        .join(" · ")}
                  </span>
               </div>
            ))}
            {s.error && <CallBody tool={tool} />}
         </>
      );
   return (
      <>
         {meta.length > 0 && (
            <div className="font-mono text-ui-sm text-muted-foreground">{meta.join(" · ")}</div>
         )}
         {sent && (
            <Fold label={tool.harnessTool === "session_send" ? "Message" : "Prompt"}>
               <Markdown className={STEP_TEXT}>{sent}</Markdown>
            </Fold>
         )}
         {s.reply && (
            <div className="flex flex-col gap-1.5">
               <TraceLine>
                  <TraceIcon>
                     <FileCheck />
                  </TraceIcon>
                  <TraceTitle>
                     <TraceVerb>Reply</TraceVerb>
                  </TraceTitle>
               </TraceLine>
               <Markdown
                  className={cn(STEP_TEXT, "rounded-lg border bg-card px-3 py-2 text-foreground")}
               >
                  {s.reply}
               </Markdown>
            </div>
         )}
         {s.error && <CallBody tool={tool} />}
         {open && s.sessionId && (
            <button
               type="button"
               onClick={() => open(s.sessionId!)}
               className="text-ui-sm text-sky-600 hover:underline dark:text-sky-400"
            >
               Open sub session
            </button>
         )}
      </>
   );
}
