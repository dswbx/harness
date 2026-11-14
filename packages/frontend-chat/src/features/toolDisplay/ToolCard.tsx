import { Badge, cn } from "@harness/ui";
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, XCircle } from "lucide-react";
import { memo, useState } from "react";
import { Block } from "./blocks";
import type { Tool } from "./group";
import { json, present } from "./raw";

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
                     <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-code">
                        {json(tool.rawInput)}
                     </pre>
                  </details>
               )}
               {present(tool.rawOutput) && (
                  <details>
                     <summary className="cursor-pointer text-xs text-muted-foreground">
                        Output
                     </summary>
                     <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-code">
                        {json(tool.rawOutput)}
                     </pre>
                  </details>
               )}
            </div>
         )}
      </div>
   );
});
