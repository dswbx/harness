import { memo, useMemo, useState } from "react";
import {
  ArrowRightLeft, Bot, Brain, FilePen, FileText, Globe, Search, SquareTerminal, ToggleRight, Trash2, Wrench, XCircle,
} from "lucide-react";
import { subagentState, type Subagent } from "@harness/api";
import {
  Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle,
} from "@harness/ui";
import { Block, json, present } from "../ToolCard";
import { Markdown } from "../Markdown";
import { diffLines } from "../diff";
import type { Tool } from "./group";
import type { ToolGroupProps } from ".";

/** Steps of a run, one line each (shadcn Trace); the running step opens itself. */
export function TraceDisplay({ calls, subagents, active }: ToolGroupProps) {
  return (
    <Trace className="text-ui-sm">
      {calls.map((c) => <Step key={c.id} tool={c} subagent={subagents.get(c.id)} active={active} />)}
    </Trace>
  );
}

const KIND_ICONS: Record<string, typeof Wrench> = {
  read: FileText, edit: FilePen, delete: Trash2, move: ArrowRightLeft, search: Search,
  execute: SquareTerminal, think: Brain, fetch: Globe, switch_mode: ToggleRight,
};

/** `+3 -1` over the call's diffs. */
function diffStat(tool: Tool): string | null {
  let add = 0;
  let del = 0;
  for (const b of tool.content) {
    if (b.type !== "diff") continue;
    for (const l of diffLines(b.oldText as string | null, String(b.newText ?? ""))) {
      if (l.op === "+") add++;
      else if (l.op === "-") del++;
    }
  }
  return add || del ? `+${add} -${del}` : null;
}

const Step = memo(function Step({ tool, subagent, active }: { tool: Tool; subagent?: Subagent<Tool>; active: boolean }) {
  // Only a click is stored, so a live step opens and closes itself until the reader takes over.
  const [opened, setOpened] = useState<boolean | null>(null);
  const state = subagent ? subagentState(tool, subagent) : tool.status === "failed" ? "failed" : tool.status === "completed" ? "done" : active ? "running" : "pending";
  const stat = useMemo(() => diffStat(tool), [tool.content]);
  const Icon = subagent ? Bot : state === "failed" ? XCircle : KIND_ICONS[tool.kind ?? ""] ?? Wrench;
  const n = subagent?.calls.length ?? 0;
  const description = subagent ? (state === "running" && subagent.calls.at(-1) ? subagent.calls.at(-1)!.title : `${n} tool call${n === 1 ? "" : "s"}`) : state === "failed" ? "failed" : stat;
  const line = (
    <TraceLine status={state === "running" ? "running" : state === "failed" ? "error" : state === "pending" ? "pending" : undefined}>
      <TraceIcon><Icon /></TraceIcon>
      <TraceTitle className={tool.harnessTool ? undefined : "font-mono"}>
        {tool.harnessTool ? <>Harness · <span className="font-mono">{tool.harnessTool}</span></> : subagent ? <>Subagent · {tool.title}</> : tool.title}
      </TraceTitle>
      {description && <TraceDescription className="min-w-0 truncate">{description}</TraceDescription>}
    </TraceLine>
  );
  const hasBody = !!subagent || tool.content.length > 0 || present(tool.rawInput) || present(tool.rawOutput);
  if (!hasBody) return line;
  return (
    <TraceCollapsible open={opened ?? state === "running"} onOpenChange={setOpened}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="space-y-2">
        {subagent ? <SubagentBody task={tool} subagent={subagent} active={active} /> : <CallBody tool={tool} />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

function CallBody({ tool }: { tool: Tool }) {
  return (
    <>
      {tool.content.map((b, i) => <Block key={i} b={b} />)}
      {present(tool.rawInput) && <Raw label="Input" value={tool.rawInput} />}
      {present(tool.rawOutput) && <Raw label="Output" value={tool.rawOutput} />}
    </>
  );
}

function SubagentBody({ task, subagent, active }: { task: Tool; subagent: Subagent<Tool>; active: boolean }) {
  const prompt = (task.rawInput as { prompt?: unknown } | null)?.prompt;
  return (
    <>
      {typeof prompt === "string" && (
        <details>
          <summary className="cursor-pointer text-xs">Task</summary>
          <Markdown className="mt-1 rounded bg-muted p-2 text-xs">{prompt}</Markdown>
        </details>
      )}
      {subagent.calls.length > 0 && <TraceDisplay calls={subagent.calls} subagents={new Map()} active={active} />}
      {subagent.report != null && <Markdown className="rounded bg-muted p-2 text-foreground">{subagent.report}</Markdown>}
    </>
  );
}

function Raw({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary className="cursor-pointer text-xs">{label}</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs text-foreground">{json(value)}</pre>
    </details>
  );
}
