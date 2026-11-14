import { type ReactNode, useMemo } from "react";
import { lowlight } from "./lowlight";

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
