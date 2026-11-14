import { Tooltip } from "@harness/ui";
import { FileText, X } from "lucide-react";
import type { PendingAttachment } from "../attachments";

/** Files and images waiting to be sent: image thumbnails (pasted ones) or name chips. */
export function AttachmentChips({
   items,
   onRemove,
}: {
   items: PendingAttachment[];
   onRemove: (id: string) => void;
}) {
   return (
      <div className="flex flex-wrap items-center gap-1.5 pb-2" aria-label="Attachments">
         {items.map((a) => (
            <Tooltip key={a.id} content={a.input.type === "path" ? a.input.path : a.name}>
               <span className="group/att relative flex max-w-56 items-center gap-1.5 rounded-md border bg-muted text-xs">
                  {a.preview ? (
                     <img
                        src={a.preview}
                        alt={a.name}
                        className="size-12 rounded-md object-cover"
                     />
                  ) : (
                     <span className="flex min-w-0 items-center gap-1.5 py-1 pl-1.5 pr-6">
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{a.name}</span>
                     </span>
                  )}
                  <button
                     className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/att:opacity-100"
                     aria-label={`Remove ${a.name}`}
                     onClick={() => onRemove(a.id)}
                  >
                     <X className="size-3" />
                  </button>
               </span>
            </Tooltip>
         ))}
      </div>
   );
}
