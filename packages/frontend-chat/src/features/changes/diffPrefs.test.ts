import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewStore, wrapStore } from "./diffPrefs";

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
   });
});

describe("Diff window preferences keep their stored text", () => {
   it("harness:diff-wrap is 1 / 0", () => {
      expect(wrapStore.get()).toBe(false);
      wrapStore.set(true);
      expect(mem.get("harness:diff-wrap")).toBe("1");
      wrapStore.set(false);
      expect(mem.get("harness:diff-wrap")).toBe("0");
      mem.set("harness:diff-wrap", "1");
      expect(wrapStore.get()).toBe(true);
   });
   it("the wrap toggle writes the inverse of the current value", () => {
      // DiffWindow: `setWrap(!wrap); wrapStore.set(!wrap)` from false stores "1", from true "0".
      for (const [from, text] of [
         [false, "1"],
         [true, "0"],
      ] as const) {
         wrapStore.set(!from);
         expect(mem.get("harness:diff-wrap")).toBe(text);
      }
   });
   it("harness:diff-file-view is the plain word; anything but list reads as tree", () => {
      expect(viewStore.get()).toBe("tree");
      viewStore.set("list");
      expect(mem.get("harness:diff-file-view")).toBe("list");
      expect(viewStore.get()).toBe("list");
      mem.set("harness:diff-file-view", "bogus");
      expect(viewStore.get()).toBe("tree");
   });
});
