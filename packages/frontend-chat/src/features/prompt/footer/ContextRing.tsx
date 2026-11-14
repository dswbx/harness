import { cn, Tooltip } from "@harness/ui";

/** Context window use as a ring; details on hover. */
export function ContextRing({ pct, used, size }: { pct: number; used: number; size: number }) {
   const r = 8;
   const c = 2 * Math.PI * r;
   const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
   return (
      <Tooltip
         side="top"
         align="end"
         className="w-56 max-w-56 p-3"
         content={
            <div className="flex flex-col gap-2">
               <div className="flex justify-between font-medium">
                  <span>Context window</span>
                  <span>{pct}%</span>
               </div>
               <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                     className={cn("h-full", pct > 85 ? "bg-destructive" : "bg-primary")}
                     style={{ width: `${pct}%` }}
                  />
               </div>
               <div className="grid grid-cols-[1fr_auto] gap-y-0.5 text-muted-foreground">
                  <span>Used</span>
                  <span className="tabular-nums">
                     {fmt(used)} / {fmt(size)} tokens
                  </span>
                  <span>Remaining</span>
                  <span className="tabular-nums">{fmt(Math.max(0, size - used))}</span>
               </div>
            </div>
         }
      >
         <button
            type="button"
            className="grid place-items-center rounded-full mr-1.5"
            aria-label={`Context window ${pct}% used`}
         >
            <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
               <circle
                  cx="10"
                  cy="10"
                  r={r}
                  fill="none"
                  strokeWidth="2.5"
                  className="stroke-muted-foreground/20"
               />
               <circle
                  cx="10"
                  cy="10"
                  r={r}
                  fill="none"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${(c * pct) / 100} ${c}`}
                  className={pct > 85 ? "stroke-destructive" : "stroke-muted-foreground"}
               />
            </svg>
         </button>
      </Tooltip>
   );
}
