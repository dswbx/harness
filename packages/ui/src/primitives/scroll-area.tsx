import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type * as React from "react";
import { cn } from "../lib/utils";

type Props = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
   viewportRef?: React.Ref<HTMLDivElement>;
   onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
   scrollbarClassName?: string;
   /** E.g. `max-h-[inherit]` when the root has a max height instead of a height. */
   viewportClassName?: string;
   /** Also scroll sideways, with a thin bar at the bottom (wide content: the tasks tree). */
   horizontal?: boolean;
};

/**
 * Vertical scrolling with the app's thin overlay scrollbar: use it for every scrolling panel, list, popover
 * and menu. Content is block (not Radix's `display: table`) so rows can truncate. For a max height
 * (popovers), put it on the root and pass `viewportClassName="max-h-[inherit]"`.
 */
function ScrollArea({
   className,
   children,
   viewportRef,
   onViewportScroll,
   scrollbarClassName,
   viewportClassName,
   horizontal,
   ...props
}: Props) {
   return (
      <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
         <ScrollAreaPrimitive.Viewport
            ref={viewportRef}
            onScroll={onViewportScroll}
            className={cn("size-full rounded-[inherit] [&>div]:block!", viewportClassName)}
         >
            {children}
         </ScrollAreaPrimitive.Viewport>
         <ScrollBar className={scrollbarClassName} />
         {horizontal && <ScrollBar orientation="horizontal" className={scrollbarClassName} />}
      </ScrollAreaPrimitive.Root>
   );
}
/**
 * The app's thin scrollbar (vertical by default), for a Radix ScrollArea root composed by hand (e.g. inside a
 * Select). Fades in and out: Radix waits for the exit animation before it unmounts the bar (keyframes in
 * styles.css).
 */
function ScrollBar({
   className,
   orientation = "vertical",
}: {
   className?: string;
   orientation?: "vertical" | "horizontal";
}) {
   return (
      <ScrollAreaPrimitive.Scrollbar
         orientation={orientation}
         className={cn(
            "flex touch-none select-none p-px transition-colors",
            orientation === "vertical" ? "w-2" : "h-2 flex-col",
            "motion-safe:data-[state=visible]:animate-[scrollbar-in_150ms_ease-out] motion-safe:data-[state=hidden]:animate-[scrollbar-out_300ms_ease-in_forwards]",
            className,
         )}
      >
         <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
      </ScrollAreaPrimitive.Scrollbar>
   );
}

export { ScrollArea, ScrollBar };
