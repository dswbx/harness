import type { PromptContext } from "@harness/api";
import { Tooltip } from "@harness/ui";
import { AppWindow, X } from "lucide-react";

/** What the user was looking at (Quick overlay): sent with the first message unless removed. */
export function ContextChip({ context }: { context: PromptContext }) {
   return (
      <div className="flex items-center gap-1.5 pb-2" aria-label="Window context">
         <Tooltip
            content={<span className="whitespace-pre-line">{context.detail ?? context.label}</span>}
            className="max-w-80"
         >
            <span className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-muted py-1 pl-1.5 pr-1 text-xs">
               <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
               <span className="truncate">{context.label}</span>
               {context.action && (
                  <button
                     type="button"
                     className="shrink-0 text-primary hover:underline"
                     onClick={context.action.onClick}
                  >
                     {context.action.label}
                  </button>
               )}
               <button
                  type="button"
                  className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Remove context"
                  onClick={context.onRemove}
               >
                  <X className="size-3" />
               </button>
            </span>
         </Tooltip>
      </div>
   );
}
