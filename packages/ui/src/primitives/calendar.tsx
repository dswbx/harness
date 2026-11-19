import { ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import { cn } from "../lib/utils";
import { buttonVariants } from "./button";

/** A month calendar (shadcn, `react-day-picker`). Put it in a `PopoverContent` for a date picker. */
function Calendar({
   className,
   classNames,
   showOutsideDays = true,
   ...props
}: React.ComponentProps<typeof DayPicker>) {
   const d = getDefaultClassNames();
   const nav = cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-7 p-0");
   return (
      <DayPicker
         showOutsideDays={showOutsideDays}
         className={cn("p-2 text-sm", className)}
         classNames={{
            root: cn("w-fit", d.root),
            months: "relative flex flex-col gap-4",
            month: "flex w-full flex-col gap-2",
            nav: "absolute inset-x-0 top-0 flex items-center justify-between",
            button_previous: nav,
            button_next: nav,
            month_caption: "flex h-7 items-center justify-center",
            caption_label: "text-sm font-medium",
            month_grid: "w-full border-collapse",
            weekdays: "flex",
            weekday: "w-8 text-[0.75rem] font-normal text-muted-foreground",
            week: "mt-1 flex w-full",
            day: "relative size-8 p-0 text-center",
            day_button: cn(
               buttonVariants({ variant: "ghost" }),
               "size-8 p-0 font-normal aria-selected:opacity-100",
            ),
            today: "[&>button]:bg-accent [&>button]:text-accent-foreground",
            selected:
               "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button:hover]:bg-primary [&>button:hover]:text-primary-foreground",
            outside: "text-muted-foreground/50",
            disabled: "text-muted-foreground opacity-50",
            hidden: "invisible",
            ...classNames,
         }}
         components={{
            Chevron: ({ orientation }) =>
               orientation === "left" ? (
                  <ChevronLeft className="size-4" />
               ) : (
                  <ChevronRight className="size-4" />
               ),
         }}
         {...props}
      />
   );
}

export { Calendar };
