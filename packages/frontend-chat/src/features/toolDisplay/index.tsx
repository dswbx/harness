import type { ChatSubagent, Step } from "./group";

export type {
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
};
