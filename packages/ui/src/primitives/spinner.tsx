import { LoaderCircle } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";

/** shadcn Spinner. Spins smoothly via `.animate-spin` in styles.css (own compositing layer). */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
   return (
      <LoaderCircle
         role="status"
         aria-label="Loading"
         className={cn("size-4 animate-spin", className)}
         {...props}
      />
   );
}

export { Spinner };
