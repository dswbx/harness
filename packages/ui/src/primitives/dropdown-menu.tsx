import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";
import { InContextMenu } from "./menu-kind";
import { ScrollArea } from "./scroll-area";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * The Radix parts for where an item is: the context-menu ones inside a `ContextMenuContent`. So the item-level
 * `DropdownMenu*` parts (Item, Sub, Separator, Label, Checkbox, Switch, Group) also fill a context menu, and
 * one item list (a panel's menu) can show in its ⋮ menu and in its rail icon's context menu.
 */
const usePrimitive = (): typeof DropdownMenuPrimitive =>
   React.useContext(InContextMenu)
      ? (ContextMenuPrimitive as unknown as typeof DropdownMenuPrimitive)
      : DropdownMenuPrimitive;

function DropdownMenuGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
   const P = usePrimitive();
   return <P.Group {...props} />;
}

function DropdownMenuSub(props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
   const P = usePrimitive();
   return <P.Sub {...props} />;
}

const itemBase =
   "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const contentBase =
   "z-50 min-w-[8rem] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md";

/** Menu items scroll in a ScrollArea capped to the space left in the window. */
const Scroll = ({ children, context }: { children: React.ReactNode; context?: boolean }) => (
   <ScrollArea
      className={
         context
            ? "max-h-[var(--radix-context-menu-content-available-height)]"
            : "max-h-[var(--radix-dropdown-menu-content-available-height)]"
      }
      viewportClassName="max-h-[inherit] p-1"
   >
      <InContextMenu.Provider value={!!context}>{children}</InContextMenu.Provider>
   </ScrollArea>
);

function DropdownMenuContent({
   className,
   sideOffset = 6,
   children,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
   return (
      <DropdownMenuPrimitive.Portal>
         <DropdownMenuPrimitive.Content
            sideOffset={sideOffset}
            className={cn(contentBase, className)}
            {...props}
         >
            <Scroll>{children}</Scroll>
         </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
   );
}

function DropdownMenuSubContent({
   className,
   sideOffset = 4,
   children,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
   const context = React.useContext(InContextMenu);
   const P = usePrimitive();
   return (
      <P.Portal>
         <P.SubContent
            sideOffset={sideOffset}
            className={cn(contentBase, "shadow-lg", className)}
            {...props}
         >
            <Scroll context={context}>{children}</Scroll>
         </P.SubContent>
      </P.Portal>
   );
}

function DropdownMenuItem({
   className,
   inset,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
   const P = usePrimitive();
   return <P.Item className={cn(itemBase, inset && "pl-8", className)} {...props} />;
}

/**
 * A menu entry for content portaled into an open menu from outside its React tree (a Frontend filling the
 * host's gear menu), where `DropdownMenuItem` has no menu context. The host closes the menu on a click.
 */
function MenuButton({ className, ...props }: React.ComponentProps<"button">) {
   return (
      <button
         type="button"
         role="menuitem"
         data-menu-close
         className={cn(itemBase, "w-full", className)}
         {...props}
      />
   );
}

function DropdownMenuSubTrigger({
   className,
   inset,
   children,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
   const P = usePrimitive();
   return (
      <P.SubTrigger
         className={cn(itemBase, "data-[state=open]:bg-accent", inset && "pl-8", className)}
         {...props}
      >
         {children}
         <ChevronRight className="ml-auto size-4 text-muted-foreground" />
      </P.SubTrigger>
   );
}

function DropdownMenuCheckboxItem({
   className,
   children,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
   const P = usePrimitive();
   return (
      <P.CheckboxItem className={cn(itemBase, "pl-8", className)} {...props}>
         <span className="absolute left-2 flex size-4 items-center justify-center">
            <P.ItemIndicator>
               <Check className="size-4" />
            </P.ItemIndicator>
         </span>
         {children}
      </P.CheckboxItem>
   );
}

/** Checkbox item that shows an on/off switch on the right instead of a check mark. */
function DropdownMenuSwitchItem({
   className,
   children,
   checked,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
   const on = checked === true;
   const P = usePrimitive();
   return (
      <P.CheckboxItem checked={checked} className={cn(itemBase, className)} {...props}>
         {children}
         <Switch checked={on} className="ml-auto" />
      </P.CheckboxItem>
   );
}

/** Visual-only switch (no input). Use inside an element that handles the toggle. */
function Switch({ checked, className }: { checked: boolean; className?: string }) {
   return (
      <span
         aria-hidden
         data-state={checked ? "on" : "off"}
         className={cn(
            "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
            checked ? "bg-primary" : "bg-input",
            className,
         )}
      >
         <span
            className={cn(
               "size-3 rounded-full bg-background shadow transition-transform",
               checked && "translate-x-3",
            )}
         />
      </span>
   );
}

function DropdownMenuRadioItem({
   className,
   children,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
   return (
      <DropdownMenuPrimitive.RadioItem className={cn(itemBase, "pr-8", className)} {...props}>
         {children}
         <span className="absolute right-2 flex size-4 items-center justify-center">
            <DropdownMenuPrimitive.ItemIndicator>
               <Check className="size-4" />
            </DropdownMenuPrimitive.ItemIndicator>
         </span>
      </DropdownMenuPrimitive.RadioItem>
   );
}

/** Radio item with a dot on the left (shadcn default). */
function DropdownMenuRadioDotItem({
   className,
   children,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
   return (
      <DropdownMenuPrimitive.RadioItem className={cn(itemBase, "pl-8", className)} {...props}>
         <span className="absolute left-2 flex size-4 items-center justify-center">
            <DropdownMenuPrimitive.ItemIndicator>
               <Circle className="size-2 fill-current" />
            </DropdownMenuPrimitive.ItemIndicator>
         </span>
         {children}
      </DropdownMenuPrimitive.RadioItem>
   );
}

function DropdownMenuLabel({
   className,
   inset,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
   const P = usePrimitive();
   return (
      <P.Label
         className={cn(
            "px-2 py-1.5 text-xs font-medium text-muted-foreground",
            inset && "pl-8",
            className,
         )}
         {...props}
      />
   );
}

function DropdownMenuSeparator({
   className,
   ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
   const P = usePrimitive();
   return <P.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
   return (
      <span
         className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
         {...props}
      />
   );
}

export {
   DropdownMenu,
   DropdownMenuCheckboxItem,
   DropdownMenuContent,
   DropdownMenuGroup,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuPortal,
   DropdownMenuRadioDotItem,
   DropdownMenuRadioGroup,
   DropdownMenuRadioItem,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuSwitchItem,
   DropdownMenuTrigger,
   MenuButton,
   Switch,
};
