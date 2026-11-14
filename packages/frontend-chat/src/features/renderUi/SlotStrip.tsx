import { cn } from "@harness/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { quotableAttrs } from "../review/SelectionComment";
import { RenderUi, type UiEnv } from "./RenderUi";
import type { Slot } from "./slots";

const slotKey = (x: Slot) => JSON.stringify(x.root);

/** render_ui items placed top or bottom: live, in the chat's column. Each can be hidden until it changes. */
export function SlotStrip({
   slots,
   env,
   className,
}: {
   slots: Slot[];
   env: UiEnv;
   className?: string;
}) {
   const [hidden, setHidden] = useState<Record<string, string>>({});
   const shown = slots.filter((x) => hidden[x.id] !== slotKey(x));
   if (shown.length === 0) return null;
   return (
      <div className={cn("shrink-0", className)}>
         <div className="mx-auto grid max-w-3xl gap-2 px-10 pb-3">
            {shown.map((x) => (
               <div key={x.id} className="group/slot relative rounded-lg border bg-card p-3">
                  <button
                     aria-label={`Hide ${x.title ?? x.id}`}
                     onClick={() => setHidden({ ...hidden, [x.id]: slotKey(x) })}
                     className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground focus:opacity-100 group-hover/slot:opacity-100"
                  >
                     <X className="size-3.5" />
                  </button>
                  <div
                     {...quotableAttrs(null, false, { source: "artifact", label: x.title ?? x.id })}
                  >
                     <RenderUi root={x.root} env={{ ...env, files: x.files, item: x.id }} />
                  </div>
               </div>
            ))}
         </div>
      </div>
   );
}
