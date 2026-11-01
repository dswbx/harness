import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { ScrollBar } from "./scroll-area";

/**
 * shadcn Select (Radix). Items need a non-empty `value`: use a sentinel such as "all" for "no filter".
 * The list opens below the trigger, as wide as it at least, capped to the space left in the window,
 * and scrolls with the app's ScrollArea scrollbar.
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-sm whitespace-nowrap shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, position = "popper", sideOffset = 4, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "relative z-50 max-h-(--radix-select-content-available-height) min-w-[max(8rem,var(--radix-select-trigger-width))] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      >
        <ScrollAreaPrimitive.Root type="auto" className="relative max-h-[inherit] overflow-hidden">
          <SelectPrimitive.Viewport asChild>
            <ScrollAreaPrimitive.Viewport className="max-h-[inherit] p-1" style={{ overflowY: undefined }}>
              {children}
            </ScrollAreaPrimitive.Viewport>
          </SelectPrimitive.Viewport>
          <ScrollBar />
        </ScrollAreaPrimitive.Root>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />;
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
