import type * as React from "react";
import { cn } from "../lib/utils";

/** Text fields take no spelling help: no autocorrect, autocapitalize, spellcheck or autofill. Inputs and textareas
 * here have it by default; spread it on any raw text field. */
export const noAutocorrect = {
   autoComplete: "off",
   autoCorrect: "off",
   autoCapitalize: "off",
   spellCheck: false,
} as const;

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
   return (
      <input
         type={type}
         {...noAutocorrect}
         className={cn(
            "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            className,
         )}
         {...props}
      />
   );
}

export { Input };
