import { useState } from "react";
import { Brain } from "lucide-react";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle, TraceVerb } from "@harness/ui";
import { Markdown } from "../Markdown";

/** A thought, shown like a tool call step: "Thinking" shimmers while it streams, then "Thought"; the text opens on a click. */
export function ThoughtStep({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={streaming ? "running" : undefined}>
          <TraceIcon><Brain /></TraceIcon>
          <TraceTitle><TraceVerb>{streaming ? "Thinking" : "Thought"}</TraceVerb></TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown className="italic text-muted-foreground">{text}</Markdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
