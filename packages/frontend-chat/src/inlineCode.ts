import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

/** `{:lang}` before inline code names its language (the Shiki convention); `{:plain}` or an unknown one shows it plain. */
const PREFIX = /^\{:([\w+#-]+)\}/;
/** Unmarked inline code is highlighted as TypeScript only when it looks like code: calls, objects, arrows,
 * assignments. Names, paths and dotted keys (`email`, `use-auth.ts`, `auth.user.change`) stay plain. */
const CODE_LIKE = /[(){}]|=>|\s=\s|;\s*$/;

/** The language inline code is highlighted as, and the code without its `{:lang}` prefix. */
export function inlineLanguage(text: string): { lang: string | null; code: string } {
  const m = PREFIX.exec(text);
  if (m) {
    const lang = m[1]!.toLowerCase();
    return { lang: lowlight.registered(lang) ? lang : null, code: text.slice(m[0].length) };
  }
  return { lang: CODE_LIKE.test(text) ? "typescript" : null, code: text };
}

/** Rehype plugin: highlight.js tokens for inline code (`code` outside `pre`), colored by the shared code theme. */
export function rehypeInlineCode() {
  const walk = (node: Node, parent?: Node) => {
    if (node.type === "element" && node.tagName === "code" && parent?.tagName !== "pre") {
      const text = node.children?.length === 1 && node.children[0]!.type === "text" ? node.children[0]!.value! : null;
      if (text === null) return;
      const { lang, code } = inlineLanguage(text);
      node.children = lang ? (lowlight.highlight(lang, code).children as Node[]) : [{ type: "text", value: code }];
      return;
    }
    for (const c of node.children ?? []) walk(c, node);
  };
  return (tree: Node) => walk(tree);
}
