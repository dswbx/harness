import type { HarnessClient } from "@harness/api";
import { Input } from "@harness/ui";
import { useEffect, useState } from "react";
import { useReportError } from "../../platform/toast";
import { heading } from "./heading";

const DEFAULT = 4;
/** The core refuses more (`SubSessionSettings::MAX_RUNNING_LIMIT`). */
const MAX = 32;

/** Settings > Agents: how many Sub Sessions of one Session may run at a time (ADR 0026). */
export function SubSessionLimit({ client }: { client: HarnessClient }) {
   const report = useReportError();
   const [saved, setSaved] = useState<number | undefined>(undefined);
   const [text, setText] = useState("");
   useEffect(() => {
      client.getSubSessionSettings().then(
         (s) => {
            const n = s.max_running ?? DEFAULT;
            setSaved(n);
            setText(String(n));
         },
         (e) => report("Could not load the Sub Session limit", e),
      );
   }, [client, report]);
   const save = () => {
      const parsed = Number.parseInt(text, 10);
      const n = Number.isNaN(parsed) ? DEFAULT : Math.min(MAX, Math.max(0, parsed));
      setText(String(n));
      if (n === saved) return;
      const prev = saved;
      setSaved(n);
      client.setSubSessionSettings(n === DEFAULT ? null : { max_running: n }).catch((e) => {
         // The core never stored it: show what it still has.
         setSaved(prev);
         setText(String(prev ?? DEFAULT));
         report("Could not save the Sub Session limit", e);
      });
   };
   if (saved === undefined) return null;
   return (
      <section className="grid gap-2">
         <h3 className={heading}>Sub Sessions</h3>
         <label className="grid max-w-xs grid-cols-1 gap-1.5">
            <span className="text-muted-foreground">Most running at a time, per Session</span>
            <Input
               type="number"
               min={0}
               max={MAX}
               className="w-24"
               value={text}
               onChange={(e) => setText(e.target.value)}
               onBlur={save}
               onKeyDown={(e) => e.key === "Enter" && save()}
            />
         </label>
         <p className="max-w-lg text-xs text-muted-foreground">
            An Agent can start Sub Sessions, each with its own Agent process. This counts the Sub
            Sessions of one Session that are working or waiting for you. When it is reached, the
            Agent must wait for one to finish. 0 means no limit. Default {DEFAULT}, highest {MAX}.
         </p>
      </section>
   );
}
