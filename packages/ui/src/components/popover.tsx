import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

/** Portal popover; `matchTrigger` makes it as wide as its trigger (combobox lists). */
function PopoverContent({
  className, sideOffset = 6, align = "start", matchTrigger, style, ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { matchTrigger?: boolean }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          "z-50 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
          className,
        )}
        style={matchTrigger ? { width: "var(--radix-popover-trigger-width)", ...style } : style}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
