// The raw JSON viewers: the only toolDisplay code that touches a call's raw Agent payloads.
import type { Tool } from "./group";

export const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
/** null, `{}` and `[]` carry nothing worth showing. */
export const present = (v: unknown) =>
   v != null && !(typeof v === "object" && Object.keys(v).length === 0);

/** The call's input and output as the Agent sent them, for the raw JSON view. */
export const inputOf = (tool: Tool) => tool.rawInput;
export const outputOf = (tool: Tool) => tool.rawOutput;
/** The call has a raw input or output to show. */
export const hasRaw = (tool: Tool) => present(tool.rawInput) || present(tool.rawOutput);
