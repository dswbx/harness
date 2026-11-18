import { type AttachmentInput, errText, pickFiles } from "@harness/api";
import { Tooltip } from "@harness/ui";
import { FileText, Paperclip, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ImageDialog } from "../../lib/ImageDialog";
import { cachedImage } from "../../lib/imageCache";
import { fromFile } from "../prompt/attachments";

/** One stored file: an image shows as a thumbnail (read once, cached by `key`), anything else as a name chip. */
export type StripAsset = {
   key: string;
   name: string;
   image: boolean;
   read: () => Promise<{ mime: string; data: string }>;
   /** Shows a remove button on hover. */
   remove?: () => void;
};

/** The asset with its remove button (if any) in the top right corner, shown on hover. */
function Removable({ asset, children }: { asset: StripAsset; children: ReactNode }) {
   return (
      <span className="group/asset relative flex">
         {children}
         {asset.remove && (
            <button
               type="button"
               aria-label={`Remove ${asset.name}`}
               onClick={asset.remove}
               className="absolute -right-1.5 -top-1.5 hidden size-4 place-items-center rounded-full border bg-background text-muted-foreground shadow-xs hover:text-foreground group-hover/asset:grid focus-visible:grid"
            >
               <X className="size-2.5" />
            </button>
         )}
      </span>
   );
}

function Thumb({ asset, onOpen }: { asset: StripAsset; onOpen: (src: string) => void }) {
   const [src, setSrc] = useState<string | null>(null);
   const read = useRef(asset.read);
   read.current = asset.read;
   useEffect(() => {
      let live = true;
      cachedImage(asset.key, () => read.current()).then(
         (url) => live && setSrc(url),
         () => {},
      );
      return () => {
         live = false;
      };
   }, [asset.key]);
   return (
      <button
         type="button"
         className="cursor-zoom-in"
         aria-label={`Open ${asset.name}`}
         disabled={!src}
         onClick={() => src && onOpen(src)}
      >
         {src ? (
            // Not hit-testable: else WebKit's Live Text boxes text inside the image.
            <img
               src={src}
               alt={asset.name}
               draggable={false}
               className="pointer-events-none h-16 w-auto min-w-10 max-w-40 select-none rounded-md bg-black/40 object-contain"
            />
         ) : (
            <span className="block h-16 w-16 rounded-md bg-muted" />
         )}
      </button>
   );
}

/** Stored files under an editor (note images, task assets): thumbnails for images, name chips for the rest. */
export function AssetStrip({ assets }: { assets: StripAsset[] }) {
   const [open, setOpen] = useState<{ src: string; name: string } | null>(null);
   if (assets.length === 0) return null;
   return (
      <div className="flex flex-wrap items-center gap-1.5 pt-2" aria-label="Files">
         {assets.map((a) =>
            a.image ? (
               <Removable key={a.key} asset={a}>
                  <Tooltip content={a.name}>
                     <span className="flex rounded-md border">
                        <Thumb asset={a} onOpen={(src) => setOpen({ src, name: a.name })} />
                     </span>
                  </Tooltip>
               </Removable>
            ) : (
               <Removable key={a.key} asset={a}>
                  <span className="flex max-w-56 items-center gap-1.5 rounded-md border bg-muted px-1.5 py-1 text-xs">
                     <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                     <span className="truncate">{a.name}</span>
                  </span>
               </Removable>
            ),
         )}
         <ImageDialog
            src={open?.src ?? null}
            alt={open?.name ?? "Image"}
            open={open != null}
            onOpenChange={(o) => !o && setOpen(null)}
         />
      </div>
   );
}

/** Pasted, dropped or picked browser files as inputs (images are scaled down as in the prompt box). */
export const filesToInputs = (files: File[]): Promise<AttachmentInput[]> =>
   Promise.all(files.map(fromFile)).then((a) => a.map((x) => x.input));

/**
 * The paperclip: the native file picker (paths) in the app, a file input in the browser. `accept` filters the
 * browser input only; the core checks what it takes.
 */
export function AddFilesButton({
   label,
   accept,
   onAdd,
   onError,
}: {
   label: string;
   accept?: string;
   onAdd: (files: AttachmentInput[]) => void;
   onError: (message: string) => void;
}) {
   const input = useRef<HTMLInputElement>(null);
   const pick = async () => {
      const paths = await pickFiles();
      if (paths === null) input.current?.click();
      else if (paths.length) onAdd(paths.map((path) => ({ type: "path", path })));
   };
   return (
      <>
         <input
            ref={input}
            type="file"
            multiple
            hidden
            accept={accept}
            onChange={(e) => {
               const files = [...(e.target.files ?? [])];
               e.target.value = "";
               if (files.length) filesToInputs(files).then(onAdd, (err) => onError(errText(err)));
            }}
         />
         <Tooltip content={label}>
            <button
               type="button"
               className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
               aria-label={label}
               onClick={() => void pick().catch((err) => onError(errText(err)))}
            >
               <Paperclip className="size-3.5" />
            </button>
         </Tooltip>
      </>
   );
}
