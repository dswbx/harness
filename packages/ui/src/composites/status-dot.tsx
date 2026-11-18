import { cn } from "../lib/utils";

/** What a status dot shows: an Agent working, or waiting for the user. Idle shows nothing. */
export type DotStatus = "idle" | "working" | "needs_attention";

export const statusLabel: Record<DotStatus, string> = {
   idle: "Idle",
   working: "Working",
   needs_attention: "Needs attention",
};

/** The status dot of the sidebar's Session rows and the side chat tabs. */
export function StatusDot({ status, className }: { status: DotStatus; className?: string }) {
   if (status === "idle") return null;
   return (
      <span
         aria-label={statusLabel[status]}
         className={cn(
            "size-2 shrink-0 rounded-full",
            status === "working" ? "animate-pulse bg-sky-500" : "bg-amber-500",
            className,
         )}
      />
   );
}
