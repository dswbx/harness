import { TASK_STATUS_LABEL, type TaskStatus } from "@harness/api";
import {
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from "@harness/ui";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { FIELD_CHIP } from "./chips";

/** In menu order. */
export const STATUSES: TaskStatus[] = [
   "backlog",
   "todo",
   "in_progress",
   "in_review",
   "blocked",
   "done",
   "cancelled",
];

export const STATUS_LABEL = TASK_STATUS_LABEL;

const STATUS_COLOR: Record<TaskStatus, string> = {
   backlog: "text-muted-foreground",
   todo: "text-muted-foreground",
   in_progress: "text-sky-500 dark:text-sky-400",
   in_review: "text-violet-500 dark:text-violet-400",
   blocked: "text-red-500 dark:text-red-400",
   done: "text-emerald-500 dark:text-emerald-400",
   cancelled: "text-muted-foreground",
};

/** The status as a small circle: dashed (backlog), empty, half, three quarters, a check, a dash, a cross. */
export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
   const ring = (
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
   );
   const shape: Record<TaskStatus, ReactNode> = {
      backlog: (
         <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="2 2"
         />
      ),
      todo: ring,
      in_progress: (
         <>
            {ring}
            <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />
         </>
      ),
      in_review: (
         <>
            {ring}
            <path d="M7 3.5 A3.5 3.5 0 1 1 3.5 7 L7 7 Z" fill="currentColor" />
         </>
      ),
      blocked: (
         <>
            {ring}
            <path d="M4.5 7h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
         </>
      ),
      done: (
         <>
            <circle cx="7" cy="7" r="6" fill="currentColor" />
            <path
               d="m4.3 7.2 1.8 1.8 3.6-3.8"
               fill="none"
               stroke="var(--background)"
               strokeWidth="1.6"
               strokeLinecap="round"
               strokeLinejoin="round"
            />
         </>
      ),
      cancelled: (
         <>
            {ring}
            <path
               d="m5 5 4 4m0-4-4 4"
               stroke="currentColor"
               strokeWidth="1.5"
               strokeLinecap="round"
            />
         </>
      ),
   };
   return (
      <svg
         viewBox="0 0 14 14"
         role="img"
         aria-label={STATUS_LABEL[status]}
         className={cn("size-3.5 shrink-0", STATUS_COLOR[status], className)}
      >
         {shape[status]}
      </svg>
   );
}

/**
 * Picks a status. `chip`: the icon and its name (the task detail); `icon`: the icon alone (a task row).
 */
export function StatusMenu({
   status,
   onChange,
   variant = "chip",
}: {
   status: TaskStatus;
   onChange: (status: TaskStatus) => void;
   variant?: "chip" | "icon";
}) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger
            className={
               variant === "chip"
                  ? FIELD_CHIP
                  : "grid size-5 shrink-0 place-items-center rounded outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
            }
            aria-label={`Status: ${STATUS_LABEL[status]}`}
         >
            <StatusIcon status={status} />
            {variant === "chip" && STATUS_LABEL[status]}
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-44">
            {STATUSES.map((s) => (
               <DropdownMenuItem key={s} onSelect={() => s !== status && onChange(s)}>
                  <StatusIcon status={s} />
                  {STATUS_LABEL[s]}
                  {s === status && <Check className="ml-auto" />}
               </DropdownMenuItem>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
