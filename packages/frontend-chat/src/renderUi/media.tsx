import { cn, Dialog, DialogContent, DialogTitle } from "@harness/ui";
import { s } from "jsonv-ts";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import type { UiAction } from "../tools";
import { UiHtml } from "../UiHtml";
import { Env, type Renderers, runActions } from "./runtime";
import { demoImage, type Entry, image } from "./shared";

/** Media: Image, Carousel, Html. */

/** The Html example: a clickable SVG diagram bound to `/html_demo/selected` (gallery, tests). */
function htmlExample() {
   const box = (id: string, x: number, label: string) =>
      `<g class="box" data-box="${id}" data-on-click='{"action":"setState","params":{"statePath":"/html_demo/selected","value":"${id}"}}'><rect x="${x}" y="20" width="120" height="56" rx="8"/><text x="${x + 60}" y="53">${label}</text></g>`;
   const arrow = (x: number) =>
      `<line x1="${x}" y1="48" x2="${x + 36}" y2="48" marker-end="url(#head)"/>`;
   return {
      type: "Html" as const,
      props: {
         title: "Request flow",
         html: [
            "<style>",
            "svg { width: 100%; max-width: 480px; display: block; }",
            ".box rect { fill: var(--card); stroke: var(--border); stroke-width: 1.5; }",
            ".box.on rect { stroke: var(--chart-1); stroke-width: 2.5; }",
            ".box text { fill: var(--foreground); font: 13px var(--font-sans); text-anchor: middle; }",
            "line { stroke: var(--muted-foreground); stroke-width: 1.5; }",
            "#head path { fill: var(--muted-foreground); }",
            "p { margin: 8px 0 0; color: var(--muted-foreground); }",
            "</style>",
            '<svg viewBox="0 0 480 96" role="img" aria-label="Web app calls API, API reads Database">',
            '<defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs>',
            box("web", 2, "Web app"),
            arrow(124),
            box("api", 180, "API"),
            arrow(302),
            box("db", 358, "Database"),
            "</svg>",
            '<p>Selected: <strong data-state="/html_demo/selected"></strong></p>',
            '<p data-visible=\'{"$state":"/html_demo/selected","eq":"api"}\'>The API checks the session, then reads from the database.</p>',
            "<script>harness.subscribe((s) => document.querySelectorAll('[data-box]').forEach((b) => b.classList.toggle('on', b.dataset.box === s?.html_demo?.selected)));</script>",
         ].join("\n"),
      },
   };
}
export const specs = {
   Image: {
      description: "One image; the user can open it full size.",
      children: false,
      props: image,
      example: {
         node: {
            type: "Image",
            props: {
               src: demoImage("Screenshot", 210),
               alt: "Screenshot",
               caption: "A local file path or an https URL",
            },
         },
      },
   },
   Carousel: {
      description: "Several images, one at a time, with previous/next.",
      children: false,
      props: s.object({ images: s.array(image, { minItems: 1 }) }),
      example: {
         node: {
            type: "Carousel",
            props: {
               images: [1, 2, 3].map((i) => ({
                  src: demoImage(`Image ${i}`, 150 + i * 50),
                  alt: `Image ${i}`,
                  caption: `Image ${i} of 3`,
               })),
            },
         },
      },
   },
   Html: {
      description:
         "Free HTML/SVG in a sandboxed frame, for diagrams and custom visuals the catalog cannot show (e.g. an architecture diagram). Prefer catalog components for normal UI. Connects to the Session State with data-* attributes and `window.harness` (see above).",
      children: false,
      props: s.object({
         html: s.string({
            description:
               "Body content: HTML or SVG with inline <style> and <script>. No network at all: no remote images or fonts; images only as data: URIs or inline SVG (use the image node for files and URLs). Theme colors: var(--foreground), --muted-foreground, --card, --border, --primary, --chart-1 to --chart-5.",
         }),
         height: s
            .number({
               minimum: 40,
               maximum: 2000,
               description:
                  "Maximum height in px; taller content scrolls inside the frame. The frame always fits its content, so leave it out unless the content can grow very tall.",
            })
            .optional(),
         title: s.string({ description: "What it shows (frame title)." }).optional(),
      }),
      example: { node: htmlExample(), state: { html_demo: { selected: "" } } },
   },
} as const satisfies Record<string, Entry>;

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
      return (
         <UiHtml
            html={node.props.html}
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
   },
} satisfies Renderers;
