import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { ScrollArea } from "./scroll-area";

/** shadcn Command (cmdk): a search box over a list of items, keyboard first. Put it in a Popover for a picker. */
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
   return (
      <CommandPrimitive
         className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-[inherit] bg-popover text-popover-foreground",
            className,
         )}
         {...props}
      />
   );
}

function CommandInput({
   className,
   ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
   return (
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-muted-foreground">
         <Search className="size-3.5 shrink-0" />
         <CommandPrimitive.Input
            className={cn(
               "min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
               className,
            )}
            {...props}
         />
      </div>
   );
}

/**
 * The items, in a ScrollArea. Its max height is `className` (default: 20rem, capped to the space a popover has
 * left in the window).
 */
function CommandList({
   className,
   children,
   ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
   return (
      <ScrollArea
         className={cn(
            "max-h-[min(20rem,calc(var(--radix-popover-content-available-height,20rem)-2.5rem))]",
            className,
         )}
         viewportClassName="max-h-[inherit]"
      >
         <CommandPrimitive.List className="p-1" {...props}>
            {children}
         </CommandPrimitive.List>
      </ScrollArea>
   );
}

function CommandEmpty({
   className,
   ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
   return (
      <CommandPrimitive.Empty
         className={cn("py-4 text-center text-xs text-muted-foreground", className)}
         {...props}
      />
   );
}

function CommandGroup({
   className,
   ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
   return (
      <CommandPrimitive.Group
         className={cn(
            "overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground",
            className,
         )}
         {...props}
      />
   );
}

function CommandSeparator({
   className,
   ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
   return (
      <CommandPrimitive.Separator
         className={cn("-mx-1 my-1 h-px bg-border", className)}
         {...props}
      />
   );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
   return (
      <CommandPrimitive.Item
         className={cn(
            "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className,
         )}
         {...props}
      />
   );
}

export {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
   CommandSeparator,
};
