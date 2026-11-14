import type { FrontendManifest } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import { Info, List, MessageSquare, Puzzle } from "lucide-react";
import { Label } from "./parts";

/** Known Frontends get an icon and a line of text; others show their version. */
const FRONTEND_INFO: Record<string, { icon: typeof MessageSquare; text: string }> = {
   chat: { icon: MessageSquare, text: "Messages and tools" },
   inspector: { icon: List, text: "Raw Session Log" },
};

export function FrontendField({
   frontends,
   frontendId,
   setFrontendId,
}: {
   frontends: FrontendManifest[];
   frontendId: string;
   setFrontendId: (id: string) => void;
}) {
   return (
      <div className="grid gap-2">
         <Label
            extra={
               <Tooltip content="The Frontend is fixed for the Session's life.">
                  <button
                     type="button"
                     aria-label="About Frontends"
                     className="grid size-5 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                  >
                     <Info className="size-3.5" />
                  </button>
               </Tooltip>
            }
         >
            Frontend
         </Label>
         <div role="radiogroup" aria-label="Frontend" className="grid grid-cols-3 gap-2">
            {frontends.map((f) => {
               const info = FRONTEND_INFO[f.id];
               const Icon = info?.icon ?? Puzzle;
               const on = f.id === frontendId;
               return (
                  <Tooltip key={f.id} content={info?.text ?? `v${f.version}`}>
                     <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setFrontendId(f.id)}
                        className={cn(
                           "flex h-9 min-w-0 items-center gap-2 rounded-md border px-2.5 text-left shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                           on
                              ? "border-primary bg-accent text-accent-foreground"
                              : "border-input hover:bg-accent/50",
                        )}
                     >
                        <Icon
                           className={cn(
                              "size-4 shrink-0",
                              on ? "text-foreground" : "text-muted-foreground",
                           )}
                        />
                        <span className="truncate">{f.name}</span>
                     </button>
                  </Tooltip>
               );
            })}
         </div>
      </div>
   );
}
