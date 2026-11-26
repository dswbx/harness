import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { InContextMenu } from "./menu-kind";
import { ScrollArea } from "./scroll-area";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.Sub;

const itemBase =
   "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const contentBase =
   "z-50 min-w-[8rem] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md";

function ContextMenuContent({
   className,
   children,
   ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
   return (
      <ContextMenuPrimitive.Portal>
         <ContextMenuPrimitive.Content className={cn(contentBase, className)} {...props}>
            <ScrollArea
               className="max-h-[var(--radix-context-menu-content-available-height)]"
               viewportClassName="max-h-[inherit] p-1"
            >
               <InContextMenu.Provider value={true}>{children}</InContextMenu.Provider>
            </ScrollArea>
         </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
   );
}

function ContextMenuSubContent({
   className,
   sideOffset = 4,
   children,
   ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
   return (
      <ContextMenuPrimitive.Portal>
         <ContextMenuPrimitive.SubContent
            sideOffset={sideOffset}
            className={cn(contentBase, "shadow-lg", className)}
            {...props}
         >
            <ScrollArea
               className="max-h-[var(--radix-context-menu-content-available-height)]"
               viewportClassName="max-h-[inherit] p-1"
            >
               <InContextMenu.Provider value={true}>{children}</InContextMenu.Provider>
            </ScrollArea>
         </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
   );
}

function ContextMenuSubTrigger({
   className,
   inset,
   children,
   ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }) {
   return (
      <ContextMenuPrimitive.SubTrigger
         className={cn(itemBase, "data-[state=open]:bg-accent", inset && "pl-8", className)}
         {...props}
      >
         {children}
         <ChevronRight className="ml-auto size-4 text-muted-foreground" />
      </ContextMenuPrimitive.SubTrigger>
   );
}

function ContextMenuItem({
   className,
   inset,
   ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean }) {
   return (
      <ContextMenuPrimitive.Item className={cn(itemBase, inset && "pl-8", className)} {...props} />
   );
}

function ContextMenuLabel({
   className,
   inset,
   ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
   return (
      <ContextMenuPrimitive.Label
         className={cn(
            "px-2 py-1.5 text-xs font-medium text-muted-foreground",
            inset && "pl-8",
            className,
         )}
         {...props}
      />
   );
}

function ContextMenuSeparator({
   className,
   ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
   return (
      <ContextMenuPrimitive.Separator
         className={cn("-mx-1 my-1 h-px bg-border", className)}
         {...props}
      />
   );
}

export {
   ContextMenu,
   ContextMenuContent,
   ContextMenuGroup,
   ContextMenuItem,
   ContextMenuLabel,
   ContextMenuSeparator,
   ContextMenuSub,
   ContextMenuSubContent,
   ContextMenuSubTrigger,
   ContextMenuTrigger,
};
