import {
   cn,
   TraceCollapsible,
   TraceCollapsibleContent,
   TraceDescription,
   TraceIcon,
   TraceLine,
   TraceTitle,
   TraceVerb,
   WorkingLoader,
} from "@harness/ui";
import { ChevronRight, CircleDot } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { formatDuration } from "../../lib/time";
import { PermissionCard } from "../interaction/Permission";
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
 * A pending approval keeps it running ("Waiting for you"): its card is the last child, never faded.
 * A lone step (or a lone thought while running) shows as is.
 */
export function TraceGroup(props: ToolGroupProps) {
   const { steps, streaming, approvals = [], api } = props;
   const waiting = approvals.length > 0;
   const live = !!streaming || waiting;
   const summary = useMemo(() => groupSummary(steps), [steps]);
   const [expanded, setExpanded] = useState(false);
   // A jump to a step this group hides (e.g. from the Subagents panel) shows all steps first.
   const req = useContext(OpenStep);
   const targeted = !!req && steps.some((s) => req.path.includes(s.id));
   // biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce is a new request.
   useEffect(() => {
      if (targeted) setExpanded(true);
   }, [targeted, req?.nonce]);

   const calls = summary.calls + approvals.length;
   if (live ? calls < 1 : calls < 2) return <TraceDisplay {...props} />;

   // Running: older steps sit in their own collapsible above the last few, so "Show all" slides them in.
   const older = live ? steps.slice(0, Math.max(0, steps.length - VISIBLE_STEPS)) : [];
   const recent = live ? steps.slice(older.length) : steps;
   const open = live || expanded;
   const olderOpen = expanded && older.length > 0;
   const allShown = open && (older.length === 0 || olderOpen);
   const metas = live ? [plural(calls, "tool call")] : summary.parts;

   return (
      <TraceCollapsible data-slot="trace-group" open={open} className="text-ui-step">
         <button
            type="button"
            aria-expanded={allShown}
            onClick={() => setExpanded((e) => !e)}
            className="group/trace-trigger flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
         >
            <TraceLine status={live && !waiting ? "running" : undefined}>
               {waiting ? (
                  <TraceIcon className="text-amber-500">
                     <CircleDot />
                  </TraceIcon>
               ) : (
                  live && (
                     <TraceIcon>
                        <WorkingLoader />
                     </TraceIcon>
                  )
               )}
               <TraceTitle>
                  <TraceVerb className={waiting ? "text-amber-500" : undefined}>
                     {waiting
                        ? "Waiting for you"
                        : live
                          ? "Working"
                          : `Ran ${plural(summary.calls, "tool call")}`}
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
            {older.length > 0 && (
               <span className="ml-auto shrink-0 rounded-md border px-2 font-mono text-ui-sm text-muted-foreground in-[button:hover]:text-foreground">
                  {expanded ? `Show last ${VISIBLE_STEPS}` : `Show all · ${older.length} more`}
               </span>
            )}
         </button>
         <TraceCollapsibleContent
            className={cn(
               older.length > 0 &&
                  !olderOpen &&
                  "[mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]",
            )}
         >
            {older.length > 0 && (
               <TraceCollapsible open={olderOpen}>
                  <TraceCollapsibleContent className="mt-0 mb-0 ml-0 border-l-0 pr-0 pb-1.5 pl-0">
                     <TraceDisplay {...props} steps={older} streaming={false} />
                  </TraceCollapsibleContent>
               </TraceCollapsible>
            )}
            {recent.length > 0 && <TraceDisplay {...props} steps={recent} />}
            {api && approvals.length > 0 && (
               <div className={cn("flex flex-col gap-1.5", recent.length > 0 && "mt-1.5")}>
                  {approvals.map((a) => (
                     <PermissionCard key={a.id} item={a} api={api} />
                  ))}
               </div>
            )}
         </TraceCollapsibleContent>
      </TraceCollapsible>
   );
}
