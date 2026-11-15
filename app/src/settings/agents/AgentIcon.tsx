import { cn } from "@harness/ui";
import { useState } from "react";

export function AgentIcon({
   icon,
   name,
   className = "size-8",
}: {
   icon: string | null;
   name: string;
   className?: string;
}) {
   const [broken, setBroken] = useState(false);
   if (icon && !broken) {
      // Registry icons are monochrome SVGs drawn in black (currentColor doesn't reach an <img>): invert in dark mode.
      return (
         <img
            src={icon}
            alt=""
            className={cn(className, "shrink-0 rounded object-contain dark:invert")}
            onError={() => setBroken(true)}
         />
      );
   }
   return (
      <div
         className={cn(
            className,
            "grid shrink-0 place-items-center rounded bg-muted text-sm font-medium uppercase",
         )}
      >
         {name.slice(0, 1)}
      </div>
   );
}
