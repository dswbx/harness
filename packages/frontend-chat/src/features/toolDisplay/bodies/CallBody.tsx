import { Block } from "../blocks";
import { CodeFrame } from "../CodeFrame";
import type { Tool } from "../group";
import { json, present } from "../raw";
import { Fold } from "./Fold";

export function CallBody({ tool }: { tool: Tool }) {
   return (
      <>
         {tool.content.map((b, i) => (
            <Block key={i} b={b} tool={tool} />
         ))}
         {(present(tool.rawInput) || present(tool.rawOutput)) && (
            <div className="flex flex-col gap-1">
               {present(tool.rawInput) && (
                  <Fold label="Input">
                     <CodeFrame
                        label="input"
                        code={json(tool.rawInput)}
                        lang={typeof tool.rawInput === "string" ? "" : "json"}
                     />
                  </Fold>
               )}
               {present(tool.rawOutput) && (
                  <Fold label="Output">
                     <CodeFrame
                        label="output"
                        code={json(tool.rawOutput)}
                        lang={typeof tool.rawOutput === "string" ? "" : "json"}
                     />
                  </Fold>
               )}
            </div>
         )}
      </>
   );
}
