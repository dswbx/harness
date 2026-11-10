import { s } from "jsonv-ts";
import { demoImage, type Entry, image } from "./shared";

/** Media: Image, Carousel, Html. */

/** The Html example: a clickable SVG diagram bound to `/html_demo/selected` (gallery, tests). */
export function htmlExample() {
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
