import { findPrRefs, type PrRefContext, prKey, qualify } from "@harness/api";

type Node = {
   type: string;
   tagName?: string;
   value?: string;
   properties?: Record<string, unknown>;
   children?: Node[];
};

/** Where refs stay text: code, links (their text is the link's), headings. */
const SKIP = new Set(["pre", "code", "a", "h1", "h2", "h3", "h4", "h5", "h6"]);

const chip = (key: string, raw: string): Node => ({
   type: "element",
   tagName: "span",
   properties: { dataPrRef: key, dataRaw: raw },
   children: [{ type: "text", value: raw }],
});

/** Text with its PR refs split out as chips; null when it has none. */
function split(text: string, ctx: PrRefContext): Node[] | null {
   const out: Node[] = [];
   let at = 0;
   for (const m of findPrRefs(text, ctx)) {
      // A bare `#3` in a message is too often a list item or step, so only `repo#3`, `owner/repo#3` and URLs count.
      if (m.repo === null) continue;
      const key = qualify(m, ctx);
      if (!key) continue;
      if (m.start > at) out.push({ type: "text", value: text.slice(at, m.start) });
      out.push(chip(prKey(key), m.raw));
      at = m.end;
   }
   if (!out.length) return null;
   if (at < text.length) out.push({ type: "text", value: text.slice(at) });
   return out;
}

/** Rehype plugin: PR refs in text (not bare `#N`) become `<span data-pr-ref="owner/repo#N" data-raw>` (rendered as `PrChip`). A link
 * that is just a PR URL (autolink) becomes one too; named links stay links. Without `ctx` it does nothing. Runs
 * before `rehypeInlineCode`, which turns inline code into spans. */
export function rehypePrRefs({ ctx }: { ctx?: PrRefContext | null } = {}) {
   return (tree: Node) => {
      if (!ctx) return;
      const walk = (node: Node) => {
         const kids = node.children;
         if (!kids) return;
         node.children = kids.flatMap((c): Node | Node[] => {
            if (c.type === "text") return split(c.value!, ctx) ?? c;
            if (c.type !== "element") return c;
            if (c.tagName === "a") {
               const href = typeof c.properties?.href === "string" ? c.properties.href : "";
               const text =
                  c.children?.length === 1 && c.children[0]!.type === "text"
                     ? c.children[0]!.value
                     : null;
               const key = text === href && /\/pull\/\d+/.test(href) ? qualify(href, ctx) : null;
               return key ? chip(prKey(key), href) : c;
            }
            if (!SKIP.has(c.tagName!)) walk(c);
            return c;
         });
      };
      walk(tree);
   };
}
