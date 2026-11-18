import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";

/** A checkbox (shadcn). `checked="indeterminate"` shows a dash. */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
   return (
      <CheckboxPrimitive.Root
         className={cn(
            "peer grid size-4 shrink-0 place-items-center rounded-[4px] border border-input bg-background shadow-xs outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
            "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
            className,
         )}
         {...props}
      >
         <CheckboxPrimitive.Indicator className="grid place-items-center">
            {props.checked === "indeterminate" ? (
               <Minus className="size-3" strokeWidth={3} />
            ) : (
               <Check className="size-3" strokeWidth={3} />
            )}
         </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
   );
}

export { Checkbox };
