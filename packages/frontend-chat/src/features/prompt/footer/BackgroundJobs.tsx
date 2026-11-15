import { Tooltip, WorkingLoader } from "@harness/ui";
import { useEffect, useState } from "react";
import { formatDuration } from "../../../lib/time";
import type { BackgroundJobInfo } from "../../../state/reducer";

/** "N background jobs running" and how long the oldest has run, above the box; the tooltip lists each job. */
export function BackgroundJobs({ jobs }: { jobs: readonly BackgroundJobInfo[] }) {
   const [now, setNow] = useState(Date.now);
   useEffect(() => {
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
   }, []);
   const oldest = Math.min(...jobs.map((j) => j.since));
   return (
      <Tooltip
         side="top"
         align="start"
         className="max-w-96"
         content={
            <ul className="space-y-0.5">
               {jobs.map((j) => (
                  <li key={j.id} className="flex gap-2">
                     <span className="min-w-0 flex-1 truncate font-mono">{j.label}</span>
                     <span className="shrink-0 tabular-nums">{formatDuration(now - j.since)}</span>
                  </li>
               ))}
            </ul>
         }
      >
         <div
            role="status"
            className="mb-2 flex w-fit items-center gap-1.5 px-5 text-xs text-muted-foreground"
         >
            <WorkingLoader />
            {jobs.length === 1
               ? "1 background job running"
               : `${jobs.length} background jobs running`}
            <span className="tabular-nums">{formatDuration(now - oldest)}</span>
         </div>
      </Tooltip>
   );
}
