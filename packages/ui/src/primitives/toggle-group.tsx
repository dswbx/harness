import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import type * as React from "react";
import { cn } from "../lib/utils";

/**
 * shadcn ToggleGroup (Radix), shaped as a pill segmented control: a muted track, the selected item lighter.
 * With `type="single"` Radix lets a click on the selected item clear the value: ignore empty values.
 */
function ToggleGroup({
   className,
   ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
   return (
      <ToggleGroupPrimitive.Root
         className={cn(
            "inline-flex h-[30px] items-center gap-0.5 rounded-full border bg-muted p-0.5",
            className,
         )}
         {...props}
      />
   );
}

function ToggleGroupItem({
   className,
   ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
   return (
      <ToggleGroupPrimitive.Item
         className={cn(
            "inline-flex h-full items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0",
            className,
         )}
         {...props}
      />
   );
}

export { ToggleGroup, ToggleGroupItem };
