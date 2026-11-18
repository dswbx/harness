import { cn, Popover, PopoverContent, PopoverTrigger } from "@harness/ui";
import { AlertTriangle, Info } from "lucide-react";
import { splitDetails } from "../../../lib/errors";
import type { Item } from "../../../state/reducer";
import { NoticeStep } from "../../toolDisplay/NoticeStep";

export function Notice({ item }: { item: Extract<Item, { type: "notice" }> }) {
   if (item.level === "error") {
      const { head, details } = splitDetails(item.text);
      return (
         <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
         >
            <div className="flex items-start gap-2">
               <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
               <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words">
                  {head}
               </span>
            </div>
            {details && (
               <details className="mt-1.5 pl-5">
                  <summary className="cursor-pointer select-none">Details</summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] text-foreground">
                     {details}
                  </pre>
               </details>
            )}
         </div>
      );
   }
   return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
         <div className="h-px flex-1 bg-border" />
         <span className="flex items-center gap-1 whitespace-pre-wrap text-center">
            {item.text}
            {item.info && (
               <Popover>
                  <PopoverTrigger asChild>
                     <button
                        type="button"
                        aria-label="About this notice"
                        className="grid size-4 place-items-center rounded hover:text-foreground"
                     >
                        <Info className="size-3.5" />
                     </button>
                  </PopoverTrigger>
                  <PopoverContent align="center" className="w-72 p-3 text-xs">
                     {item.info}
                  </PopoverContent>
               </Popover>
            )}
         </span>
         <div className="h-px flex-1 bg-border" />
      </div>
   );
}

export function AgentNotice({ item }: { item: Extract<Item, { type: "agent_notice" }> }) {
   if (item.severity === "info")
      return <NoticeStep title={item.title} description={item.description} />;
   const warn = item.severity === "warning" || item.severity === "error";
   const Icon = warn ? AlertTriangle : Info;
   return (
      <div
         role={item.severity === "error" ? "alert" : "note"}
         className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            item.severity === "error"
               ? "border-destructive/30 bg-destructive/5 text-destructive"
               : warn
                 ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                 : "bg-muted/40 text-muted-foreground",
         )}
      >
         <Icon className="mt-0.5 size-3.5 shrink-0" />
         <div className="min-w-0 flex-1 select-text">
            <div className="font-medium">{item.title}</div>
            {item.description && (
               <div className="mt-0.5 whitespace-pre-wrap break-words">{item.description}</div>
            )}
         </div>
      </div>
   );
}
