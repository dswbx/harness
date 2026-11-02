import { ToolCard } from "../ToolCard";
import { SubagentCard } from "../SubagentCard";
import type { ToolGroupProps } from ".";
import { ThoughtStep } from "./ThoughtStep";

/** One card per call (the original look). */
export function CardDisplay({ steps, subagents, streaming }: ToolGroupProps) {
  return (
    <div className="space-y-2">
      {steps.map((c, i) => {
        if (c.type === "thought") return <ThoughtStep key={c.id} text={c.text} streaming={!!streaming && i === steps.length - 1} />;
        const s = subagents.get(c.id);
        return s ? <SubagentCard key={c.id} task={c} subagent={s} /> : <ToolCard key={c.id} tool={c} />;
      })}
    </div>
  );
}
