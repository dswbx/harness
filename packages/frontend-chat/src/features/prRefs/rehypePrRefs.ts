import {
   findPrRefs,
   isExplicit,
   type PrRefContext,
   type PrRefKey,
   PULL_PATH,
   prKey,
   qualify,
} from "@harness/api";

export type Node = {
   type: string;
   tagName?: string;
   value?: string;
   properties?: Record<string, unknown>;
   children?: Node[];
   position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Where refs stay text: code, links (their text is the link's), headings. */
const SKIP = new Set(["pre", "code", "a", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** A PR ref found in rendered text: `start`/`end` index the node's text (an autolink: its whole text). */
export type PrRefHit = { start: number; end: number; raw: string; key: PrRefKey };

const PULL = new RegExp(PULL_PATH);

/** The PR an autolink (a link that is just a PR URL) is; named links stay links. */
export function prAutolink(a: Node, ctx: PrRefContext): PrRefHit | null {
   const href = typeof a.properties?.href === "string" ? a.properties.href : "";
   const only = a.children?.length === 1 && a.children[0]!.type === "text" ? a.children[0] : null;
   const key = only?.value === href && PULL.test(href) ? qualify(href, ctx) : null;
   return key ? { start: 0, end: href.length, raw: href, key } : null;
}

/** The refs of one text node's text: explicit ones (not a bare `#N` unless written `PR #N`) that resolve. */
function textHits(text: string, ctx: PrRefContext): PrRefHit[] {
   const out: PrRefHit[] = [];
   for (const m of findPrRefs(text, ctx)) {
      const key = isExplicit(m) ? qualify(m, ctx) : null;
      if (key) out.push({ start: m.start, end: m.end, raw: m.raw, key });
   }
   return out;
}

/**
 * The one answer to "what is a PR ref in rendered text": walks a rendered (hast) tree, skipping `SKIP`, and calls
 * `visit` for each text node with refs and each PR autolink; what it returns (if anything) replaces that node.
 * Used by the chat's chips (`rehypePrRefs`) and by the References, so both agree.
 */
export function walkPrRefs(
   tree: Node,
   ctx: PrRefContext,
   visit: (node: Node, hits: PrRefHit[]) => Node | Node[] | undefined,
) {
   const walk = (node: Node) => {
      const kids = node.children;
      if (!kids) return;
      node.children = kids.flatMap((c): Node | Node[] => {
         if (c.type === "text") {
            const hits = textHits(c.value!, ctx);
            return (hits.length && visit(c, hits)) || c;
         }
         if (c.type !== "element") return c;
         if (c.tagName === "a") {
            const hit = prAutolink(c, ctx);
            return (hit && visit(c, [hit])) || c;
         }
         if (!SKIP.has(c.tagName!)) walk(c);
         return c;
      });
   };
   walk(tree);
}

const chip = (key: string, raw: string): Node => ({
   type: "element",
   tagName: "span",
   properties: { dataPrRef: key, dataRaw: raw },
   children: [{ type: "text", value: raw }],
});

/** Rehype plugin: PR refs in text (not bare `#N`; `PR #N` is fine) become `<span data-pr-ref="owner/repo#N" data-raw>` (rendered as `PrChip`). A link
 * that is just a PR URL (autolink) becomes one too; named links stay links. Without `ctx` it does nothing. Runs
 * before `rehypeInlineCode`, which turns inline code into spans. */
export function rehypePrRefs({ ctx }: { ctx?: PrRefContext | null } = {}) {
   return (tree: Node) => {
      if (!ctx) return;
      walkPrRefs(tree, ctx, (node, hits) => {
         if (node.type === "element") return chip(prKey(hits[0]!.key), hits[0]!.raw);
         const text = node.value!;
         const out: Node[] = [];
         let at = 0;
         for (const h of hits) {
            if (h.start > at) out.push({ type: "text", value: text.slice(at, h.start) });
            out.push(chip(prKey(h.key), h.raw));
            at = h.end;
         }
         if (at < text.length) out.push({ type: "text", value: text.slice(at) });
         return out;
      });
   };
}
