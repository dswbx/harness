import { dueCount, localDay, openCount, type TaskSummary } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import { ListTodo } from "lucide-react";

/**
 * The sidebar's row for All tasks (ADR 0028), between the Session list and the Shared Artifacts: how many
 * open tasks are due today or before ("2 due"), and how many are open.
 */
export function TasksEntry({
   tasks,
   selected,
   onOpen,
}: {
   /** null while loading. */
   tasks: readonly TaskSummary[] | null;
   selected: boolean;
   onOpen: () => void;
}) {
   const due = tasks ? dueCount(tasks, localDay()) : 0;
   return (
      <nav aria-label="Tasks" className="shrink-0 border-t px-2 py-1.5">
         <button
            type="button"
            onClick={onOpen}
            aria-current={selected || undefined}
            className={cn(
               "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground",
               selected && "bg-accent font-medium text-accent-foreground hover:bg-accent",
            )}
         >
            <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Tasks</span>
            {due > 0 && (
               <Tooltip content="Open tasks due today or before">
                  <span className="shrink-0 text-xs text-amber-600 tabular-nums dark:text-amber-400">
                     {due} due
                  </span>
               </Tooltip>
            )}
            {tasks && (
               <Tooltip content="Open tasks">
                  <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
                     {openCount(tasks)}
                  </span>
               </Tooltip>
            )}
         </button>
      </nav>
   );
}
