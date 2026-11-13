import { cn } from "@harness/ui";
import type { SubagentMeta as Meta } from "../reducer";

/** A subagent's `type · model (inherited) · effort <level>`, in one muted line. Nothing when all are unknown. */
export function SubagentMeta({ meta, className }: { meta: Meta | null; className?: string }) {
   if (!meta) return null;
   const parts = [
      meta.type,
      meta.model && (meta.modelInherited ? `${meta.model} (inherited)` : meta.model),
      meta.effort && `effort ${meta.effort}`,
   ].filter((p): p is string => !!p);
   if (parts.length === 0) return null;
   return (
      <div className={cn("font-mono text-ui-sm text-muted-foreground", className)}>
         {parts.join(" · ")}
      </div>
   );
}
