import { type SubSessionToolSummary, subagentState } from "@harness/api";
import {
   cn,
   Trace,
   TraceCollapsible,
   TraceCollapsibleContent,
   TraceCollapsibleTrigger,
   TraceDescription,
   TraceDetail,
   TraceIcon,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import {
   ArrowRightLeft,
   ArrowUpFromLine,
   Bot,
   Brain,
   CircleDot,
   FileCheck,
   FileDiff,
   FilePen,
   FileText,
   GitBranch,
   GitCommitHorizontal,
   GitFork,
   Globe,
   Plug,
   Search,
   SquareTerminal,
   ToggleRight,
   Trash2,
   Wrench,
   XCircle,
} from "lucide-react";
import { memo, type ReactNode, useContext, useMemo, useState } from "react";
import { diffLines } from "../diff";
import { Markdown } from "../Markdown";
import { OpenSession } from "../OpenSession";
import { Block, json, present, STEP_TEXT } from "../ToolCard";
import { formatDuration } from "../time";
import type { ToolGroupProps } from ".";
import { CodeFrame } from "./CodeFrame";
import type { ChatSubagent, Step as StepItem, Tool } from "./group";
import { gitSummary, type StepState, stepLabel, subSessionSummary } from "./label";
import { useOpenStep } from "./openStep";
import { SubagentMeta } from "./SubagentMeta";
import { ThoughtStep } from "./ThoughtStep";
import { WaitingForUser } from "./waiting";

/** Steps of a run, one line each (shadcn Trace); a step opens only on a click. */
export function TraceDisplay({ steps, subagents, active, streaming }: ToolGroupProps) {
   return (
      <Trace className="text-ui-step">
         {steps.map((s, i) =>
            s.type === "thought" ? (
               <ThoughtStep
                  key={s.id}
                  text={s.text}
                  streaming={!!streaming && i === steps.length - 1}
               />
            ) : (
               <Step
                  key={s.id}
                  tool={s}
                  subagent={subagents.get(s.id)}
                  subagents={subagents}
                  active={active}
               />
            ),
         )}
      </Trace>
   );
}

const KIND_ICONS: Record<string, typeof Wrench> = {
   read: FileText,
   edit: FilePen,
   delete: Trash2,
   move: ArrowRightLeft,
   search: Search,
   execute: SquareTerminal,
   think: Brain,
   fetch: Globe,
   switch_mode: ToggleRight,
};

const GIT_ICONS: Record<string, typeof Wrench> = {
   git_commit: GitCommitHorizontal,
   git_push: ArrowUpFromLine,
   git_status: CircleDot,
   git_diff: FileDiff,
   list_branches: GitBranch,
};

/** A sub session that is not idle when `session_wait` returned. */
const SUB_STATUS = { needs_attention: "needs attention", working: "still working" } as const;

const APPROVAL_META = {
   you: "allowed by you",
   rule: "allowed by rule",
   auto: "auto mode",
   denied: "denied",
} as const;

/** `+a -d`, green and red. */
function plusMinus(add: number, del: number) {
   return (
      <>
         <span className="text-emerald-500">+{add}</span>{" "}
         <span className="text-red-400">-{del}</span>
      </>
   );
}

/** `+3 -1` over the call's diffs. */
function diffStat(tool: Tool) {
   let add = 0;
   let del = 0;
   for (const b of tool.content) {
      if (b.type !== "diff") continue;
      for (const l of diffLines(b.oldText as string | null, String(b.newText ?? ""))) {
         if (l.op === "+") add++;
         else if (l.op === "-") del++;
      }
   }
   return add || del ? plusMinus(add, del) : null;
}

const Step = memo(function Step({
   tool,
   subagent,
   subagents,
   active,
}: {
   tool: Tool;
   subagent?: ChatSubagent;
   /** All subagents, for those a subagent started. */
   subagents: Map<string, ChatSubagent>;
   active: boolean;
}) {
   const [open, setOpen] = useState(false);
   useOpenStep(tool.id, () => setOpen(true));
   const waiting = useContext(WaitingForUser);
   const denied = !subagent && tool.approval === "denied";
   const state: StepState = subagent
      ? subagentState(tool, subagent, active && !waiting)
      : denied
        ? "pending"
        : tool.status === "failed"
          ? "failed"
          : tool.status === "completed"
            ? "done"
            : active
              ? "running"
              : "pending";
   const stat = useMemo(() => diffStat(tool), [tool.content]);
   const git = useMemo(
      () => (subagent ? null : gitSummary(tool)),
      [subagent, tool.harnessTool, tool.rawInput, tool.rawOutput, tool.content],
   );
   const sub = useMemo(() => (subagent ? null : subSessionSummary(tool)), [subagent, tool]);
   const Icon = subagent
      ? Bot
      : state === "failed"
        ? XCircle
        : tool.harnessTool && GIT_ICONS[tool.harnessTool]
          ? GIT_ICONS[tool.harnessTool]!
          : sub
            ? GitFork
            : tool.harnessTool || tool.title.startsWith("mcp__")
              ? Plug
              : (KIND_ICONS[tool.kind ?? ""] ?? Wrench);
   const { verb, detail } = stepLabel(tool, state, !!subagent);
   // Live count for a subagent (never its last call: a long one pushed the title out).
   const n = subagent?.calls.length ?? 0;
   const approval = tool.approval && !subagent ? APPROVAL_META[tool.approval] : null;
   const metas: ReactNode[] = subagent
      ? [`${n} tool call${n === 1 ? "" : "s"}`]
      : state === "failed"
        ? [git?.error ?? sub?.error ?? "failed"]
        : denied
          ? ["denied"]
          : state === "pending"
            ? ["stopped"]
            : [
                 git?.changed !== undefined && `${git.changed} changed`,
                 git?.count !== undefined && `${git.count} branch${git.count === 1 ? "" : "es"}`,
                 git?.additions !== undefined && plusMinus(git.additions, git.deletions ?? 0),
                 sub?.status && sub.status !== "idle" && SUB_STATUS[sub.status],
                 sub?.durationMs !== undefined && formatDuration(sub.durationMs),
                 stat,
                 approval,
              ];
   const line = (
      <TraceLine
         data-step={tool.id}
         status={
            state === "running"
               ? "running"
               : state === "failed"
                 ? "error"
                 : state === "pending"
                   ? "pending"
                   : undefined
         }
      >
         <TraceIcon>
            <Icon />
         </TraceIcon>
         <TraceTitle>
            <TraceVerb>{verb}</TraceVerb>
            {detail && <TraceDetail>{detail}</TraceDetail>}
            {git?.hash && (
               <span className="shrink-0 rounded bg-muted px-1 text-ui-sm text-muted-foreground">
                  {git.hash}
               </span>
            )}
         </TraceTitle>
         {metas.map((m, i) => m && <TraceDescription key={i}>{m}</TraceDescription>)}
      </TraceLine>
   );
   const message = tool.commitMessage ?? "";
   const hasBody =
      !!subagent ||
      !!message ||
      tool.content.length > 0 ||
      present(tool.rawInput) ||
      present(tool.rawOutput);
   if (!hasBody) return line;
   return (
      <TraceCollapsible data-step={tool.id} open={open} onOpenChange={setOpen}>
         <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
         <TraceCollapsibleContent className="space-y-2">
            {subagent ? (
               <SubagentBody
                  task={tool}
                  subagent={subagent}
                  subagents={subagents}
                  active={active}
               />
            ) : sub ? (
               <SubSessionBody tool={tool} summary={sub} />
            ) : message ? (
               <CodeFrame label="commit message" meta={git?.hash} code={message} />
            ) : (
               <CallBody tool={tool} />
            )}
         </TraceCollapsibleContent>
      </TraceCollapsible>
   );
});

function CallBody({ tool }: { tool: Tool }) {
   return (
      <>
         {tool.content.map((b, i) => (
            <Block key={i} b={b} tool={tool} />
         ))}
         {(present(tool.rawInput) || present(tool.rawOutput)) && (
            <div className="flex flex-col gap-1">
               {present(tool.rawInput) && (
                  <Fold label="Input">
                     <CodeFrame
                        label="input"
                        code={json(tool.rawInput)}
                        lang={typeof tool.rawInput === "string" ? "" : "json"}
                     />
                  </Fold>
               )}
               {present(tool.rawOutput) && (
                  <Fold label="Output">
                     <CodeFrame
                        label="output"
                        code={json(tool.rawOutput)}
                        lang={typeof tool.rawOutput === "string" ? "" : "json"}
                     />
                  </Fold>
               )}
            </div>
         )}
      </>
   );
}

function SubagentBody({
   task,
   subagent,
   subagents,
   active,
}: {
   task: Tool;
   subagent: ChatSubagent;
   subagents: Map<string, ChatSubagent>;
   active: boolean;
}) {
   const prompt = task.subagentPrompt;
   // Its steps in order: runs of tool calls and thoughts as a Trace, its own text between them.
   const runs = useMemo(() => {
      const out: (
         | { type: "steps"; steps: StepItem[] }
         | { type: "text"; id: string; text: string }
      )[] = [];
      for (const i of subagent.steps) {
         if (i.type === "tool" || i.type === "thought") {
            const last = out.at(-1);
            if (last?.type === "steps") last.steps.push(i);
            else out.push({ type: "steps", steps: [i] });
         } else if (i.type === "agent") out.push({ type: "text", id: i.id, text: i.text });
      }
      return out;
   }, [subagent.steps]);
   const waiting = useContext(WaitingForUser);
   const running = subagentState(task, subagent, active && !waiting) === "running";
   return (
      <>
         <SubagentMeta meta={task.subagentMeta} />
         {typeof prompt === "string" && (
            <Fold label="Task">
               <Markdown className={STEP_TEXT}>{prompt}</Markdown>
            </Fold>
         )}
         {runs.map((r, n) =>
            r.type === "steps" ? (
               <TraceDisplay
                  key={r.steps[0]!.id}
                  steps={r.steps}
                  subagents={subagents}
                  active={active}
                  streaming={running && n === runs.length - 1}
               />
            ) : (
               <Markdown key={r.id} className={cn(STEP_TEXT, "text-muted-foreground")}>
                  {r.text}
               </Markdown>
            ),
         )}
         {subagent.report != null && (
            <div className="flex flex-col gap-1.5">
               <TraceLine>
                  <TraceIcon>
                     <FileCheck />
                  </TraceIcon>
                  <TraceTitle>
                     <TraceVerb>Report</TraceVerb>
                  </TraceTitle>
               </TraceLine>
               <Markdown
                  className={cn(STEP_TEXT, "rounded-lg border bg-card px-3 py-2 text-foreground")}
               >
                  {subagent.report}
               </Markdown>
            </div>
         )}
      </>
   );
}

/** A sub session call: its config, the prompt or message sent, a link to it, and (wait) its reply. */
function SubSessionBody({ tool, summary: s }: { tool: Tool; summary: SubSessionToolSummary }) {
   const open = useContext(OpenSession);
   const meta = [s.model, s.effort && `effort ${s.effort}`, s.branch].filter(Boolean);
   const sent = s.prompt ?? s.text;
   return (
      <>
         {meta.length > 0 && (
            <div className="font-mono text-ui-sm text-muted-foreground">{meta.join(" · ")}</div>
         )}
         {sent && (
            <Fold label={tool.harnessTool === "session_send" ? "Message" : "Prompt"}>
               <Markdown className={STEP_TEXT}>{sent}</Markdown>
            </Fold>
         )}
         {s.reply && (
            <div className="flex flex-col gap-1.5">
               <TraceLine>
                  <TraceIcon>
                     <FileCheck />
                  </TraceIcon>
                  <TraceTitle>
                     <TraceVerb>Reply</TraceVerb>
                  </TraceTitle>
               </TraceLine>
               <Markdown
                  className={cn(STEP_TEXT, "rounded-lg border bg-card px-3 py-2 text-foreground")}
               >
                  {s.reply}
               </Markdown>
            </div>
         )}
         {s.error && <CallBody tool={tool} />}
         {open && s.sessionId && (
            <button
               type="button"
               onClick={() => open(s.sessionId!)}
               className="text-ui-sm text-sky-600 hover:underline dark:text-sky-400"
            >
               Open sub session
            </button>
         )}
      </>
   );
}

/** A secondary part of a step body (raw input, a subagent's task), one click away. */
function Fold({ label, children }: { label: string; children: ReactNode }) {
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
