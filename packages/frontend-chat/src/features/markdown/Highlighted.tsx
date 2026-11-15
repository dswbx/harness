import type { ReactNode } from "react";
import { useMemo } from "react";
import { highlight, type Tree } from "./highlight";

function toReact(n: Tree["children"][number], key: number): ReactNode {
   if (n.type === "text") return n.value;
   if (n.type !== "element") return null;
   return (
      <span key={key} className={(n.properties?.className as string[] | undefined)?.join(" ")}>
         {n.children.map(toReact)}
      </span>
   );
}

/** `text` with highlight.js tokens, colored by the shared code theme. Plain for an unknown language. */
export function Highlighted({ lang, text }: { lang: string | null | undefined; text: string }) {
   return useMemo(() => highlight(text, lang)?.children.map(toReact) ?? text, [lang, text]);
}
