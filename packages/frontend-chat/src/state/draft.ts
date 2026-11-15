import type { ChatState, Item, ToolDecoder } from "./types";

export const initialState = (): ChatState => ({
   items: [],
   turnId: null,
   turnStartedAt: null,
   mainThreadId: null,
   taskList: [],
   taskListAt: 0,
   configOptions: [],
   lastMode: null,
   plans: [],
   sideMode: null,
   commands: [],
   usage: null,
   title: null,
   process: null,
   readOnly: false,
   recovery: null,
   restoring: null,
   lastTurnErrored: false,
   archived: false,
   promptCaps: null,
   uiState: {},
   sharedAttached: [],
   threads: {},
   threadList: [],
   forkedFrom: null,
   side: false,
   startBoundary: null,
   backgroundJobs: [],
});

/**
 * Mutable scratch space for one batch. `d` is a shallow copy of the state (safe to mutate);
 * `items` is copied lazily, once. Lookup indexes are built on first use and kept in sync, so
 * a batch costs O(items + events) instead of O(items * events).
 */
export type Ctx = {
   d: ChatState;
   owned: boolean;
   tools: Map<string, number> | null;
   perms: Map<string, number> | null;
   /** Side Thread contexts touched in this batch (their `d` goes into `d.threads`). */
   sides: Map<string, Ctx> | null;
   threadsOwned: boolean;
   decodeTool: ToolDecoder;
};

export const newCtx = (d: ChatState, decodeTool: ToolDecoder): Ctx => ({
   d,
   owned: false,
   tools: null,
   perms: null,
   sides: null,
   threadsOwned: false,
   decodeTool,
});

export function own(c: Ctx): Item[] {
   if (!c.owned) {
      c.d.items = c.d.items.slice();
      c.owned = true;
   }
   return c.d.items;
}

export function push(c: Ctx, item: Item) {
   own(c).push(item);
}

/** A notice item with the Event's id. */
export function notice(c: Ctx, id: string, level: "boundary" | "error" | "info", text: string) {
   push(c, { type: "notice", id, level, text });
}

export function toolIndex(c: Ctx): Map<string, number> {
   if (!c.tools) {
      c.tools = new Map();
      c.d.items.forEach((i, n) => i.type === "tool" && c.tools!.set(i.id, n));
   }
   return c.tools;
}

export function permIndex(c: Ctx): Map<string, number> {
   if (!c.perms) {
      c.perms = new Map();
      c.d.items.forEach((i, n) => i.type === "permission" && c.perms!.set(i.requestId, n));
   }
   return c.perms;
}

/** The batch context of a Side Thread; its state (safe to mutate) is already in `c.d.threads`. */
export function sideCtx(c: Ctx, threadId: string): Ctx {
   c.sides ??= new Map();
   let sc = c.sides.get(threadId);
   if (!sc) {
      sc = newCtx({ ...(c.d.threads[threadId] ?? initialState()) }, c.decodeTool);
      c.sides.set(threadId, sc);
   }
   if (!c.threadsOwned) {
      c.d.threads = { ...c.d.threads };
      c.threadsOwned = true;
   }
   c.d.threads[threadId] = sc.d;
   return sc;
}
