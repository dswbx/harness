import { cn, Dialog, DialogContent, DialogTitle } from "@harness/ui";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import type { UiAction } from "../tools";
import { UiHtml } from "../UiHtml";
import { Env, type Renderers, runActions } from "./runtime";
import { SourceView } from "./source";

export * from "./media.spec";

/** Renderers of this group; its specs (schema, description, example) are in `media.spec.ts`. */
type Img = { src: string; alt: string; caption?: string };
const imageCache = new Map<string, Promise<string>>();

function useImage(src: string): { url: string | null; failed: boolean } {
   const env = useContext(Env);
   const copy = env?.files[src];
   const read = env?.readImage;
   const [state, setState] = useState<{ url: string | null; failed: boolean }>({
      url: null,
      failed: false,
   });
   useEffect(() => {
      if (!copy || !read) {
         setState(
            /^(https:|data:image\/)/.test(src)
               ? { url: src, failed: false }
               : { url: null, failed: true },
         );
         return;
      }
      const key = `${env?.scope ?? ""}:${copy}`;
      let p = imageCache.get(key);
      if (!p) {
         p = read(copy).then((r) => `data:${r.mime};base64,${r.data}`);
         p.catch(() => imageCache.delete(key));
         imageCache.set(key, p);
      }
      let live = true;
      p.then(
         (url) => live && setState({ url, failed: false }),
         () => live && setState({ url: null, failed: true }),
      );
      return () => {
         live = false;
      };
   }, [copy, read, src, env?.scope]);
   return state;
}

/** `imgClassName` sizes the image itself; by default it fills the box `className` sizes. */
function Picture({
   img,
   className,
   imgClassName = "size-full object-contain",
   onOpen,
}: {
   img: Img;
   className?: string;
   imgClassName?: string;
   onOpen?: () => void;
}) {
   const { url, failed } = useImage(img.src);
   const [broken, setBroken] = useState(false);
   if (failed || broken) {
      return (
         <div
            className={cn(
               "flex items-center justify-center gap-2 bg-muted text-ui-sm text-muted-foreground",
               className,
            )}
         >
            <ImageOff className="size-4" /> {img.alt}
         </div>
      );
   }
   const el = url ? (
      <img src={url} alt={img.alt} onError={() => setBroken(true)} className={imgClassName} />
   ) : null;
   if (!onOpen) return <div className={cn("bg-muted", className)}>{el}</div>;
   return (
      <button
         className={cn("block bg-muted", className)}
         onClick={onOpen}
         aria-label={`Open ${img.alt}`}
      >
         {el}
      </button>
   );
}

/** Full-size view of `images`, starting at `index`; arrow keys and buttons step through them. */
function Lightbox({
   images,
   index,
   onIndex,
   onClose,
}: {
   images: Img[];
   index: number | null;
   onIndex: (i: number) => void;
   onClose: () => void;
}) {
   const img = index == null ? null : images[index];
   const step = (d: number) =>
      index != null && onIndex((index + d + images.length) % images.length);
   return (
      <Dialog open={img != null} onOpenChange={(o) => !o && onClose()}>
         <DialogContent
            className="w-auto max-w-[90vw] p-2"
            onKeyDown={(e) => {
               if (e.key === "ArrowLeft") step(-1);
               if (e.key === "ArrowRight") step(1);
            }}
         >
            <DialogTitle className="sr-only">{img?.alt ?? "Image"}</DialogTitle>
            {img && (
               <figure>
                  <div className="relative">
                     <Picture
                        key={img.src}
                        img={img}
                        className="min-h-40 min-w-60 overflow-hidden rounded"
                        imgClassName="block max-h-[80vh] max-w-[85vw] object-contain"
                     />
                     {images.length > 1 && (
                        <Arrows onStep={step} label={`${index! + 1} / ${images.length}`} />
                     )}
                  </div>
                  {img.caption && (
                     <figcaption className="mt-2 text-center text-ui-sm text-muted-foreground">
                        {img.caption}
                     </figcaption>
                  )}
               </figure>
            )}
         </DialogContent>
      </Dialog>
   );
}

function Arrows({ onStep, label }: { onStep: (d: number) => void; label: string }) {
   const btn =
      "absolute top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 shadow hover:bg-background";
   return (
      <>
         <button
            className={cn(btn, "left-2")}
            onClick={() => onStep(-1)}
            aria-label="Previous image"
         >
            <ChevronLeft className="size-4" />
         </button>
         <button className={cn(btn, "right-2")} onClick={() => onStep(1)} aria-label="Next image">
            <ChevronRight className="size-4" />
         </button>
         <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-ui-sm tabular-nums">
            {label}
         </span>
      </>
   );
}

function ImageView({ img }: { img: Img }) {
   const [open, setOpen] = useState<number | null>(null);
   return (
      <figure>
         <Picture
            img={img}
            className="max-h-80 min-h-24 w-full overflow-hidden rounded-md border"
            onOpen={() => setOpen(0)}
         />
         {img.caption && (
            <figcaption className="mt-1 break-words text-ui-sm text-muted-foreground">
               {img.caption}
            </figcaption>
         )}
         <Lightbox images={[img]} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      </figure>
   );
}

function Carousel({ images }: { images: Img[] }) {
   const [i, setI] = useState(0);
   const [open, setOpen] = useState<number | null>(null);
   const img = images[Math.min(i, images.length - 1)]!;
   const step = (d: number) => setI((i + d + images.length) % images.length);
   return (
      <figure>
         <div className="relative">
            <Picture
               key={img.src}
               img={img}
               className="h-64 w-full overflow-hidden rounded-md border"
               onOpen={() => setOpen(i)}
            />
            {images.length > 1 && <Arrows onStep={step} label={`${i + 1} / ${images.length}`} />}
         </div>
         {img.caption && (
            <figcaption className="mt-1 break-words text-ui-sm text-muted-foreground">
               {img.caption}
            </figcaption>
         )}
         <Lightbox
            images={images}
            index={open}
            onIndex={(n) => (setOpen(n), setI(n))}
            onClose={() => setOpen(null)}
         />
      </figure>
   );
}

export const renderers = {
   Image: ({ node }) => {
      return <ImageView img={node.props} />;
   },
   Carousel: ({ node }) => {
      return (node.props.images ?? []).length ? <Carousel images={node.props.images} /> : null;
   },
   Html: ({ node, env, scope, checkActions }) => {
      const frame = (html: string) => (
         <UiHtml
            html={html}
            height={node.props.height}
            title={node.props.title}
            state={env.state}
            patch={env.patch}
            send={env.send}
            run={(a) => runActions(a as UiAction[], env, scope)}
            checkActions={checkActions}
            report={env.item && env.report ? (m) => env.report!(env.item!, m) : undefined}
         />
      );
      // A file-backed panel (`source`, ADR 0023): the reducer turns it into an Html node naming the file.
      const source = (node.props as { source?: unknown }).source;
      if (typeof source === "string") return <SourceView name={source}>{frame}</SourceView>;
      return frame(node.props.html);
   },
} satisfies Renderers;
