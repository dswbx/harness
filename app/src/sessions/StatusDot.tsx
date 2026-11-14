import type { SessionStatus } from "@harness/api";
import { cn } from "@harness/ui";

export const statusLabel: Record<SessionStatus, string> = {
   idle: "Idle",
   working: "Working",
   needs_attention: "Needs attention",
};

export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
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
