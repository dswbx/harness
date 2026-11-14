import { lowlight } from "./lowlight";

type Node = {
   type: string;
   value?: string;
   tagName?: string;
   properties?: Record<string, unknown>;
   children?: Node[];
};

const textOf = (n: Node): string =>
   n.type === "text"
      ? (n.value ?? "")
      : n.tagName === "br"
        ? "\n"
        : (n.children ?? []).map(textOf).join("");

/** The language a code element names (`language-x` or `lang-x`), false for `no-highlight`. */
function languageOf(node: Node): string | false | undefined {
   const list = node.properties?.className;
   if (!Array.isArray(list)) return undefined;
   let name: string | undefined;
   for (const c of list) {
      const v = String(c);
      if (v === "no-highlight" || v === "nohighlight") return false;
      if (!name && v.startsWith("lang-")) name = v.slice(5);
      if (!name && v.startsWith("language-")) name = v.slice(9);
   }
   return name;
}

/**
 * Rehype plugin: highlight.js tokens for code blocks (`pre > code`) that name a language, through the shared
 * `lowlight`. The same result as `rehype-highlight` with `detect: false`, without a new instance per render.
 * `plainText`: languages left as they are (they have their own renderer).
 */
export function rehypeHighlightBlocks({ plainText = [] }: { plainText?: string[] } = {}) {
   return (tree: Node) => {
      const walk = (node: Node, parent?: Node) => {
         if (node.type === "element" && node.tagName === "code" && parent?.tagName === "pre") {
            const lang = languageOf(node);
            if (!lang || plainText.includes(lang)) return;
            const className = Array.isArray(node.properties?.className)
               ? (node.properties.className as unknown[])
               : [];
            node.properties = { ...node.properties, className };
            if (!className.includes("hljs")) className.unshift("hljs");
            if (!lowlight.registered(lang)) return;
            const result = lowlight.highlight(lang, textOf(node));
            if (result.children.length > 0) node.children = result.children as Node[];
            return;
         }
         for (const c of node.children ?? []) walk(c, node);
      };
      walk(tree);
   };
}
