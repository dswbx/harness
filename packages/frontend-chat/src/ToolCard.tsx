import { memo, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, XCircle } from "lucide-react";
import { splitPatch, unifiedPatch } from "./diff";
import { DiffViewer } from "./DiffViewer";
import { Badge, cn } from "@harness/ui";
import { blockText, type ContentBlock, type Item } from "./reducer";

type Tool = Extract<Item, { type: "tool" }>;

export function StatusIcon({ status }: { status: string | null }) {
  if (status === "completed") return <CheckCircle2 className="size-4 text-emerald-500" aria-label="completed" />;
  if (status === "failed") return <XCircle className="size-4 text-destructive" aria-label="failed" />;
  if (status === "in_progress") return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="in progress" />;
  return <CircleDashed className="size-4 text-muted-foreground" aria-label={status ?? "pending"} />;
}

export function Diff({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const file = useMemo(() => splitPatch(unifiedPatch(path, oldText, newText))[0], [path, oldText, newText]);
  return (
    <div className="overflow-hidden rounded border">
      <div className="border-b bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{path}</div>
      {file && <DiffViewer file={file} mode="unified" fontSize={11} wrap />}
    </div>
  );
}

export function Block({ b }: { b: ContentBlock }) {
  if (b.type === "diff") {
    return <Diff path={String(b.path)} oldText={b.oldText as string | null} newText={String(b.newText ?? "")} />;
  }
  if (b.type === "terminal") {
    return <div className="text-xs text-muted-foreground">Terminal {String(b.terminalId)}</div>;
  }
  const text = blockText(b);
  if (text != null) return <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{text}</pre>;
  return <pre className="overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(b, null, 2)}</pre>;
}

export const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
/** null, `{}` and `[]` carry nothing worth showing. */
export const present = (v: unknown) => v != null && !(typeof v === "object" && Object.keys(v).length === 0);

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
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate text-xs">
            <span>Harness · <span className="font-mono">{harness}</span></span>
            <Badge variant="secondary">MCP</Badge>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{tool.title}</span>
        )}
        {tool.kind && <span className="text-xs text-muted-foreground">{tool.kind}</span>}
        {hasBody && <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />}
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
            <Block key={i} b={b} />
          ))}
          {present(tool.rawInput) && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Input</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{json(tool.rawInput)}</pre>
            </details>
          )}
          {present(tool.rawOutput) && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Output</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{json(tool.rawOutput)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});
