import {
   Trace,
   TraceCollapsible,
   TraceCollapsibleContent,
   TraceCollapsibleTrigger,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import { useState } from "react";

/** An info notice from the Agent, shown like a tool call step: one line, "Notice"; its text opens on a click. */
export function NoticeStep({ title, description }: { title: string; description: string | null }) {
   const [open, setOpen] = useState(false);
   return (
      <Trace className="text-ui-step">
         <TraceCollapsible open={open} onOpenChange={setOpen}>
            <TraceCollapsibleTrigger>
               <TraceLine>
                  <TraceTitle>
                     <TraceVerb>Notice</TraceVerb>
                  </TraceTitle>
               </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
               <div className="whitespace-pre-wrap">
                  {[title, description].filter(Boolean).join("\n\n")}
               </div>
            </TraceCollapsibleContent>
         </TraceCollapsible>
      </Trace>
   );
}
