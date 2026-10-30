import { createContext, useContext, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, ImageOff, Info, XCircle } from "lucide-react";
import type { SessionApi } from "@harness/api";
import { Dialog, DialogContent, DialogTitle, cn } from "@harness/ui";
import { Markdown } from "./Markdown";
import type { RenderUiInput, UiNode } from "./tools";

type Tone = "neutral" | "info" | "success" | "warning" | "error";
type Img = { src: string; alt: string; caption?: string };

const tones: Record<Tone, { icon: typeof Info | null; box: string; fg: string }> = {
  neutral: { icon: null, box: "bg-card", fg: "text-muted-foreground" },
  info: { icon: Info, box: "border-sky-500/40 bg-sky-500/5", fg: "text-sky-600 dark:text-sky-400" },
  success: { icon: CheckCircle2, box: "border-emerald-500/40 bg-emerald-500/5", fg: "text-emerald-600 dark:text-emerald-400" },
  warning: { icon: AlertTriangle, box: "border-amber-500/40 bg-amber-500/5", fg: "text-amber-600 dark:text-amber-400" },
  error: { icon: XCircle, box: "border-destructive/40 bg-destructive/5", fg: "text-destructive" },
};

/** Where image srcs resolve: the core's copies of local files (`files`), else the URL as given. */
const ImageSource = createContext<{ api: SessionApi; files: Record<string, string> } | null>(null);
const imageCache = new Map<string, Promise<string>>();

function useImage(src: string): { url: string | null; failed: boolean } {
  const ctx = useContext(ImageSource);
  const copy = ctx?.files[src];
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!copy) {
      setState(/^(https:|data:image\/)/.test(src) ? { url: src, failed: false } : { url: null, failed: true });
      return;
    }
    const key = `${ctx!.api.sessionId}:${copy}`;
    let p = imageCache.get(key);
    if (!p) {
      p = ctx!.api.frontendReadImage(copy).then((r) => `data:${r.mime};base64,${r.data}`);
      p.catch(() => imageCache.delete(key));
      imageCache.set(key, p);
    }
    let live = true;
    p.then((url) => live && setState({ url, failed: false }), () => live && setState({ url: null, failed: true }));
    return () => {
      live = false;
    };
  }, [ctx, copy, src]);
  return state;
}

/** `imgClassName` sizes the image itself; by default it fills the box `className` sizes. */
function Picture({ img, className, imgClassName = "size-full object-contain", onOpen }: { img: Img; className?: string; imgClassName?: string; onOpen?: () => void }) {
  const { url, failed } = useImage(img.src);
  const [broken, setBroken] = useState(false);
  if (failed || broken) {
    return (
      <div className={cn("flex items-center justify-center gap-2 bg-muted text-xs text-muted-foreground", className)}>
        <ImageOff className="size-4" /> {img.alt}
      </div>
    );
  }
  const el = url ? <img src={url} alt={img.alt} onError={() => setBroken(true)} className={imgClassName} /> : null;
  if (!onOpen) return <div className={cn("bg-muted", className)}>{el}</div>;
  return (
    <button className={cn("block bg-muted", className)} onClick={onOpen} aria-label={`Open ${img.alt}`}>
      {el}
    </button>
  );
}

/** Full-size view of `images`, starting at `index`; arrow keys and buttons step through them. */
function Lightbox({ images, index, onIndex, onClose }: { images: Img[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const img = index == null ? null : images[index];
  const step = (d: number) => index != null && onIndex((index + d + images.length) % images.length);
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
              <Picture key={img.src} img={img} className="min-h-40 min-w-60 overflow-hidden rounded" imgClassName="block max-h-[80vh] max-w-[85vw] object-contain" />
              {images.length > 1 && <Arrows onStep={step} label={`${index! + 1} / ${images.length}`} />}
            </div>
            {img.caption && <figcaption className="mt-2 text-center text-xs text-muted-foreground">{img.caption}</figcaption>}
          </figure>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Arrows({ onStep, label }: { onStep: (d: number) => void; label: string }) {
  const btn = "absolute top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 shadow hover:bg-background";
  return (
    <>
      <button className={cn(btn, "left-2")} onClick={() => onStep(-1)} aria-label="Previous image">
        <ChevronLeft className="size-4" />
      </button>
      <button className={cn(btn, "right-2")} onClick={() => onStep(1)} aria-label="Next image">
        <ChevronRight className="size-4" />
      </button>
      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-xs tabular-nums">{label}</span>
    </>
  );
}

function ImageView({ img }: { img: Img }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <figure>
      <Picture img={img} className="max-h-80 min-h-24 w-full overflow-hidden rounded-md border" onOpen={() => setOpen(0)} />
      {img.caption && <figcaption className="mt-1 break-words text-xs text-muted-foreground">{img.caption}</figcaption>}
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
        <Picture key={img.src} img={img} className="h-64 w-full overflow-hidden rounded-md border" onOpen={() => setOpen(i)} />
        {images.length > 1 && <Arrows onStep={step} label={`${i + 1} / ${images.length}`} />}
      </div>
      {img.caption && <figcaption className="mt-1 break-words text-xs text-muted-foreground">{img.caption}</figcaption>}
      <Lightbox images={images} index={open} onIndex={(n) => (setOpen(n), setI(n))} onClose={() => setOpen(null)} />
    </figure>
  );
}

function Node({ node }: { node: UiNode }) {
  const kids = node.children?.map((c, i) => <Node key={i} node={c} />);
  switch (node.type) {
    case "Stack": {
      const gap = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" }[node.props?.gap ?? "md"];
      return <div className={cn("flex min-w-0", node.props?.direction === "horizontal" ? "flex-row flex-wrap items-start" : "flex-col", gap)}>{kids}</div>;
    }
    case "Card": {
      const t = tones[node.props?.tone ?? "neutral"];
      const Icon = t.icon;
      return (
        <div className={cn("min-w-0 space-y-2 rounded-lg border p-3", t.box)}>
          {node.props?.title && (
            <div className="flex items-center gap-2 font-medium">
              {Icon && <Icon className={cn("size-4 shrink-0", t.fg)} />}
              {node.props.title}
            </div>
          )}
          {kids}
        </div>
      );
    }
    case "Markdown":
      return <Markdown>{node.props.text}</Markdown>;
    case "KeyValue":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {node.props.items.map((it, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{it.label}</dt>
              <dd className="min-w-0 break-words">{it.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "Table":
      return (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-left">
              <tr>{node.props.columns.map((c, i) => <th key={i} className="px-2 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody>
              {node.props.rows.map((r, i) => (
                <tr key={i} className="border-t">
                  {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "Badge": {
      const t = tones[node.props.tone ?? "neutral"];
      return <span className={cn("inline-flex w-fit rounded-full border px-2 py-0.5 text-xs font-medium", t.box, t.fg)}>{node.props.text}</span>;
    }
    case "Code":
      return <Markdown>{"```" + (node.props.language ?? "") + "\n" + node.props.code + "\n```"}</Markdown>;
    case "Image":
      return <ImageView img={node.props} />;
    case "Carousel":
      return <Carousel images={node.props.images} />;
  }
}

/** A `render_ui` call: its component tree. Images resolve through the core's copies in `files`. */
export function RenderUi({ input, api, files }: { input: RenderUiInput; api: SessionApi; files: Record<string, string> }) {
  return (
    <ImageSource.Provider value={{ api, files }}>
      <div className="min-w-0 text-sm">
        <Node node={input.root} />
      </div>
    </ImageSource.Provider>
  );
}
