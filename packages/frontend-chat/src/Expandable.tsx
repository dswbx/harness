import { useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Tooltip, cn } from "@harness/ui";

/**
 * Content with an Expand button (on hover, in the chat column's right gutter) that opens it in a
 * near full-screen view. `expanded`: what that view shows; else `children` again, scrolling.
 */
export function Expandable({ label, children, expanded, className, ...data }: { label: string; children: ReactNode; expanded?: ReactNode; className?: string; [data: `data-${string}`]: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("group/expand relative", className)} {...data}>
      {children}
      <Tooltip content="Expand" side="right">
        <Button
          size="icon"
          variant="ghost"
          className="absolute -right-9 top-0 size-7 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/expand:opacity-100"
          aria-label={`Expand ${label}`}
          onClick={() => setOpen(true)}
        >
          <Maximize2 />
        </Button>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[90vh] max-w-[94vw] grid-rows-1 overflow-hidden p-0">
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <DialogDescription className="sr-only">Expanded view</DialogDescription>
          {expanded ?? <div className="min-h-0 overflow-auto p-8 pt-12">{children}</div>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
