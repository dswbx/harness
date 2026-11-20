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

/** All tasks' group-by: a field, or a prop key (ADR 0029); the same for its List and Graph. */
export const groupByStore = storedValue<GroupBy>({
   key: "harness.tasks.groupBy",
   scope: "app",
   parse: parseGroupBy,
   serialize: (v) => v,
});

const GROUP_FIELDS = { status: "Status", topic: "Topic", session: "Session" } as const;

function Hint({ text }: { text: string | null | undefined }) {
   return text ? (
      <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{text}</span>
   ) : null;
}

/**
 * The group-by menu: the fields, then the prop keys in use (and the one grouped by, also when unused now). `hint`
 * gives an item a muted note on its right (e.g. "4 values").
 */
export function GroupByMenu({
   value,
   onChange,
   tasks,
   disabled,
   prefix = "",
   hint,
   className,
}: {
   value: GroupBy;
   onChange: (g: GroupBy) => void;
   /** The tasks whose prop keys the menu offers. */
   tasks: readonly Pick<TaskSummary, "props">[];
   disabled?: boolean;
   /** Before the value on the button, muted, e.g. "Group:". */
   prefix?: string;
   hint?: (g: GroupBy) => string | null;
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
                  {prefix && <span className="text-muted-foreground">{prefix} </span>}
                  {label}
               </span>
               <ChevronDown className="size-3 text-muted-foreground" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(parseGroupBy(v))}>
               <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Fields
               </DropdownMenuLabel>
               {(Object.keys(GROUP_FIELDS) as (keyof typeof GROUP_FIELDS)[]).map((g) => (
                  <DropdownMenuRadioItem key={g} value={g}>
                     {GROUP_FIELDS[g]}
                     <Hint text={hint?.(g)} />
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
                     <Hint text={hint?.(`prop:${k}`)} />
                  </DropdownMenuRadioItem>
               ))}
            </DropdownMenuRadioGroup>
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
