import { cn, Tooltip } from "@harness/ui";
import { FileCode } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AnsiText } from "../AnsiText";
import { DiffViewer } from "../DiffViewer";
import { splitPatch } from "../diff";
import { Markdown } from "../Markdown";
import { Diff as FileDiff } from "../ToolCard";
import type { UiNode } from "../tools";
import { PullRequest } from "../UiPullRequest";
import { type Renderers, useEnv } from "./runtime";

export * from "./code.spec";

/** Renderers of this group; its specs (schema, description, example) are in `code.spec.ts`. */
/** A workspace path that opens in the user's editor; plain text where nothing can open it. */
function OpenFile({
   path,
   line,
   label,
   className,
}: {
   path: string;
   line?: number;
   label?: string;
   className?: string;
}) {
   const env = useEnv();
   const [error, setError] = useState<string | null>(null);
   const text = label ?? `${path}${line ? `:${line}` : ""}`;
   if (!env.open) return <span className={cn("font-mono", className)}>{text}</span>;
   return (
      <Tooltip content={error ?? `Open ${path}${line ? ` at line ${line}` : ""} in your editor`}>
         <button
            type="button"
            onClick={() =>
               env.open!(path, line).then(
                  () => setError(null),
                  (e) => setError(e instanceof Error ? e.message : String(e)),
               )
            }
            className={cn(
               "inline-flex min-w-0 items-center gap-1 font-mono underline-offset-2 hover:underline",
               error ? "text-destructive" : "text-sky-600 dark:text-sky-400",
               className,
            )}
         >
            <span className="truncate">{text}</span>
         </button>
      </Tooltip>
   );
}

function DiffBlock({ node }: { node: Extract<UiNode, { type: "Diff" }> }) {
   const p = node.props;
   const files = useMemo(() => (p.patch ? splitPatch(p.patch) : []), [p.patch]);
   if (!p.patch) {
      return p.path && p.new != null ? (
         <div className="grid grid-cols-1 gap-1">
            <OpenFile path={p.path} className="w-fit text-ui-sm" />
            <FileDiff path={p.path} oldText={p.old ?? null} newText={p.new} />
         </div>
      ) : null;
   }
   return (
      <div className="grid grid-cols-1 gap-2">
         {files.map((f) => (
            <div key={f.path} className="overflow-hidden rounded border">
               <div className="flex gap-2 border-b bg-muted px-2 py-1 font-mono text-ui-sm text-muted-foreground">
                  <span className="flex min-w-0 flex-1">
                     <OpenFile path={f.path} />
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                  <span className="text-destructive">-{f.deletions}</span>
               </div>
               <DiffViewer file={f} mode="unified" wrap />
            </div>
         ))}
         {files.length === 0 && <Markdown>{"```diff\n" + p.patch + "\n```"}</Markdown>}
      </div>
   );
}

function LogBox({ node }: { node: Extract<UiNode, { type: "Log" }> }) {
   const [el, setEl] = useState<HTMLPreElement | null>(null);
   const text = String(node.props.text ?? "");
   // Starts at the end, like a terminal.
   useEffect(() => {
      if (el) el.scrollTop = el.scrollHeight;
   }, [el, text]);
   return (
      <div className="overflow-hidden rounded-md border">
         {node.props.title && (
            <div className="border-b bg-muted px-2 py-1 font-mono text-ui-sm text-muted-foreground">
               {node.props.title}
            </div>
         )}
         <pre
            ref={setEl}
            className="max-h-72 overflow-auto bg-muted/40 p-2 font-mono text-ui-sm leading-relaxed whitespace-pre-wrap break-words"
         >
            <AnsiText text={text} />
         </pre>
      </div>
   );
}

export const renderers = {
   Code: ({ node }) => {
      return (
         <Markdown>
            {"```" + (node.props.language ?? "") + "\n" + String(node.props.code ?? "") + "\n```"}
         </Markdown>
      );
   },
   Diff: ({ node }) => {
      return <DiffBlock node={node} />;
   },
   Log: ({ node }) => {
      return <LogBox node={node} />;
   },
   FileLink: ({ node }) => {
      return (
         <span className="inline-flex w-fit max-w-full items-center gap-1.5 text-ui">
            <FileCode className="size-4 shrink-0 text-muted-foreground" />
            <OpenFile path={node.props.path} line={node.props.line} label={node.props.label} />
         </span>
      );
   },
   PullRequest: ({ node }) => {
      return <PullRequest node={node} />;
   },
} satisfies Renderers;
