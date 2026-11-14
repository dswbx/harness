import type { ToolRefFacts } from "@harness/api";
import { CodeFrame } from "../CodeFrame";
import type { Tool } from "../group";
import { shortToolName } from "../label";
import { inputOf, json, present } from "../raw";
import { Fold } from "./Fold";

/** A ToolSearch call: the tools it loaded (made callable), then its query. */
export function ToolSearchBody({ tool, tools }: { tool: Tool; tools: ToolRefFacts[] }) {
   return (
      <>
         <ul className="flex flex-col gap-0.5 font-mono text-ui-sm">
            {tools.map((t) => (
               <li key={t.name} className="truncate" title={t.name}>
                  {shortToolName(t)}
               </li>
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
