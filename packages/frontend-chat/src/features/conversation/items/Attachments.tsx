import type { Attachment, SessionApi } from "@harness/api";
import { Tooltip } from "@harness/ui";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { ImageDialog } from "../../../lib/ImageDialog";
import { cachedImage, cachedImageNow } from "../../../lib/imageCache";

function AttachmentImage({ api, a }: { api: SessionApi; a: Attachment }) {
   const [url, setUrl] = useState(() => cachedImageNow(`attachment:${a.path}`)?.url ?? null);
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
         <button
            className="h-32 min-w-16 cursor-zoom-in overflow-hidden rounded-md border bg-muted"
            aria-label={`Open ${a.name}`}
            onClick={() => setOpen(true)}
         >
            {/* Not hit-testable: else WebKit's Live Text boxes text inside the image. */}
            {url && (
               <img
                  src={url}
                  alt={a.name}
                  draggable={false}
                  className="pointer-events-none h-full w-auto max-w-64 select-none bg-black/40 object-contain"
               />
            )}
         </button>
         <ImageDialog src={url} alt={a.name} open={open} onOpenChange={setOpen} />
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
