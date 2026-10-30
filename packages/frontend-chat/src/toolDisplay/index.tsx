import { useSyncExternalStore, type FC } from "react";
import type { Subagent } from "@harness/api";
import type { Tool } from "./group";
import { CardDisplay } from "./CardDisplay";
import { TraceDisplay } from "./TraceDisplay";

export { groupTools, type Tool, type ToolGroup } from "./group";

export type ToolGroupProps = {
  calls: Tool[];
  /** Calls a subagent made, by the id of the call that started it. */
  subagents: Map<string, Subagent<Tool>>;
};

/** One way to show tool calls. Each gets a whole run of consecutive calls, so it can lay them out as one. */
export type ToolDisplay = { id: string; label: string; Group: FC<ToolGroupProps> };

export const toolDisplays: ToolDisplay[] = [
  { id: "card", label: "Cards", Group: CardDisplay },
  { id: "trace", label: "Trace", Group: TraceDisplay },
];

// Per-viewer choice; every chat in the window follows it.
const KEY = "harness.chat.toolDisplay";
const listeners = new Set<() => void>();
const read = () => {
  try { return localStorage.getItem(KEY) ?? toolDisplays[0]!.id; } catch { return toolDisplays[0]!.id; }
};
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function setToolDisplay(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* per-viewer convenience only */ }
  listeners.forEach((f) => f());
}

export function useToolDisplay(): ToolDisplay {
  const id = useSyncExternalStore(subscribe, read);
  return toolDisplays.find((d) => d.id === id) ?? toolDisplays[0]!;
}
