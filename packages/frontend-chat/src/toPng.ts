/**
 * Turns SVG and page content into PNGs in the webview. HTML goes in an SVG `foreignObject`, drawn as an
 * image on a canvas: no scripts run and nothing loads from the network there, so Agent content is safe.
 */

export type Svg = { xml: string; width: number; height: number };

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
/** Control characters (ANSI output, say) make the SVG invalid XML; the image would fail to load. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
/** WebKit's canvas limits, with a margin. */
const MAX_SIDE = 16000;
const MAX_AREA = 200_000_000;

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The factor to draw at: `scale`, less when the result would pass `maxEdge` or the canvas limits. */
export function fitScale(width: number, height: number, scale: number, maxEdge = MAX_SIDE): number {
   const edge = Math.min(maxEdge, MAX_SIDE) / Math.max(width, height, 1);
   return Math.min(scale, edge, Math.sqrt(MAX_AREA / Math.max(width * height, 1)));
}

export type PngOptions = {
   /** Pixels per CSS pixel. Default 2. */
   scale?: number;
   /** The longest side of the PNG, in pixels. */
   maxEdge?: number;
};

const pageBackground = () => getComputedStyle(document.body).backgroundColor;

export async function svgToPng(svg: Svg, opts: PngOptions = {}): Promise<Blob> {
   const img = new Image();
   await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("The browser could not draw this content as an image."));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.xml.replace(NOT_XML, ""))}`;
   });
   await img.decode().catch(() => {});
   const k = fitScale(svg.width, svg.height, opts.scale ?? 2, opts.maxEdge);
   const canvas = document.createElement("canvas");
   canvas.width = Math.max(1, Math.round(svg.width * k));
   canvas.height = Math.max(1, Math.round(svg.height * k));
   const ctx = canvas.getContext("2d");
   if (!ctx) throw new Error("No canvas available.");
   const draw = () => {
      ctx.fillStyle = document.documentElement.classList.contains("dark") ? "#000" : "#fff";
      ctx.fillStyle = pageBackground();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
   };
   // WebKit may not have decoded images nested in the SVG at the first draw.
   draw();
   await new Promise((r) => setTimeout(r, 50));
   draw();
   return new Promise((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Could not encode the PNG."))), "image/png"),
   );
}

/**
 * Mermaid's SVG as a file of its own: valid XML (its labels are HTML, with `<br>` and the like), a fixed size
 * from the viewBox, and the page's font (its CSS says `inherit`, which has nothing to inherit from here).
 */
export function standaloneSvg(svg: string, font: string): Svg | null {
   const el = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
   const box = el
      ?.getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
   if (!el || box?.length !== 4 || !(box[2]! > 0) || !(box[3]! > 0)) return null;
   const [, , width, height] = box as [number, number, number, number];
   el.setAttribute("width", String(width));
   el.setAttribute("height", String(height));
   el.style.maxWidth = "none";
   el.style.fontFamily = font;
   return { xml: new XMLSerializer().serializeToString(el), width, height };
}

/** The serialized document of an Html frame as an SVG. Its `:root` rules now match the `svg`. */
export function frameSvg(xhtml: string, width: number, height: number): Svg {
   return {
      xml: `<svg xmlns="${SVG_NS}" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`,
      width,
      height,
   };
}

/** Asks an Html frame for its document (see the bridge). It may not have loaded yet: asks until it answers. */
export function snapshotFrame(frame: HTMLIFrameElement, timeoutMs = 4000): Promise<Svg> {
   const id = crypto.randomUUID();
   return new Promise((ok, fail) => {
      const ask = () => frame.contentWindow?.postMessage({ type: "snapshot", id }, "*");
      const stop = () => {
         clearInterval(again);
         clearTimeout(limit);
         window.removeEventListener("message", onMessage);
      };
      const onMessage = (e: MessageEvent) => {
         const m = e.data as {
            type?: string;
            id?: string;
            xml?: unknown;
            width?: unknown;
            height?: unknown;
         };
         if (e.source !== frame.contentWindow || m?.type !== "snapshot" || m.id !== id) return;
         stop();
         if (
            typeof m.xml === "string" &&
            typeof m.width === "number" &&
            typeof m.height === "number"
         )
            ok(frameSvg(m.xml, Math.ceil(m.width), Math.ceil(m.height)));
         else fail(new Error("The HTML frame sent an invalid snapshot."));
      };
      const again = setInterval(ask, 200);
      const limit = setTimeout(() => {
         stop();
         fail(new Error("The HTML frame did not answer. A script in it may be blocking."));
      }, timeoutMs);
      window.addEventListener("message", onMessage);
      ask();
   });
}

export const dataUrl = (b: Blob) =>
   new Promise<string>((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(r.result as string);
      r.onerror = () => fail(r.error);
      r.readAsDataURL(b);
   });

/** Every CSS rule of the page: the content keeps its classes, pseudo elements and variables. */
function pageCss(): string {
   const out: string[] = [];
   for (const sheet of document.styleSheets) {
      try {
         for (const rule of sheet.cssRules) out.push(rule.cssText);
      } catch {
         // A stylesheet from another origin: its rules cannot be read.
      }
   }
   return out.join("\n");
}

/** Pairs up elements of `from` and its deep clone `to`, in document order. */
function pairs<E extends Element>(from: Element, to: Element, selector: string): [E, E][] {
   const a = from.querySelectorAll<E>(selector);
   const b = to.querySelectorAll<E>(selector);
   return Array.from(a, (x, i) => [x, b[i]!]);
}

/** A loaded image as a data URL: an SVG image can only show embedded images. Null if another site's. */
function embedded(img: HTMLImageElement): string | null {
   try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")?.drawImage(img, 0, 0);
      return c.toDataURL("image/png");
   } catch {
      return null;
   }
}

/** Replaces what an SVG image cannot show (frames, canvases, remote images), and keeps form values. */
async function inlineContent(root: HTMLElement, clone: HTMLElement) {
   for (const [from, to] of pairs<HTMLIFrameElement>(root, clone, "iframe")) {
      const png = await svgToPng(await snapshotFrame(from));
      const img = document.createElement("img");
      img.src = await dataUrl(png);
      img.setAttribute(
         "style",
         `display:block;width:100%;height:${from.offsetHeight}px;object-fit:cover;object-position:top`,
      );
      to.replaceWith(img);
   }
   for (const [from, to] of pairs<HTMLCanvasElement>(root, clone, "canvas")) {
      const img = document.createElement("img");
      img.src = from.toDataURL("image/png");
      img.setAttribute("style", `width:${from.offsetWidth}px;height:${from.offsetHeight}px`);
      to.replaceWith(img);
   }
   for (const [from, to] of pairs<HTMLImageElement>(root, clone, "img")) {
      if (from.currentSrc.startsWith("data:")) continue;
      const src = embedded(from);
      if (src) to.src = src;
      else to.removeAttribute("src");
   }
   for (const [from, to] of pairs<HTMLInputElement>(root, clone, "input")) {
      to.setAttribute("value", from.value);
      if (from.checked) to.setAttribute("checked", "");
   }
   for (const [from, to] of pairs<HTMLTextAreaElement>(root, clone, "textarea"))
      to.textContent = from.value;
}

/** Page content (laid out, styled by the page's CSS) as a standalone SVG. */
export async function domToSvg(root: HTMLElement): Promise<Svg> {
   const clone = root.cloneNode(true) as HTMLElement;
   await inlineContent(root, clone);
   // The root is held off screen: in the picture it starts at the corner.
   clone.style.position = "static";
   clone.style.left = "0";
   const width = Math.ceil(root.offsetWidth);
   const height = Math.ceil(root.scrollHeight);
   const html = document.documentElement;
   const css = pageCss().replace(/&/g, "&amp;").replace(/</g, "&lt;");
   return {
      xml:
         `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" class="${attr(html.className)}" style="${attr(html.getAttribute("style") ?? "")}">` +
         `<style>${css}</style><foreignObject width="100%" height="100%"><body xmlns="${XHTML_NS}" style="margin:0">` +
         new XMLSerializer().serializeToString(clone) +
         "</body></foreignObject></svg>",
      width,
      height,
   };
}
