import { isOverdue, localDay } from "@harness/api";
import { Button, Calendar, cn, Popover, PopoverContent, PopoverTrigger } from "@harness/ui";
import { CalendarDays } from "lucide-react";
import { useState } from "react";
import { FIELD_CHIP } from "./chips";

/** A `YYYY-MM-DD` as a local Date (midnight). */
export function dayDate(day: string): Date {
   const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
   return new Date(y, m - 1, d);
}

/** `Mon, Nov 23` (with the year when it is not this year's). */
export function formatDue(day: string, today: string): string {
   const sameYear = day.slice(0, 4) === today.slice(0, 4);
   return dayDate(day).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
   });
}

/** Red when overdue, amber when due today (open tasks only). */
export function dueTone(due: string | null, today: string, open: boolean): string {
   if (!open || due === null) return "";
   if (isOverdue(due, today)) return "text-red-500 dark:text-red-400";
   if (due === today) return "text-amber-500 dark:text-amber-400";
   return "";
}

/** Picks a due date in a calendar; Clear removes it. */
export function DuePicker({
   due,
   open: taskOpen,
   onChange,
}: {
   due: string | null;
   /** The task is open (not done or cancelled): an overdue date shows red. */
   open: boolean;
   onChange: (due: string | null) => void;
}) {
   const [open, setOpen] = useState(false);
   const today = localDay();
   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger
            className={cn(FIELD_CHIP, due === null && "text-muted-foreground")}
            aria-label={due ? `Due ${due}` : "Set due date"}
         >
            <CalendarDays className={cn("size-3", dueTone(due, today, taskOpen))} />
            <span className={dueTone(due, today, taskOpen)}>
               {due ? formatDue(due, today) : "No date"}
            </span>
         </PopoverTrigger>
         <PopoverContent className="w-auto p-0">
            <Calendar
               mode="single"
               selected={due ? dayDate(due) : undefined}
               defaultMonth={due ? dayDate(due) : undefined}
               onSelect={(d) => {
                  setOpen(false);
                  const next = d ? localDay(d) : null;
                  if (next !== due) onChange(next);
               }}
            />
            {due && (
               <div className="border-t p-1">
                  <Button
                     variant="ghost"
                     size="sm"
                     className="w-full"
                     onClick={() => {
                        setOpen(false);
                        onChange(null);
                     }}
                  >
                     Clear
                  </Button>
               </div>
            )}
         </PopoverContent>
      </Popover>
   );
}
