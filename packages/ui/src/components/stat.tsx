import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Separator } from "./separator";

/** Ported from diceui `stat` (https://diceui.com/docs/components/base/stat). */
function Stat({ className, ...props }: React.ComponentProps<"div">) {
   return (
      <div
         data-slot="stat"
         className={cn(
            "grid min-w-0 grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg border bg-card/50 p-4 text-card-foreground",
            "**:data-[slot=stat-description]:col-span-2 **:data-[slot=stat-indicator]:col-start-2 **:data-[slot=stat-indicator]:row-span-2 **:data-[slot=stat-indicator]:row-start-1 **:data-[slot=stat-indicator]:self-start **:data-[slot=stat-label]:col-span-1 **:data-[slot=stat-separator]:col-span-2 **:data-[slot=stat-trend]:col-span-2 **:data-[slot=stat-value]:col-span-1 **:data-[slot=stat-value]:col-start-1",
            className,
         )}
         {...props}
      />
   );
}

function StatLabel({ className, ...props }: React.ComponentProps<"div">) {
   return (
      <div
         data-slot="stat-label"
         className={cn("min-w-0 text-ui-sm font-medium text-muted-foreground", className)}
         {...props}
      />
   );
}

const statIndicatorVariants = cva(
   "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none",
   {
      variants: {
         variant: {
            default: "text-muted-foreground [&_svg:not([class*='size-'])]:size-5",
            icon: "size-8 rounded-lg border [&_svg:not([class*='size-'])]:size-4",
            badge: "h-6 min-w-6 rounded-full border px-2 text-ui-xs font-medium tabular-nums [&_svg:not([class*='size-'])]:size-3",
            action:
               "size-8 cursor-pointer rounded-lg transition-colors hover:bg-muted/50 [&_svg:not([class*='size-'])]:size-4",
         },
         color: {
            default: "border-border bg-muted text-muted-foreground",
            success:
               "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
            info: "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400",
            warning: "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400",
            error: "border-destructive/25 bg-destructive/10 text-destructive",
         },
      },
      defaultVariants: { variant: "default", color: "default" },
   },
);

interface StatIndicatorProps
   extends Omit<React.ComponentProps<"div">, "color">,
      VariantProps<typeof statIndicatorVariants> {}

function StatIndicator({
   className,
   variant = "default",
   color = "default",
   ...props
}: StatIndicatorProps) {
   return (
      <div
         data-slot="stat-indicator"
         data-variant={variant}
         data-color={color}
         className={cn(statIndicatorVariants({ variant, color, className }))}
         {...props}
      />
   );
}

function StatValue({ className, ...props }: React.ComponentProps<"div">) {
   return (
      <div
         data-slot="stat-value"
         className={cn("min-w-0 text-ui-xl font-semibold tracking-tight tabular-nums", className)}
         {...props}
      />
   );
}

function StatTrend({
   className,
   trend,
   ...props
}: React.ComponentProps<"div"> & { trend?: "up" | "down" | "neutral" }) {
   return (
      <div
         data-slot="stat-trend"
         data-trend={trend}
         className={cn(
            "inline-flex items-center gap-1 text-ui-sm font-medium [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            trend === "up" && "text-emerald-600 dark:text-emerald-400",
            trend === "down" && "text-red-600 dark:text-red-400",
            (trend === "neutral" || !trend) && "text-muted-foreground",
            className,
         )}
         {...props}
      />
   );
}

function StatSeparator(props: React.ComponentProps<typeof Separator>) {
   return <Separator data-slot="stat-separator" className="my-2" {...props} />;
}

function StatDescription({ className, ...props }: React.ComponentProps<"div">) {
   return (
      <div
         data-slot="stat-description"
         className={cn("text-ui-sm text-muted-foreground", className)}
         {...props}
      />
   );
}

export {
   Stat,
   StatDescription,
   StatIndicator,
   StatLabel,
   StatSeparator,
   StatTrend,
   StatValue,
   statIndicatorVariants,
};
