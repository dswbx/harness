import { cn } from "@harness/ui";

const heading = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** A setting: label, control and optional help text under the control. The label sits on the control's first line
 * (min-h-8, the height of inputs), so it stays readable when the control or help wraps. */
export function Row({
   label,
   htmlFor,
   help,
   children,
}: {
   label: string;
   htmlFor?: string;
   help?: React.ReactNode;
   children: React.ReactNode;
}) {
   return (
      <>
         <label htmlFor={htmlFor} className={cn(heading, "flex min-h-8 items-center self-start")}>
            {label}
         </label>
         <div className="grid min-w-0 gap-1 self-start">
            <div className="flex min-h-8 min-w-0 items-center gap-2">{children}</div>
            {help && <p className="text-xs text-muted-foreground">{help}</p>}
         </div>
      </>
   );
}
