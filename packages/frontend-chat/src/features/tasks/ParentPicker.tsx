import type { TaskSummary } from "@harness/api";
import {
   cn,
   noAutocorrect,
   Popover,
   PopoverContent,
   PopoverTrigger,
   ScrollArea,
} from "@harness/ui";
import { Check, CornerDownRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { InlineMarkdown } from "../markdown/InlineMarkdown";
import { FIELD_CHIP } from "./chips";
import { parentCandidates } from "./listModel";
import { StatusIcon } from "./StatusMenu";

/** Picks the task's parent from all tasks (not itself or one of its subtasks), or none. */
export function ParentPicker({
   taskId,
   parentId,
   tasks,
   onChange,
}: {
   taskId: string;
   parentId: string | null;
   tasks: readonly TaskSummary[];
   onChange: (parentId: string | null) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState("");
   const [active, setActive] = useState(0);
   const parent = tasks.find((t) => t.id === parentId) ?? null;
   const items = useMemo(() => {
      const q = query.trim().toLowerCase();
      const all = parentCandidates(tasks, taskId).filter(
         (t) => !q || t.title.toLowerCase().includes(q) || t.id === q,
      );
      return [null, ...all];
   }, [tasks, taskId, query]);
   const pick = (t: TaskSummary | null | undefined) => {
      if (t === undefined) return;
      setOpen(false);
      setQuery("");
      if ((t?.id ?? null) !== parentId) onChange(t?.id ?? null);
   };
   return (
      <Popover
         open={open}
         onOpenChange={(o) => {
            setOpen(o);
            setActive(0);
         }}
      >
         <PopoverTrigger
            className={cn(FIELD_CHIP, !parentId && "text-muted-foreground")}
            aria-label={parent ? `Parent: ${parent.title}` : "Set parent"}
         >
            <CornerDownRight className="size-3" />
            <span className="truncate">
               {parent ? (
                  <InlineMarkdown variant="quiet">{parent.title}</InlineMarkdown>
               ) : parentId ? (
                  parentId
               ) : (
                  "No parent"
               )}
            </span>
         </PopoverTrigger>
         <PopoverContent className="w-80 p-0" onPointerDown={(e) => e.stopPropagation()}>
            <label className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-muted-foreground">
               <Search className="size-3.5 shrink-0" />
               <input
                  {...noAutocorrect}
                  autoFocus
                  value={query}
                  onChange={(e) => {
                     setQuery(e.target.value);
                     setActive(0);
                  }}
                  onKeyDown={(e) => {
                     if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const d = e.key === "ArrowDown" ? 1 : -1;
                        setActive((i) => Math.max(0, Math.min(items.length - 1, i + d)));
                     } else if (e.key === "Enter") {
                        e.preventDefault();
                        pick(items[active]);
                     }
                  }}
                  placeholder="Move under…"
                  aria-label="Search tasks"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
               />
            </label>
            <ScrollArea
               className="max-h-[min(20rem,calc(var(--radix-popover-content-available-height)-2.5rem))]"
               viewportClassName="max-h-[inherit]"
            >
               <div className="p-1" role="listbox" aria-label="Parent tasks">
                  {items.map((t, i) => (
                     <div
                        key={t?.id ?? "none"}
                        role="option"
                        aria-selected={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => pick(t)}
                        className={cn(
                           "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] select-none",
                           i === active && "bg-accent",
                        )}
                     >
                        {t ? (
                           <StatusIcon status={t.status} />
                        ) : (
                           <span className="size-3.5 shrink-0" />
                        )}
                        <span
                           className={cn("min-w-0 flex-1 truncate", !t && "text-muted-foreground")}
                        >
                           {t ? (
                              <InlineMarkdown variant="quiet">{t.title}</InlineMarkdown>
                           ) : (
                              "No parent"
                           )}
                        </span>
                        {(t?.id ?? null) === parentId && (
                           <Check className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                     </div>
                  ))}
               </div>
            </ScrollArea>
         </PopoverContent>
      </Popover>
   );
}
