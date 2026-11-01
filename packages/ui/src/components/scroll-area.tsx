import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "../lib/utils";

type Props = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
  scrollbarClassName?: string;
  /** E.g. `max-h-[inherit]` when the root has a max height instead of a height. */
  viewportClassName?: string;
};

/**
 * Vertical scrolling with the app's thin overlay scrollbar: use it for every scrolling panel, list, popover
 * and menu. Content is block (not Radix's `display: table`) so rows can truncate. For a max height
 * (popovers), put it on the root and pass `viewportClassName="max-h-[inherit]"`.
 */
function ScrollArea({ className, children, viewportRef, onViewportScroll, scrollbarClassName, viewportClassName, ...props }: Props) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} onScroll={onViewportScroll} className={cn("size-full rounded-[inherit] [&>div]:block!", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar className={scrollbarClassName} />
    </ScrollAreaPrimitive.Root>
  );
}
/** The app's thin vertical scrollbar, for a Radix ScrollArea root composed by hand (e.g. inside a Select). */
function ScrollBar({ className }: { className?: string }) {
  return (
    <ScrollAreaPrimitive.Scrollbar orientation="vertical" className={cn("flex w-2 touch-none select-none p-px transition-colors", className)}>
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
