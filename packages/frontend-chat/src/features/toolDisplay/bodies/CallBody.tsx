import { Block } from "../blocks";
import { CodeFrame } from "../CodeFrame";
import type { Tool } from "../group";
import { hasRaw, inputOf, json, outputOf, present } from "../raw";
import { Fold } from "./Fold";

export function CallBody({ tool }: { tool: Tool }) {
   return (
      <>
         {tool.content.map((b, i) => (
            <Block key={i} b={b} tool={tool} />
         ))}
         {hasRaw(tool) && (
            <div className="flex flex-col gap-1">
               {present(inputOf(tool)) && (
                  <Fold label="Input">
                     <CodeFrame
                        label="input"
                        code={json(inputOf(tool))}
                        lang={typeof inputOf(tool) === "string" ? "" : "json"}
                     />
                  </Fold>
               )}
               {present(outputOf(tool)) && (
                  <Fold label="Output">
                     <CodeFrame
                        label="output"
                        code={json(outputOf(tool))}
                        lang={typeof outputOf(tool) === "string" ? "" : "json"}
                     />
                  </Fold>
               )}
            </div>
         )}
      </>
   );
}
