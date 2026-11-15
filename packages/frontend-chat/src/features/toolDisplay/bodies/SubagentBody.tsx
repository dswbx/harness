import { subagentState } from "@harness/api";
import { cn, TraceIcon, TraceLine, TraceTitle, TraceVerb } from "@harness/ui";
import { FileCheck } from "lucide-react";
import { useContext, useMemo } from "react";
import { Markdown } from "../../markdown/Markdown";
import { STEP_TEXT } from "../blocks";
import type { ChatSubagent, Step as StepItem, Tool } from "../group";
import { SubagentMeta } from "../SubagentMeta";
import { TraceDisplay } from "../TraceDisplay";
import { WaitingForUser } from "../waiting";
import { Fold } from "./Fold";

export function SubagentBody({
   task,
   subagent,
   subagents,
   active,
}: {
   task: Tool;
   subagent: ChatSubagent;
   subagents: Map<string, ChatSubagent>;
   active: boolean;
}) {
   const prompt = task.subagentPrompt;
   // Its steps in order: runs of tool calls and thoughts as a Trace, its own text between them.
   const runs = useMemo(() => {
      const out: (
         | { type: "steps"; steps: StepItem[] }
         | { type: "text"; id: string; text: string }
      )[] = [];
      for (const i of subagent.steps) {
         if (i.type === "tool" || i.type === "thought") {
            const last = out.at(-1);
            if (last?.type === "steps") last.steps.push(i);
            else out.push({ type: "steps", steps: [i] });
         } else if (i.type === "agent") out.push({ type: "text", id: i.id, text: i.text });
      }
      return out;
   }, [subagent.steps]);
   const waiting = useContext(WaitingForUser);
   const running = subagentState(task, subagent, active && !waiting) === "running";
   return (
      <>
         <SubagentMeta meta={task.subagentMeta} />
         {typeof prompt === "string" && (
            <Fold label="Task">
               <Markdown className={STEP_TEXT}>{prompt}</Markdown>
            </Fold>
         )}
         {runs.map((r, n) =>
            r.type === "steps" ? (
               <TraceDisplay
                  key={r.steps[0]!.id}
                  steps={r.steps}
                  subagents={subagents}
                  active={active}
                  streaming={running && n === runs.length - 1}
               />
            ) : (
               <Markdown key={r.id} className={cn(STEP_TEXT, "text-muted-foreground")}>
                  {r.text}
               </Markdown>
            ),
         )}
         {subagent.report != null && (
            <div className="flex flex-col gap-1.5">
               <TraceLine>
                  <TraceIcon>
                     <FileCheck />
                  </TraceIcon>
                  <TraceTitle>
                     <TraceVerb>Report</TraceVerb>
                  </TraceTitle>
               </TraceLine>
               <Markdown
                  className={cn(STEP_TEXT, "rounded-lg border bg-card px-3 py-2 text-foreground")}
               >
                  {subagent.report}
               </Markdown>
            </div>
         )}
      </>
   );
}
