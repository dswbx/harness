import { common, createLowlight } from "lowlight";
import { type ReactNode, useMemo } from "react";

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

const lowlight = createLowlight(common);
lowlight.register({ mermaid });

type Hast = {
   type: string;
   value?: string;
   properties?: { className?: string[] };
   children?: Hast[];
};

function toReact(n: Hast, key: number): ReactNode {
   if (n.type === "text") return n.value;
   return (
      <span key={key} className={n.properties?.className?.join(" ")}>
         {n.children?.map(toReact)}
      </span>
   );
}

/** `text` with highlight.js tokens, colored by the shared code theme. Plain for an unknown language. */
export function Highlighted({ lang, text }: { lang: string; text: string }) {
   return useMemo(() => {
      if (!lowlight.registered(lang)) return text;
      try {
         return (lowlight.highlight(lang, text) as Hast).children?.map(toReact) ?? text;
      } catch {
         return text;
      }
   }, [lang, text]);
}

/** Extensions highlight.js (lowlight `common`) does not know by name. */
const LANG_ALIASES: Record<string, string> = {
   mts: "typescript",
   cts: "typescript",
   mjs: "javascript",
   cjs: "javascript",
   jsonc: "json",
   json5: "json",
   toml: "ini",
   html: "xml",
   htm: "xml",
   vue: "xml",
   svelte: "xml",
   zsh: "bash",
   fish: "bash",
   mdx: "markdown",
   Makefile: "makefile",
};

/** The highlight language of a file, from its extension (or name); null for plain text. */
export function fileLanguage(path: string): string | null {
   const name = path.slice(path.lastIndexOf("/") + 1);
   const dot = name.lastIndexOf(".");
   const ext = dot > 0 ? name.slice(dot + 1) : name;
   const lang = LANG_ALIASES[ext] ?? ext.toLowerCase();
   return lowlight.registered(lang) ? lang : null;
}

/** One highlighted line: text runs with the classes of their innermost token. */
export type Run = { text: string; cls?: string };

/** `lowlight` output split into lines (a token over several lines, like a block comment, is split too). */
function toLines(tree: Hast): Run[][] {
   const lines: Run[][] = [[]];
   const walk = (n: Hast, cls?: string) => {
      if (n.type === "text") {
         n.value!.split("\n").forEach((t, i) => {
            if (i) lines.push([]);
            if (t) lines[lines.length - 1]!.push({ text: t, cls });
         });
         return;
      }
      const own = n.properties?.className;
      const next = Array.isArray(own) ? own.join(" ") : cls;
      for (const c of n.children ?? []) walk(c, next);
   };
   walk(tree);
   return lines;
}

/** `lines` highlighted as one text (`lang`: from `fileLanguage`), one list of runs per line; plain when null. */
export function highlightLines(lang: string | null, lines: readonly string[]): Run[][] {
   const plain = (): Run[][] => lines.map((l) => (l ? [{ text: l }] : []));
   if (!lang) return plain();
   try {
      return toLines(lowlight.highlight(lang, lines.join("\n")) as Hast);
   } catch {
      return plain();
   }
}
