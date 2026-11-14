import { cn } from "@harness/ui";
import { CheckCircle2, CircleDashed, Loader2 } from "lucide-react";
import type { ChatState } from "../../state/reducer";

/** The Agent's task list, above the messages. */
export function TaskListPanel({ entries }: { entries: ChatState["taskList"] }) {
   if (entries.length === 0) return null;
   const done = entries.filter((e) => e.status === "completed").length;
   return (
      <div className="border-b bg-muted/40 px-4 py-2 text-sm">
         <div className="mb-1 text-xs font-medium text-muted-foreground">
            Task List ({done}/{entries.length})
         </div>
         <ul className="space-y-0.5">
            {entries.map((t, i) => (
               <li
                  key={i}
                  className={cn(
                     "flex items-center gap-2",
                     t.status === "completed" && "text-muted-foreground line-through",
                  )}
               >
                  {t.status === "completed" ? (
                     <CheckCircle2 className="size-3.5 text-emerald-500" />
                  ) : t.status === "in_progress" ? (
                     <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                     <CircleDashed className="size-3.5 text-muted-foreground" />
                  )}
                  {t.content}
               </li>
            ))}
         </ul>
      </div>
   );
}
