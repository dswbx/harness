import { cn } from "@harness/ui";
import type { ReactNode } from "react";

/** The panels' segmented tab strip (Artifacts: Preview / Image / Source; Plan: Plan / Changes). */
export function Segmented<T extends string>({
   value,
   onChange,
   items,
   label,
   className,
}: {
   value: T;
   onChange: (v: T) => void;
   items: { value: T; label: ReactNode; disabled?: boolean }[];
   label?: string;
   className?: string;
}) {
   return (
      <div
         className={cn("inline-flex gap-0.5 rounded-md bg-muted p-0.5", className)}
         role="tablist"
         aria-label={label}
      >
         {items.map((t) => (
            <button
               key={t.value}
               type="button"
               role="tab"
               aria-selected={value === t.value}
               disabled={t.disabled}
               onClick={() => onChange(t.value)}
               className={cn(
                  "h-7 rounded px-3 text-[13px] font-medium text-muted-foreground disabled:opacity-50",
                  value === t.value && "bg-background text-foreground shadow-sm",
               )}
            >
               {t.label}
            </button>
         ))}
      </div>
   );
}
