import {
   Trace,
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
import { memo, useContext, useMemo, useState } from "react";
import type { ToolGroupProps } from ".";
import { PlusMinus } from "./blocks";
import { StepBodyView } from "./bodies";
import type { ChatSubagent, Tool } from "./group";
import { useOpenStep } from "./openStep";
import { STEP_ICONS } from "./stepIcons";
import { stepView } from "./stepView";
import { ThoughtStep } from "./ThoughtStep";
import { WaitingForUser } from "./waiting";

/** Steps of a run, one line each (shadcn Trace); a step opens only on a click. */
export function TraceDisplay({ steps, subagents, active, streaming }: ToolGroupProps) {
   return (
      <Trace className="text-ui-step">
         {steps.map((s, i) =>
            s.type === "thought" ? (
               <ThoughtStep
                  key={s.id}
                  text={s.text}
                  streaming={!!streaming && i === steps.length - 1}
               />
            ) : (
               <Step
                  key={s.id}
                  tool={s}
                  subagent={subagents.get(s.id)}
                  subagents={subagents}
                  active={active}
               />
            ),
         )}
      </Trace>
   );
}

const Step = memo(function Step({
   tool,
   subagent,
   subagents,
   active,
}: {
   tool: Tool;
   subagent?: ChatSubagent;
   /** All subagents, for those a subagent started. */
   subagents: Map<string, ChatSubagent>;
   active: boolean;
}) {
   const [open, setOpen] = useState(false);
   useOpenStep(tool.id, () => setOpen(true));
   const waiting = useContext(WaitingForUser);
   const v = useMemo(
      () => stepView({ tool, subagent, active, waiting }),
      [tool, subagent, active, waiting],
   );
   const Icon = STEP_ICONS[v.icon];
   const line = (
      <TraceLine data-step={tool.id} status={v.lineStatus}>
         <TraceIcon>
            <Icon />
         </TraceIcon>
         <TraceTitle>
            <TraceVerb>{v.verb}</TraceVerb>
            {v.detail && <TraceDetail>{v.detail}</TraceDetail>}
            {v.hash && (
               <span className="shrink-0 rounded bg-muted px-1 text-ui-sm text-muted-foreground">
                  {v.hash}
               </span>
            )}
         </TraceTitle>
         {v.metas.map((m, i) => (
            <TraceDescription key={i}>
               {typeof m === "string" ? m : <PlusMinus add={m.add} del={m.del} />}
            </TraceDescription>
         ))}
      </TraceLine>
   );
   const body = v.body;
   if (body.kind === "none") return line;
   return (
      <TraceCollapsible data-step={tool.id} open={open} onOpenChange={setOpen}>
         <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
         <TraceCollapsibleContent className="space-y-2">
            <StepBodyView body={body} tool={tool} subagents={subagents} active={active} />
         </TraceCollapsibleContent>
      </TraceCollapsible>
   );
});
