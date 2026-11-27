import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftsStore, seenStore } from "./store";

// Users have data under these keys: the stored text is pinned (a change needs a migration, AGENTS.md).
const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
   });
});
afterEach(() => vi.unstubAllGlobals());

describe("Inline Threads stored formats", () => {
   it("inlineDrafts: v1, draft id to agent message and Anchor", () => {
      const anchor = { thread_id: "m", seq: 4, quote: "q", prefix: "p", suffix: "s" };
      draftsStore("s1").set({ "draft:1": { itemId: "e4", anchor } });
      expect(mem.get("harness.chat.inlineDrafts.s1")).toBe(
         '{"v":1,"d":"{\\"draft:1\\":{\\"itemId\\":\\"e4\\",\\"anchor\\":{\\"thread_id\\":\\"m\\",\\"seq\\":4,\\"quote\\":\\"q\\",\\"prefix\\":\\"p\\",\\"suffix\\":\\"s\\"}}}"}',
      );
      expect(draftsStore("s1").get()).toEqual({ "draft:1": { itemId: "e4", anchor } });
   });

   it("inlineSeen: v1, Thread id to the last seen turnEndedAt", () => {
      seenStore("s1").set({ t1: 1700000000000 });
      expect(mem.get("harness.chat.inlineSeen.s1")).toBe('{"v":1,"d":"{\\"t1\\":1700000000000}"}');
      expect(seenStore("s1").get()).toEqual({ t1: 1700000000000 });
   });

   it("broken or unknown data reads as empty", () => {
      mem.set("harness.chat.inlineSeen.s1", "garbage");
      mem.set("harness.chat.inlineDrafts.s1", '{"v":2,"d":"{}"}');
      expect(seenStore("s1").get()).toEqual({});
      expect(draftsStore("s1").get()).toEqual({});
   });
});
