import { describe, expect, it } from "vitest";
import { clamp, cn } from "./utils";

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

describe("cn", () => {
   it("keeps our font sizes next to a text color", () => {
      expect(cn("text-ui-xl", "text-emerald-600")).toBe("text-ui-xl text-emerald-600");
      expect(cn("text-ui-sm text-muted-foreground")).toBe("text-ui-sm text-muted-foreground");
   });
   it("still merges two font sizes", () => {
      expect(cn("text-ui-sm", "text-ui-xl")).toBe("text-ui-xl");
   });
});
