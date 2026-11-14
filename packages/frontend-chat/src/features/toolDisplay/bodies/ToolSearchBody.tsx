import { CodeFrame } from "../CodeFrame";
import type { Tool } from "../group";
import { shortToolName } from "../label";
import { json, present } from "../raw";
import { Fold } from "./Fold";

/** A ToolSearch call: the tools it loaded (made callable), then its query. */
export function ToolSearchBody({ tool, names }: { tool: Tool; names: string[] }) {
   return (
      <>
         <ul className="flex flex-col gap-0.5 font-mono text-ui-sm">
            {names.map((n) => (
               <li key={n} className="truncate" title={n}>
                  {shortToolName(n)}
               </li>
            ))}
         </ul>
         {present(tool.rawInput) && (
            <Fold label="Input">
               <CodeFrame label="input" code={json(tool.rawInput)} lang="json" />
            </Fold>
         )}
      </>
   );
}
