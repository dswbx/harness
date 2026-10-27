import * as React from "react";
import { cn } from "../lib/utils";

/**
 * Hover/focus tooltip in pure CSS (no portal): shown above the trigger after a short delay.
 * Native `title` is unreliable in WebKit on form controls, so use this for anything that needs
 * explaining.
 */
function Tooltip({
  content,
  children,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("group/tooltip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-max max-w-72 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground opacity-0 shadow-md transition-opacity group-focus-within/tooltip:opacity-100 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-300"
      >
        {content}
      </span>
    </span>
  );
}
export { Tooltip };
