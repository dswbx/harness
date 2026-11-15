import { Slot } from "@radix-ui/react-slot";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "../lib/utils";

/** Every tooltip waits this long before showing. */
const TOOLTIP_DELAY = 1000;

/**
 * One per React root. Shares open state across tooltips: after one has shown, moving to another
 * shows it at once (within `skipDelayDuration`), e.g. scanning sidebar rows.
 */
function TooltipProvider({ children }: { children: React.ReactNode; delay?: number }) {
   return (
      <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY} skipDelayDuration={400}>
         {children}
      </TooltipPrimitive.Provider>
   );
}

/**
 * Portal tooltip (Radix) on hover and keyboard focus. The child must accept a ref (it becomes the
 * trigger); a disabled button gets no pointer events, so its tooltip won't show. Other props (and
 * the ref) go to the trigger, so it can sit inside another `asChild` trigger, e.g.
 * `<DropdownMenuTrigger asChild><Tooltip …><Button /></Tooltip></DropdownMenuTrigger>`.
 * Hidden while its trigger is expanded (`aria-expanded`), i.e. while the menu or popover it opens
 * is showing. Use instead of `title`: native titles are slow, unstyled and unreliable in WebKit.
 */
function Tooltip({
   content,
   children,
   side = "top",
   align = "center",
   sideOffset = 6,
   shortcut,
   ref,
   open,
   className,
   ...trigger
}: {
   content: React.ReactNode;
   children: React.ReactElement;
   side?: "top" | "right" | "bottom" | "left";
   align?: "start" | "center" | "end";
   sideOffset?: number;
   /** Keys shown after the content, e.g. `["⌥", "↓"]`. */
   shortcut?: string[];
   /** Controlled: shown while true (e.g. the keyboard-highlighted item of a list), no hover handling. */
   open?: boolean;
   className?: string;
} & Omit<
   React.ComponentProps<typeof TooltipPrimitive.Trigger>,
   "content" | "children" | "className"
>) {
   const el = React.useRef<HTMLButtonElement | null>(null);
   const [shown, setShown] = React.useState(false);
   const setRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
         el.current = node;
         if (typeof ref === "function") ref(node);
         else if (ref) ref.current = node;
      },
      [ref],
   );
   if (!content)
      return (
         <Slot ref={ref} {...trigger}>
            {children}
         </Slot>
      );
   return (
      <TooltipPrimitive.Root
         open={open ?? shown}
         onOpenChange={(o) => setShown(o && el.current?.getAttribute("aria-expanded") !== "true")}
      >
         <TooltipPrimitive.Trigger
            asChild
            ref={setRef}
            {...trigger}
            // Capture: a menu trigger's own pointerdown calls preventDefault, which skips Radix's close.
            onPointerDownCapture={(e) => {
               trigger.onPointerDownCapture?.(e);
               setShown(false);
            }}
         >
            {children}
         </TooltipPrimitive.Trigger>
         <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
               side={side}
               align={align}
               sideOffset={sideOffset}
               collisionPadding={8}
               className={cn(
                  "z-50 max-w-72 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
                  shortcut && "flex items-center gap-2",
                  className,
               )}
            >
               {content}
               {shortcut && (
                  <span className="flex shrink-0 gap-0.5">
                     {shortcut.map((k) => (
                        <kbd
                           key={k}
                           className="min-w-5 rounded border bg-muted px-1 text-center font-sans text-[0.7rem] text-muted-foreground"
                        >
                           {k}
                        </kbd>
                     ))}
                  </span>
               )}
            </TooltipPrimitive.Content>
         </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
   );
}

export { Tooltip, TooltipProvider };
