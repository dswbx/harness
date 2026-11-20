import { type TaskDepKind, type TaskSummary, wouldLoop } from "@harness/api";
import {
   Command,
   CommandEmpty,
   CommandInput,
   CommandItem,
   CommandList,
   Popover,
   PopoverContent,
   PopoverTrigger,
   ToggleGroup,
   ToggleGroupItem,
   Tooltip,
} from "@harness/ui";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { sortTasks } from "./listModel";
import { StatusIcon } from "./StatusMenu";

/**
 * Adds a dependency to the task (ADR 0029): a + button that opens a search over all tasks, with "Link as" blocks
 * or follow-up. Tasks it already depends on are not listed; a task that would make a loop shows, disabled.
 * `tasks` must hold this task's current deps.
 */
export function DepPicker({
   taskId,
   tasks,
   onAdd,
}: {
   taskId: string;
   tasks: readonly TaskSummary[];
   onAdd: (id: string, kind: TaskDepKind) => void;
}) {
   const [open, setOpen] = useState(false);
   const [kind, setKind] = useState<TaskDepKind>("blocks");
   const items = useMemo(() => {
      if (!open) return [];
      const linked = new Set(tasks.find((t) => t.id === taskId)?.deps.map((d) => d.id));
      return sortTasks(tasks.filter((t) => t.id !== taskId && !linked.has(t.id))).map((t) => ({
         task: t,
         loop: wouldLoop(tasks, taskId, t.id),
      }));
   }, [open, tasks, taskId]);
   return (
      <Popover
         open={open}
         onOpenChange={(o) => {
            setOpen(o);
            if (o) setKind("blocks");
         }}
      >
         <Tooltip content="Add a dependency">
            <PopoverTrigger
               aria-label="Add dependency"
               className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
            >
               <Plus className="size-3.5" />
            </PopoverTrigger>
         </Tooltip>
         <PopoverContent
            align="end"
            className="w-80 p-0"
            onPointerDown={(e) => e.stopPropagation()}
         >
            <Command label="Search tasks">
               <CommandInput autoFocus placeholder="Wait on…" />
               <CommandList
                  label="Tasks"
                  className="max-h-[min(18rem,calc(var(--radix-popover-content-available-height,18rem)-5rem))]"
               >
                  <CommandEmpty>No tasks found.</CommandEmpty>
                  {items.map(({ task: t, loop }) => (
                     <CommandItem
                        key={t.id}
                        value={t.id}
                        keywords={[t.title]}
                        disabled={loop}
                        onSelect={() => {
                           setOpen(false);
                           onAdd(t.id, kind);
                        }}
                     >
                        <StatusIcon status={t.status} />
                        <span className="min-w-0 flex-1 truncate">
                           <InlineMarkdown variant="quiet">{t.title}</InlineMarkdown>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                           {t.id}
                           {loop && " · would make a loop"}
                        </span>
                     </CommandItem>
                  ))}
               </CommandList>
            </Command>
            <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
               Link as
               <ToggleGroup
                  type="single"
                  aria-label="Link as"
                  value={kind}
                  onValueChange={(v) => v && setKind(v as TaskDepKind)}
                  className="h-6"
               >
                  <ToggleGroupItem value="blocks" className="px-2">
                     blocks
                  </ToggleGroupItem>
                  <ToggleGroupItem value="follow_up" className="px-2">
                     follow-up
                  </ToggleGroupItem>
               </ToggleGroup>
            </div>
         </PopoverContent>
      </Popover>
   );
}
