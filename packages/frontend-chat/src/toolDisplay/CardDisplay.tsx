import { ToolCard } from "../ToolCard";
import { SubagentCard } from "../SubagentCard";
import type { ToolGroupProps } from ".";

/** One card per call (the original look). */
export function CardDisplay({ calls, subagents }: ToolGroupProps) {
  return (
    <div className="space-y-2">
      {calls.map((c) => {
        const s = subagents.get(c.id);
        return s ? <SubagentCard key={c.id} task={c} subagent={s} /> : <ToolCard key={c.id} tool={c} />;
      })}
    </div>
  );
}
