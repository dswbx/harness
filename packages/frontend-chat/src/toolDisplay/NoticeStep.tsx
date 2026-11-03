import {
   Trace,
   TraceCollapsible,
   TraceCollapsibleContent,
   TraceCollapsibleTrigger,
   TraceDetail,
   TraceIcon,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import { Zap } from "lucide-react";
import { useState } from "react";

/** `UserPromptSubmit says: text` (hook output) splits into who said it and what. */
const SAYS = /^(\S+) says:\s*([\s\S]*)$/;

/** An info notice from the Agent, shown like a tool call step: one line (who, then the text, truncated); the full text
 * opens on a click. */
export function NoticeStep({ title, description }: { title: string; description: string | null }) {
   const [open, setOpen] = useState(false);
   const m = SAYS.exec(title);
   const verb = m ? m[1]! : "Notice";
   const text = m ? m[2]! : title;
   return (
      <Trace className="text-ui-step">
         <TraceCollapsible open={open} onOpenChange={setOpen}>
            <TraceCollapsibleTrigger>
               <TraceLine>
                  <TraceIcon>
                     <Zap />
                  </TraceIcon>
                  <TraceTitle>
                     <TraceVerb>{verb}</TraceVerb>
                     {text && <TraceDetail>{text.split("\n")[0]}</TraceDetail>}
                  </TraceTitle>
               </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
               <div className="whitespace-pre-wrap">
                  {[text, description].filter(Boolean).join("\n\n")}
               </div>
            </TraceCollapsibleContent>
         </TraceCollapsible>
      </Trace>
   );
}
