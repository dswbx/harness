import { describe, expect, it } from "vitest";
import { clamp } from "./utils";

describe("clamp", () => {
   it("keeps a value inside the range", () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-1, 0, 10)).toBe(0);
      expect(clamp(11, 0, 10)).toBe(10);
      expect(clamp(0.5, 0.2, 0.8)).toBe(0.5);
   });

   it("min wins when the range is inverted", () => {
      expect(clamp(5, 10, 0)).toBe(10);
   });
});
