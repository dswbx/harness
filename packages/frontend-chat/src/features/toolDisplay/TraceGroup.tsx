import { cn, TraceDescription, TraceIcon, TraceLine, TraceTitle, TraceVerb } from "@harness/ui";
import { ChevronRight, CircleCheck, LoaderCircle } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { formatDuration } from "../../lib/time";
import type { ToolGroupProps } from ".";
import type { Step } from "./group";
import { OpenStep } from "./openStep";
import { TraceDisplay } from "./TraceDisplay";

/** Steps a running group shows before "Show all"; older ones fade out at the top. */
export const VISIBLE_STEPS = 4;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a finished group's header says: counts by kind, and how many failed. */
export function groupSummary(steps: Step[]): {
   calls: number;
   parts: string[];
   failed: number;
   /** From the first step's start to the last one's end. */
   durationMs: number | null;
} {
   let calls = 0;
   let commands = 0;
   let edits = 0;
   let reads = 0;
   let searches = 0;
   let failed = 0;
   let start = Number.POSITIVE_INFINITY;
   let end = 0;
   for (const s of steps) {
      if (s.ts) start = Math.min(start, s.ts);
      end = Math.max(end, s.ts ?? 0);
      if (s.type !== "tool") continue;
      if (s.endedAt) end = Math.max(end, s.endedAt);
      calls++;
      if (s.status === "failed") failed++;
      if (s.kind === "execute") commands++;
      else if (s.kind === "edit") edits++;
      else if (s.kind === "read") reads++;
      else if (s.kind === "search") searches++;
   }
   const parts = [
      commands && plural(commands, "command"),
      edits && plural(edits, "edit"),
      reads && plural(reads, "read"),
      searches && plural(searches, "search", "searches"),
   ].filter((p): p is string => !!p);
   const durationMs = end > start ? end - start : null;
   return { calls, parts, failed, durationMs };
}

/**
 * A run of tool calls under one header. While it runs (`streaming`): "Working", the last
 * `VISIBLE_STEPS` steps, older ones behind "Show all". Once done: one line, opens to all steps.
 * A lone step (or a lone thought while running) shows as is.
 */
export function TraceGroup(props: ToolGroupProps) {
   const { steps, streaming } = props;
   const live = !!streaming;
   const summary = useMemo(() => groupSummary(steps), [steps]);
   const [expanded, setExpanded] = useState(false);
   // A jump to a step this group hides (e.g. from the Subagents panel) shows all steps first.
   const req = useContext(OpenStep);
   const targeted = !!req && steps.some((s) => req.path.includes(s.id));
   // biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce is a new request.
   useEffect(() => {
      if (targeted) setExpanded(true);
   }, [targeted, req?.nonce]);

   if (live ? summary.calls < 1 : summary.calls < 2) return <TraceDisplay {...props} />;

   const hidden = live && !expanded ? Math.max(0, steps.length - VISIBLE_STEPS) : 0;
   const shown = live || expanded ? steps.slice(hidden) : [];
   const allShown = shown.length === steps.length;
   const metas = live ? [plural(summary.calls, "tool call")] : summary.parts;

   return (
      <div data-slot="trace-group" className="flex min-w-0 flex-col text-ui-step">
         <button
            type="button"
            aria-expanded={allShown}
            onClick={() => setExpanded((e) => !e)}
            className="group/trace-trigger flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
         >
            <TraceLine status={live ? "running" : undefined}>
               <TraceIcon>
                  {live ? (
                     <LoaderCircle className="animate-spin" />
                  ) : (
                     <CircleCheck className="text-emerald-500" />
                  )}
               </TraceIcon>
               <TraceTitle>
                  <TraceVerb>
                     {live ? "Working" : `Ran ${plural(summary.calls, "tool call")}`}
                  </TraceVerb>
               </TraceTitle>
               {metas.map((m) => (
                  <TraceDescription key={m}>{m}</TraceDescription>
               ))}
               {!live && summary.failed > 0 && (
                  <TraceDescription className="text-destructive">
                     {summary.failed} failed
                  </TraceDescription>
               )}
               {!live && summary.durationMs !== null && (
                  <TraceDescription>{formatDuration(summary.durationMs)}</TraceDescription>
               )}
            </TraceLine>
            <TraceIcon
               className={cn("text-muted-foreground transition-transform", allShown && "rotate-90")}
            >
               <ChevronRight />
            </TraceIcon>
            {live && steps.length > VISIBLE_STEPS && (
               <span className="ml-auto shrink-0 rounded-md border px-2 font-mono text-ui-sm text-muted-foreground in-[button:hover]:text-foreground">
                  {expanded ? `Show last ${VISIBLE_STEPS}` : `Show all · ${hidden} more`}
               </span>
            )}
         </button>
         {shown.length > 0 && (
            <div
               className={cn(
                  "mt-1.5 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-l pl-4",
                  hidden > 0 && "[mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]",
               )}
            >
               <TraceDisplay {...props} steps={shown} />
            </div>
         )}
      </div>
   );
}
