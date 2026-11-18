import { describe, expect, it } from "vitest";
import { type Nav, navPush, navTarget } from "./useNavHistory";

const key = (s: string | null) => s ?? "";
const ok = (s: string | null) => s !== null;
const start: Nav<string | null> = { entries: [null], index: 0 };

describe("nav history", () => {
   it("push appends, skips the same entry, and drops forward entries", () => {
      let n = navPush(start, "a", key);
      n = navPush(n, "a", key);
      n = navPush(n, "b", key);
      expect(n).toEqual({ entries: [null, "a", "b"], index: 2 });
      n = navPush({ ...n, index: 1 }, "c", key);
      expect(n).toEqual({ entries: [null, "a", "c"], index: 2 });
   });

   it("target skips entries that cannot be shown and the current one", () => {
      const n: Nav<string | null> = { entries: [null, "a", "gone", "a", "b"], index: 4 };
      const live = (s: string | null) => ok(s) && s !== "gone";
      expect(navTarget(n, -1, live, key)).toBe(3);
      expect(navTarget({ ...n, index: 3 }, -1, live, key)).toBe(null);
      expect(navTarget({ ...n, index: 3 }, 1, live, key)).toBe(4);
      expect(navTarget(n, 1, live, key)).toBe(null);
   });
});
