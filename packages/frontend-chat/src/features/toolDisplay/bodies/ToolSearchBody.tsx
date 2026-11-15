import type { ToolRefFacts } from "@harness/api";
import { Tooltip } from "@harness/ui";
import { CodeFrame } from "../CodeFrame";
import type { Tool } from "../group";
import { shortToolName } from "../label";
import { inputOf, json, present } from "../raw";
import { Fold } from "./Fold";

/** A tool search call: the tools it loaded (made callable), then its query. */
export function ToolSearchBody({ tool, tools }: { tool: Tool; tools: ToolRefFacts[] }) {
   return (
      <>
         <ul className="flex flex-col gap-0.5 font-mono text-ui-sm">
            {tools.map((t) => (
               <Tooltip key={t.name} content={t.name}>
                  <li className="truncate">{shortToolName(t)}</li>
               </Tooltip>
            ))}
         </ul>
         {present(inputOf(tool)) && (
            <Fold label="Input">
               <CodeFrame label="input" code={json(inputOf(tool))} lang="json" />
            </Fold>
         )}
      </>
   );
}
