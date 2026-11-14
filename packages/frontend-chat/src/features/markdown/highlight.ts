import { common, createLowlight } from "lowlight";

/** highlight.js has no Mermaid. Enough for its keywords, labels, arrows and comments. */
function mermaid() {
   return {
      name: "Mermaid",
      keywords: {
         keyword:
            "graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram gantt pie journey gitGraph mindmap timeline quadrantChart requirementDiagram sankey-beta xychart-beta block-beta architecture-beta subgraph end direction participant actor loop alt else opt par and critical break rect note over activate deactivate autonumber class state section title dateFormat axisFormat",
         literal: "TD TB BT LR RL",
      },
      contains: [
         { className: "comment", begin: /%%/, end: /$/ },
         { className: "string", begin: /"/, end: /"/ },
         { className: "string", begin: /\|[^|\n]+\|/ },
         { className: "operator", begin: /[<ox]?[-=.]{2,}[>ox]?|--?>>?|-[x)]|\|\|?|:::?/ },
         { className: "string", begin: /[[({][^\])}\n]*[\])}]/ },
      ],
   };
}

/**
 * The one highlight.js instance of the chat (Markdown code blocks and inline code, file view, diff, code frames,
 * the prompt box). A lowlight instance compiles each grammar on first use, so a new one per render would compile
 * them again every time.
 */
const lowlight = createLowlight(common);
lowlight.register({ mermaid });

/** Whether highlight.js knows `lang` (a name or alias). */
/** highlight.js output: a hast root. */
export type Tree = ReturnType<typeof lowlight.highlight>;

export const isLanguage = (lang: string) => lowlight.registered(lang);

/** `code` as highlight.js tokens (hast, classes colored by the shared code theme); null for no or an unknown language. */
export function highlight(code: string, lang: string | null | undefined): Tree | null {
   if (!lang || !lowlight.registered(lang)) return null;
   try {
      return lowlight.highlight(lang, code);
   } catch {
      return null;
   }
}

/** Language by file extension (or whole name), where highlight.js does not know the extension by name. */
const BY_EXTENSION: Record<string, string> = {
   ts: "typescript",
   tsx: "typescript",
   mts: "typescript",
   cts: "typescript",
   js: "javascript",
   jsx: "javascript",
   mjs: "javascript",
   cjs: "javascript",
   json: "json",
   jsonc: "json",
   json5: "json",
   md: "markdown",
   mdx: "markdown",
   rs: "rust",
   py: "python",
   go: "go",
   css: "css",
   html: "xml",
   htm: "xml",
   xml: "xml",
   svg: "xml",
   vue: "xml",
   svelte: "xml",
   yml: "yaml",
   yaml: "yaml",
   toml: "ini",
   sh: "bash",
   zsh: "bash",
   fish: "bash",
   sql: "sql",
   java: "java",
   kt: "kotlin",
   swift: "swift",
   rb: "ruby",
   Makefile: "makefile",
};

/**
 * The highlight language of a file, from its extension (or name): the table above, else the extension as a
 * language name or alias highlight.js knows (`c`, `lua`, `php`). Null for plain text.
 */
export function languageOf(path: string): string | null {
   const name = path.slice(path.lastIndexOf("/") + 1);
   const dot = name.lastIndexOf(".");
   const ext = dot > 0 ? name.slice(dot + 1) : name;
   const lang = BY_EXTENSION[ext] ?? BY_EXTENSION[ext.toLowerCase()] ?? ext.toLowerCase();
   return lowlight.registered(lang) ? lang : null;
}

/** One highlighted line: text runs with the classes of their innermost token. */
export type Run = { text: string; cls?: string };

/** The lines of a tree, as runs (a token over several lines, like a block comment, is split too). */
export function toLines(tree: Tree): Run[][] {
   const lines: Run[][] = [[]];
   const walk = (n: Tree | Tree["children"][number], cls?: string) => {
      if (n.type === "text") {
         n.value.split("\n").forEach((t, i) => {
            if (i) lines.push([]);
            if (t) lines[lines.length - 1]!.push({ text: t, cls });
         });
         return;
      }
      if (!("children" in n)) return;
      const own =
         "properties" in n && Array.isArray(n.properties?.className)
            ? (n.properties.className as string[]).join(" ")
            : cls;
      for (const c of n.children) walk(c, own);
   };
   walk(tree);
   return lines;
}

/** `lines` highlighted as one text (`lang`: from `languageOf`), one list of runs per line; plain when null. */
export function highlightLines(lang: string | null, lines: readonly string[]): Run[][] {
   const tree = highlight(lines.join("\n"), lang);
   return tree ? toLines(tree) : lines.map((l) => (l ? [{ text: l }] : []));
}
