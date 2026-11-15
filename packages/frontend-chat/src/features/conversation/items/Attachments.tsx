import type { Attachment, SessionApi } from "@harness/api";
import { Dialog, DialogContent, DialogTitle, Tooltip } from "@harness/ui";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { cachedImage } from "../../../lib/imageCache";

function AttachmentImage({ api, a }: { api: SessionApi; a: Attachment }) {
   const [url, setUrl] = useState<string | null>(null);
   const [failed, setFailed] = useState(false);
   const [open, setOpen] = useState(false);
   useEffect(() => {
      // Thumbnails load once while they are among the recent ones.
      const p = cachedImage(`attachment:${a.path}`, () => api.readAttachment(a.path));
      let live = true;
      p.then(
         (u) => live && setUrl(u),
         () => live && setFailed(true),
      );
      return () => {
         live = false;
      };
   }, [api, a.path]);
   if (failed) return <FileChip a={a} />;
   return (
      <>
         <Tooltip content={a.name}>
            <button
               className="size-20 overflow-hidden rounded-lg border bg-muted"
               aria-label={`Open ${a.name}`}
               onClick={() => setOpen(true)}
            >
               {url && <img src={url} alt={a.name} className="size-full object-cover" />}
            </button>
         </Tooltip>
         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="w-auto max-w-[90vw] p-2">
               <DialogTitle className="sr-only">{a.name}</DialogTitle>
               {url && (
                  <img
                     src={url}
                     alt={a.name}
                     className="max-h-[85vh] max-w-full rounded object-contain"
                  />
               )}
            </DialogContent>
         </Dialog>
      </>
   );
}

function FileChip({ a }: { a: Attachment }) {
   return (
      <Tooltip content={a.path}>
         <span className="flex max-w-64 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{a.name}</span>
         </span>
      </Tooltip>
   );
}

export function UserAttachments({ api, items }: { api: SessionApi; items: Attachment[] }) {
   return (
      <div className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-1.5">
         {items.map((a) =>
            a.kind === "image" ? (
               <AttachmentImage key={a.path} api={api} a={a} />
            ) : (
               <FileChip key={a.path} a={a} />
            ),
         )}
      </div>
   );
}
