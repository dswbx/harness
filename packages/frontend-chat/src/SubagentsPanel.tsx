import type { SubagentRow } from "@harness/api";
import { ScrollArea } from "@harness/ui";
import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PanelHeader } from "./PanelHeader";
import { formatDuration } from "./time";

/** Ticks every second while `on`, for live durations. */
function useSecondClock(on: boolean) {
   const [now, setNow] = useState(Date.now);
   useEffect(() => {
      if (!on) return;
      setNow(Date.now());
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
   }, [on]);
   return now;
}

/** The Session's subagents, running ones first. A click jumps to the subagent's step in the chat and opens it. */
export function SubagentsPanel({
   rows,
   onJump,
}: {
   rows: SubagentRow[];
   onJump: (id: string) => void;
}) {
   const now = useSecondClock(rows.some((r) => r.state === "running"));
   return (
      <div className="flex min-h-0 flex-1 flex-col">
         <PanelHeader title="Subagents">
            <span className="text-xs text-muted-foreground">{rows.length}</span>
         </PanelHeader>
         <ScrollArea className="min-h-0 flex-1">
            <div className="py-1">
               {rows.length === 0 && (
                  <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                     Subagents the Agent starts show here.
                  </p>
               )}
               {rows.map((r) => (
                  <Row key={r.id} r={r} now={now} onOpen={() => onJump(r.id)} />
               ))}
            </div>
         </ScrollArea>
      </div>
   );
}

function Row({ r, now, onOpen }: { r: SubagentRow; now: number; onOpen: () => void }) {
   const meta = [
      r.type,
      r.model && (r.modelInherited ? `${r.model} (inherited)` : r.model),
      r.effort && `effort ${r.effort}`,
      `${r.calls} call${r.calls === 1 ? "" : "s"}`,
   ].filter((p): p is string => !!p);
   const end = r.state === "running" ? now : r.endedAt;
   const duration = r.startedAt != null && end != null ? formatDuration(end - r.startedAt) : null;
   return (
      <button
         type="button"
         onClick={onOpen}
         className="flex w-full items-start gap-2.5 px-3.5 py-2 text-left hover:bg-muted"
      >
         <span className="grid h-5 shrink-0 place-items-center">
            {r.state === "running" ? (
               <Loader2
                  className="size-3.5 animate-spin text-muted-foreground"
                  aria-label="running"
               />
            ) : r.state === "failed" ? (
               <X className="size-3.5 text-destructive" aria-label="failed" />
            ) : (
               <Check className="size-3.5 text-emerald-500" aria-label="done" />
            )}
         </span>
         <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] leading-5 text-foreground">{r.title}</span>
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">
               {meta.join(" · ")}
            </span>
         </span>
         {duration && (
            <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums">
               {duration}
            </span>
         )}
      </button>
   );
}
