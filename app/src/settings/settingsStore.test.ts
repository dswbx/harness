import { describe, expect, it } from "vitest";
import { parseFrame, parseSection } from "./settingsStore";

describe("parseSection", () => {
   it("keeps a known section", () => expect(parseSection("agents")).toBe("agents"));
   it("unset or unknown is appearance", () => {
      expect(parseSection(null)).toBe("appearance");
      expect(parseSection("nope")).toBe("appearance");
   });
});

describe("parseFrame", () => {
   it("reads a box", () =>
      expect(parseFrame('{"x":1,"y":2,"w":700,"h":500}')).toEqual({ x: 1, y: 2, w: 700, h: 500 }));
   it("bad data is null", () => {
      expect(parseFrame(null)).toBeNull();
      expect(parseFrame("{bad")).toBeNull();
      expect(parseFrame('{"x":1,"y":2,"w":"7"}')).toBeNull();
      expect(parseFrame("null")).toBeNull();
   });
});
