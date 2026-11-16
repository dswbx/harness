import { WorkingLoader } from "@harness/ui";
import { CircleDot } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDuration } from "../../lib/time";

/** Always takes its height, so the layout doesn't shift as Turns start and end. */
export function Working({ since, waiting = false }: { since: number | null; waiting?: boolean }) {
   const [now, setNow] = useState(Date.now);
   useEffect(() => {
      if (since === null || waiting) return;
      setNow(Date.now());
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
   }, [since, waiting]);
   return (
      <div
         className="flex h-5 items-center gap-2 ml-0.5 text-sm text-muted-foreground"
         role="status"
      >
         {since !== null && waiting && (
            <>
               <CircleDot className="size-4 text-amber-500" /> Waiting for you
            </>
         )}
         {since !== null && !waiting && (
            <>
               <WorkingLoader />
               <span className="sr-only">Working</span>
               <span className="tabular-nums">{formatDuration(now - since)}</span>
            </>
         )}
      </div>
   );
}
