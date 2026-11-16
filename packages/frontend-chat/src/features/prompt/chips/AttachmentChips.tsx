import { Tooltip } from "@harness/ui";
import { FileText, X } from "lucide-react";
import { useState } from "react";
import { ImageDialog } from "../../../lib/ImageDialog";
import type { PendingAttachment } from "../attachments";

/** Files and images waiting to be sent: image thumbnails (pasted ones) or name chips. */
export function AttachmentChips({
   items,
   onRemove,
}: {
   items: PendingAttachment[];
   onRemove: (id: string) => void;
}) {
   const [open, setOpen] = useState<PendingAttachment | null>(null);
   return (
      <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2" aria-label="Attachments">
         {items.map((a) => {
            const chip = (
               <span
                  key={a.id}
                  className="group/att relative flex max-w-56 items-center gap-1.5 rounded-md border bg-muted text-xs"
               >
                  {a.preview ? (
                     <button
                        type="button"
                        className="cursor-zoom-in"
                        aria-label={`Open ${a.name}`}
                        onClick={() => setOpen(a)}
                     >
                        {/* Not hit-testable: else WebKit's Live Text boxes text inside the image. */}
                        <img
                           src={a.preview}
                           alt={a.name}
                           draggable={false}
                           className="pointer-events-none size-20 select-none rounded-md object-cover"
                        />
                     </button>
                  ) : (
                     <span className="flex min-w-0 items-center gap-1.5 py-1 pl-1.5 pr-6">
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{a.name}</span>
                     </span>
                  )}
                  <button
                     type="button"
                     className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/att:opacity-100"
                     aria-label={`Remove ${a.name}`}
                     onClick={() => onRemove(a.id)}
                  >
                     <X className="size-3" />
                  </button>
               </span>
            );
            // Image thumbnails need no tooltip; file chips show their full path.
            return a.preview ? (
               chip
            ) : (
               <Tooltip key={a.id} content={a.input.type === "path" ? a.input.path : a.name}>
                  {chip}
               </Tooltip>
            );
         })}
         <ImageDialog
            src={open?.preview ?? null}
            alt={open?.name ?? "Image"}
            open={open != null}
            onOpenChange={(o) => !o && setOpen(null)}
         />
      </div>
   );
}
