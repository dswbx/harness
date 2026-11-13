import { type FC, useSyncExternalStore } from "react";
import { CardDisplay } from "./CardDisplay";
import type { ChatSubagent, Step } from "./group";
import { TraceDisplay } from "./TraceDisplay";

export {
   type ChatSubagent,
   groupTools,
   type Step,
   type Thought,
   type Tool,
   type ToolGroup,
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

/** One way to show tool calls. Each gets a whole run of consecutive calls, so it can lay them out as one. */
export type ToolDisplay = { id: string; label: string; Group: FC<ToolGroupProps> };

export const toolDisplays: ToolDisplay[] = [
   { id: "card", label: "Cards", Group: CardDisplay },
   { id: "trace", label: "Trace", Group: TraceDisplay },
];

// Per-viewer choice (Settings > Appearance); every chat follows it, across windows too.
const KEY = "harness.chat.toolDisplay";
const DEFAULT = "trace";
const listeners = new Set<() => void>();
const read = () => {
   try {
      return localStorage.getItem(KEY) ?? DEFAULT;
   } catch {
      return DEFAULT;
   }
};
const subscribe = (f: () => void) => {
   listeners.add(f);
   const onStorage = (e: StorageEvent) => e.key === KEY && f();
   window.addEventListener("storage", onStorage);
   return () => {
      listeners.delete(f);
      window.removeEventListener("storage", onStorage);
   };
};

export function setToolDisplay(id: string) {
   try {
      localStorage.setItem(KEY, id);
   } catch {
      /* per-viewer convenience only */
   }
   listeners.forEach((f) => f());
}

export function useToolDisplay(): ToolDisplay {
   const id = useSyncExternalStore(subscribe, read);
   return toolDisplays.find((d) => d.id === id) ?? toolDisplays.find((d) => d.id === DEFAULT)!;
}
