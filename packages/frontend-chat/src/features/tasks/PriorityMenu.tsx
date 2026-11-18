import type { TaskPriority } from "@harness/api";
import {
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from "@harness/ui";
import { Check } from "lucide-react";
import { FIELD_CHIP } from "./chips";

/** In menu order. */
const PRIORITIES: TaskPriority[] = ["urgent", "high", "medium", "low", "none"];

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
   urgent: "Urgent",
   high: "High",
   medium: "Medium",
   low: "Low",
   none: "No priority",
};

const BARS: Record<TaskPriority, number> = { urgent: 3, high: 3, medium: 2, low: 1, none: 0 };

/** Three bars, as many lit as the priority is high; urgent is an orange square with "!"; none is a dash. */
export function PriorityIcon({
   priority,
   className,
}: {
   priority: TaskPriority;
   className?: string;
}) {
   const label = priority === "none" ? "No priority" : `${PRIORITY_LABEL[priority]} priority`;
   if (priority === "urgent")
      return (
         <svg
            viewBox="0 0 16 16"
            role="img"
            aria-label={label}
            className={cn("size-3.5 shrink-0 text-orange-500", className)}
         >
            <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
            <path
               d="M8 4.5v4.2M8 11.2v.3"
               stroke="var(--background)"
               strokeWidth="1.8"
               strokeLinecap="round"
            />
         </svg>
      );
   if (priority === "none")
      return (
         <svg
            viewBox="0 0 16 16"
            role="img"
            aria-label={label}
            className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
         >
            <path d="M3 8h2.5M6.75 8h2.5M10.5 8H13" stroke="currentColor" strokeWidth="1.5" />
         </svg>
      );
   const lit = BARS[priority];
   return (
      <svg
         viewBox="0 0 16 16"
         role="img"
         aria-label={label}
         className={cn("size-3.5 shrink-0 text-foreground/80", className)}
      >
         {[
            [2, 9, 5],
            [6.5, 6, 8],
            [11, 3, 11],
         ].map(([x, y, h], i) => (
            <rect
               key={x}
               x={x}
               y={y}
               width="3"
               height={h}
               rx="1"
               fill="currentColor"
               opacity={i < lit ? 1 : 0.25}
            />
         ))}
      </svg>
   );
}

/** Picks a priority, shown as a chip with the icon and its name. */
export function PriorityMenu({
   priority,
   onChange,
}: {
   priority: TaskPriority;
   onChange: (priority: TaskPriority) => void;
}) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger
            className={FIELD_CHIP}
            aria-label={`Priority: ${PRIORITY_LABEL[priority]}`}
         >
            <PriorityIcon priority={priority} />
            {PRIORITY_LABEL[priority]}
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-44">
            {PRIORITIES.map((p) => (
               <DropdownMenuItem key={p} onSelect={() => p !== priority && onChange(p)}>
                  <PriorityIcon priority={p} />
                  {PRIORITY_LABEL[p]}
                  {p === priority && <Check className="ml-auto" />}
               </DropdownMenuItem>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
