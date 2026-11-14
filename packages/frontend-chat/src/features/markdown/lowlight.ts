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
 * The one highlight.js instance of the chat. A lowlight instance compiles each grammar on first use, so
 * a new one per render would compile them again every time.
 */
export const lowlight = createLowlight(common);
lowlight.register({ mermaid });

/** Whether `lang` highlights where Mermaid has its own treatment (inline code, the prompt box). */
export const isCommonLanguage = (lang: string) => lang !== "mermaid" && lowlight.registered(lang);
