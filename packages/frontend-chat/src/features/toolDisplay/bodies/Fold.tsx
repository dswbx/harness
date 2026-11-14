import {
   TraceCollapsible,
   TraceCollapsibleContent,
   TraceCollapsibleTrigger,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import { type ReactNode, useState } from "react";

/** A secondary part of a step body (raw input, a subagent's task), one click away. */
export function Fold({ label, children }: { label: string; children: ReactNode }) {
   const [open, setOpen] = useState(false);
   return (
      <TraceCollapsible open={open} onOpenChange={setOpen}>
         <TraceCollapsibleTrigger className="text-ui-sm">
            <TraceLine>
               <TraceTitle>
                  <TraceVerb className="text-muted-foreground in-[button:hover]:text-foreground">
                     {label}
                  </TraceVerb>
               </TraceTitle>
            </TraceLine>
         </TraceCollapsibleTrigger>
         <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
      </TraceCollapsible>
   );
}
