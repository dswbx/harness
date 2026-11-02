import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

/** Steps of a run, one line each, optionally expandable. From shadcn `trace` (base-nova), on Radix Collapsible. */
function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="trace" className={cn("flex w-full min-w-0 flex-col gap-1.5", className)} {...props} />;
}

/** One shimmer loop, as in `styles.css`. */
const SHIMMER_MS = 2400;

function TraceLine({ className, status, ...props }: React.ComponentProps<"span"> & { status?: "running" | "error" | "pending" }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  // Phase the shimmer on the page clock, not on when this element got it: a line that remounts
  // (virtual list, regrouping, a body arriving) or flips back to running keeps the band where it was.
  React.useLayoutEffect(() => {
    if (status === "running") ref.current?.style.setProperty("--shimmer-delay", `${-(performance.now() % SHIMMER_MS)}ms`);
  }, [status]);
  return (
    <span
      ref={ref}
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 text-muted-foreground transition-colors in-[button:hover]:text-foreground data-[status=error]:text-destructive data-[status=pending]:opacity-60 data-[status=running]:**:data-[slot=trace-verb]:shimmer",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5", className)}
      {...props}
    />
  );
}

/** Mono; holds a verb and a detail. The verb shimmers while running; the detail truncates first. */
function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cn("flex min-w-0 items-baseline gap-2 font-mono", className)} {...props} />;
}

function TraceVerb({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-verb" className={cn("shrink-0 text-foreground/80 in-[button:hover]:text-foreground in-data-[status=error]:text-destructive", className)} {...props} />;
}

function TraceDetail({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-detail" className={cn("min-w-0 truncate text-muted-foreground/70", className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cn("shrink-0 font-mono text-muted-foreground/70 tabular-nums before:mr-2 before:content-['·']", className)} {...props} />;
}

function TraceCollapsible({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="trace-collapsible" className={cn("flex w-full min-w-0 flex-col", className)} {...props} />;
}

function TraceCollapsibleTrigger({ className, children, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform group-data-[state=open]/trace-trigger:rotate-90">
        <ChevronRight />
      </TraceIcon>
    </CollapsiblePrimitive.Trigger>
  );
}

function TraceCollapsibleContent({ className, children, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return (
    <CollapsiblePrimitive.Content
      data-slot="trace-collapsible-content"
      className="min-w-0 overflow-hidden data-[state=closed]:animate-trace-up data-[state=open]:animate-trace-down"
      {...props}
    >
      <div className={cn("mt-1.5 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-l pr-1 pl-4 wrap-break-word text-muted-foreground", className)}>
        {children}
      </div>
    </CollapsiblePrimitive.Content>
  );
}

export { Trace, TraceLine, TraceIcon, TraceTitle, TraceVerb, TraceDetail, TraceDescription, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent };
