import type { SessionApi } from "@harness/api";
import type { Approval, ChatSubagent, Step } from "./group";

export type {
   Approval,
   ChatSubagent,
   Step,
   ToolGroup,
} from "./group";

export type ToolGroupProps = {
   steps: Step[];
   /** Calls a subagent made, by the id of the call that started it. */
   subagents: Map<string, ChatSubagent>;
   /** A Turn is running: unfinished calls are in flight (Agents often keep them `pending` until done). */
   active: boolean;
   /** The group is the Thread's last row while a Turn runs: its last thought is still streaming. */
   streaming?: boolean;
   /** Pending step approvals of the group: shown after its steps, with their answers. */
   approvals?: Approval[];
   /** For the approvals' answers. */
   api?: SessionApi;
};
