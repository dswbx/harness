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
