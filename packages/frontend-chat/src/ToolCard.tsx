import { Badge, cn } from "@harness/ui";
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, XCircle } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { diffLines, langOf, splitPatch, unifiedPatch } from "./diff";
import { Markdown } from "./Markdown";
import { blockText, type ContentBlock, type Item } from "./reducer";
import { CodeFrame, Frame } from "./toolDisplay/CodeFrame";
import { parseFence } from "./toolDisplay/fence";

type Tool = Extract<Item, { type: "tool" }>;

export function StatusIcon({ status }: { status: string | null }) {
   if (status === "completed")
      return <CheckCircle2 className="size-4 text-emerald-500" aria-label="completed" />;
   if (status === "failed")
      return <XCircle className="size-4 text-destructive" aria-label="failed" />;
   if (status === "in_progress")
      return (
         <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="in progress" />
      );
   return (
      <CircleDashed className="size-4 text-muted-foreground" aria-label={status ?? "pending"} />
   );
}

export function Diff({
   path,
   oldText,
   newText,
}: {
   path: string;
   oldText?: string | null;
   newText: string;
}) {
   const file = useMemo(
      () => splitPatch(unifiedPatch(path, oldText, newText))[0],
      [path, oldText, newText],
   );
   const stat = useMemo(() => {
      let add = 0;
      let del = 0;
      for (const l of diffLines(oldText, newText)) l.op === "+" ? add++ : l.op === "-" && del++;
      return (
         <>
            <span className="text-emerald-500">+{add}</span>{" "}
            <span className="text-red-400">-{del}</span>
         </>
      );
   }, [oldText, newText]);
   return (
      <Frame label={path} meta={stat}>
         {file && <DiffViewer file={file} mode="unified" fontSize={11} wrap />}
      </Frame>
   );
}

/** One content block of a call. `tool` names the file a fenced Read output belongs to. */
export function Block({ b, tool }: { b: ContentBlock; tool?: Tool }) {
   if (b.type === "diff") {
      return (
         <Diff
            path={String(b.path)}
            oldText={b.oldText as string | null}
            newText={String(b.newText ?? "")}
         />
      );
   }
   if (b.type === "terminal") {
      return <div className="text-xs text-muted-foreground">Terminal {String(b.terminalId)}</div>;
   }
   const text = blockText(b);
   if (text != null) {
      const read = tool?.kind === "read";
      const fence = parseFence(text, read);
      if (!fence) return <Markdown className={STEP_TEXT}>{text}</Markdown>;
      const path = read ? readPath(tool) : null;
      const lines = fence.from != null ? `lines ${fence.from}–${fence.to}` : undefined;
      return (
         <CodeFrame
            label={path?.split("/").pop() ?? (fence.lang || "output")}
            meta={lines}
            code={fence.code}
            lang={fence.lang || (path ? langOf(path) : "")}
         />
      );
   }
   return (
      <pre className="overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(b, null, 2)}</pre>
   );
}

/** Prose in a step body (prompts, reports): the step size, not the chat's. */
export const STEP_TEXT = "[--typeset-size:calc(var(--chat-font-size,14px)*0.93)]";

const readPath = (t: Tool): string | null => {
   const loc = (t.locations as { path?: unknown }[] | null)?.[0]?.path;
   return typeof loc === "string" ? loc : (/^Read (.+)$/.exec(t.title)?.[1] ?? null);
};

export const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
/** null, `{}` and `[]` carry nothing worth showing. */
export const present = (v: unknown) =>
   v != null && !(typeof v === "object" && Object.keys(v).length === 0);

export const ToolCard = memo(function ToolCard({ tool }: { tool: Tool }) {
   const [open, setOpen] = useState(false);
   const hasBody = tool.content.length > 0 || present(tool.rawInput) || present(tool.rawOutput);
   const harness = tool.harnessTool;
   const diffs = tool.content.filter((b) => b.type === "diff");
   return (
      <div className="rounded-lg border bg-card text-card-foreground">
         <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
            onClick={() => hasBody && setOpen(!open)}
            aria-expanded={open}
         >
            <StatusIcon status={tool.status} />
            {harness ? (
               <span className="flex min-w-0 flex-1 items-center gap-2 truncate font-mono text-xs">
                  <span>
                     Harness · <span className="font-mono">{harness}</span>
                  </span>
                  <Badge variant="secondary">MCP</Badge>
               </span>
            ) : (
               <span className="min-w-0 flex-1 truncate font-mono text-xs">{tool.title}</span>
            )}
            {tool.kind && <span className="text-xs text-muted-foreground">{tool.kind}</span>}
            {hasBody && (
               <ChevronRight
                  className={cn(
                     "size-4 text-muted-foreground transition-transform",
                     open && "rotate-90",
                  )}
               />
            )}
         </button>
         {!open && diffs.length > 0 && (
            <div className="space-y-2 px-3 pb-3">
               {diffs.map((b, i) => (
                  <Block key={i} b={b} />
               ))}
            </div>
         )}
         {open && (
            <div className="space-y-2 border-t px-3 py-2">
               {tool.content.map((b, i) => (
                  <Block key={i} b={b} tool={tool} />
               ))}
               {present(tool.rawInput) && (
                  <details>
                     <summary className="cursor-pointer text-xs text-muted-foreground">
                        Input
                     </summary>
                     <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                        {json(tool.rawInput)}
                     </pre>
                  </details>
               )}
               {present(tool.rawOutput) && (
                  <details>
                     <summary className="cursor-pointer text-xs text-muted-foreground">
                        Output
                     </summary>
                     <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                        {json(tool.rawOutput)}
                     </pre>
                  </details>
               )}
            </div>
         )}
      </div>
   );
});
