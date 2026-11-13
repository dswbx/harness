import { subagentState } from "@harness/api";
import { cn } from "@harness/ui";
import { Bot, CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { useContext, useState } from "react";
import { Markdown } from "./Markdown";
import type { Item } from "./reducer";
import { ToolCard } from "./ToolCard";
import type { ChatSubagent } from "./toolDisplay/group";
import { SubagentMeta } from "./toolDisplay/SubagentMeta";
import { WaitingForUser } from "./toolDisplay/waiting";

type Tool = Extract<Item, { type: "tool" }>;

/** A Task call that started a subagent: its tool calls (collapsed) and its report. */
export function SubagentCard({
   task,
   subagent,
   active = true,
}: {
   task: Tool;
   subagent: ChatSubagent;
   /** The Turn runs (see `ToolGroupProps.active`). */
   active?: boolean;
}) {
   const [open, setOpen] = useState(false);
   const waiting = useContext(WaitingForUser);
   const state = subagentState(task, subagent, active && !waiting);
   const prompt = task.subagentPrompt;
   const n = subagent.calls.length;
   return (
      <div className="rounded-lg border bg-card text-card-foreground">
         <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
         >
            {state === "running" ? (
               <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-label="running"
               />
            ) : state === "failed" ? (
               <XCircle className="size-4 shrink-0 text-destructive" aria-label="failed" />
            ) : (
               <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-label="done" />
            )}
            <Bot className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
               <span className="text-muted-foreground">Subagent · </span>
               {task.title}
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
               {n} tool call{n === 1 ? "" : "s"}
            </span>
            <ChevronRight
               className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
               )}
            />
         </button>
         {open && (
            <div className="space-y-2 border-t px-3 py-2">
               <SubagentMeta meta={task.subagentMeta} className="text-xs" />
               {typeof prompt === "string" && (
                  <details>
                     <summary className="cursor-pointer text-xs text-muted-foreground">
                        Task
                     </summary>
                     <Markdown className="mt-1 rounded bg-muted p-2 text-xs">{prompt}</Markdown>
                  </details>
               )}
               {n > 0 && (
                  <div className="space-y-1.5 border-l-2 pl-3">
                     {subagent.calls.map((c) => (
                        <ToolCard key={c.id} tool={c} />
                     ))}
                  </div>
               )}
               {subagent.report != null && (
                  <div>
                     <div className="mb-1 text-xs text-muted-foreground">Report</div>
                     <Markdown className="rounded bg-muted p-2">{subagent.report}</Markdown>
                  </div>
               )}
            </div>
         )}
      </div>
   );
}
