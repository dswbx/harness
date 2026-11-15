import { describe, expect, it } from "vitest";
import { lru } from "./lru";

describe("lru", () => {
   it("drops the least recently used entry past the count", () => {
      const c = lru<number>({ maxEntries: 2, maxBytes: Infinity });
      c.set("a", 1);
      c.set("b", 2);
      c.get("a");
      c.set("c", 3);
      expect(c.get("b")).toBeUndefined();
      expect(c.get("a")).toBe(1);
      expect(c.get("c")).toBe(3);
   });
   it("drops past the bytes, and keeps the newest entry however big", () => {
      const c = lru<string>({ maxEntries: 10, maxBytes: 100 });
      c.set("a", "a", 60);
      c.set("b", "b", 60);
      expect(c.get("a")).toBeUndefined();
      expect(c.bytes).toBe(60);
      c.set("huge", "h", 500);
      expect(c.size).toBe(1);
      expect(c.get("huge")).toBe("h");
   });
   it("counts a size given later, and a replaced or deleted entry's bytes go", () => {
      const c = lru<string>({ maxEntries: 10, maxBytes: 100 });
      c.set("a", "a");
      c.set("b", "b", 40);
      c.resize("a", 70);
      expect(c.get("a")).toBeUndefined();
      expect(c.get("b")).toBe("b");
      c.set("b", "b2", 10);
      expect(c.bytes).toBe(10);
      c.delete("b");
      expect(c.bytes).toBe(0);
      expect(c.size).toBe(0);
   });
});
