import { CodeFrame } from "../CodeFrame";
import type { ChatSubagent, Tool } from "../group";
import type { StepBody } from "../stepView";
import { CallBody } from "./CallBody";
import { SubagentBody } from "./SubagentBody";
import { SubSessionBody } from "./SubSessionBody";
import { ToolSearchBody } from "./ToolSearchBody";

/** The body a step opens to, by its kind (`stepView`). */
export function StepBodyView({
   body,
   tool,
   subagents,
   active,
}: {
   body: StepBody;
   tool: Tool;
   /** All subagents, for those a subagent started. */
   subagents: Map<string, ChatSubagent>;
   active: boolean;
}) {
   switch (body.kind) {
      case "none":
         return null;
      case "subagent":
         return (
            <SubagentBody
               task={tool}
               subagent={body.subagent}
               subagents={subagents}
               active={active}
            />
         );
      case "subSession":
         return <SubSessionBody tool={tool} summary={body.summary} />;
      case "toolSearch":
         return <ToolSearchBody tool={tool} names={body.names} />;
      case "commit":
         return <CodeFrame label="commit message" meta={body.hash} code={body.message} />;
      case "call":
         return <CallBody tool={tool} />;
   }
}
