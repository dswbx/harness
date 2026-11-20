import { propKeys, storedValue, type TaskSummary } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuLabel,
   DropdownMenuRadioGroup,
   DropdownMenuRadioItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from "@harness/ui";
import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { type GroupBy, groupProp, parseGroupBy } from "./listModel";

/** Group by a field, or a prop key (ADR 0029); the same for every view, All tasks and the panel graph. */
export const groupByStore = storedValue<GroupBy>({
   key: "harness.tasks.groupBy",
   scope: "app",
   parse: parseGroupBy,
   serialize: (v) => v,
});

const GROUP_FIELDS = { topic: "Topic", status: "Status", session: "Session" } as const;

/** The group-by menu: the fields, then the prop keys in use (and the one grouped by, also when unused now). */
export function GroupByMenu({
   value,
   tasks,
   disabled,
   prefix = "",
   className,
}: {
   value: GroupBy;
   /** The tasks whose prop keys the menu offers. */
   tasks: readonly Pick<TaskSummary, "props">[];
   disabled?: boolean;
   /** Before the value on the button, e.g. "Group: ". */
   prefix?: string;
   className?: string;
}) {
   const keys = useMemo(() => {
      const k = propKeys(tasks);
      const g = groupProp(value);
      return g === null || k.includes(g) ? k : [...k, g].sort();
   }, [tasks, value]);
   const label = groupProp(value) ?? GROUP_FIELDS[value as keyof typeof GROUP_FIELDS];
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
               size="sm"
               variant="outline"
               className={cn("h-7 max-w-64 data-[state=open]:bg-accent", className)}
            >
               <span className="truncate">
                  {prefix}
                  {label}
               </span>
               <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuRadioGroup
               value={value}
               onValueChange={(v) => groupByStore.set(parseGroupBy(v))}
            >
               <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Fields
               </DropdownMenuLabel>
               {(Object.keys(GROUP_FIELDS) as (keyof typeof GROUP_FIELDS)[]).map((g) => (
                  <DropdownMenuRadioItem key={g} value={g}>
                     {GROUP_FIELDS[g]}
                  </DropdownMenuRadioItem>
               ))}
               {keys.length > 0 && (
                  <>
                     <DropdownMenuSeparator />
                     <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                        Properties
                     </DropdownMenuLabel>
                  </>
               )}
               {keys.map((k) => (
                  <DropdownMenuRadioItem key={k} value={`prop:${k}`}>
                     <span className="truncate">{k}</span>
                  </DropdownMenuRadioItem>
               ))}
            </DropdownMenuRadioGroup>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
