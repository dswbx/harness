import { describe, expect, it } from "vitest";
import { baseName } from "./paths";

describe("baseName", () => {
   it("the last segment, for / and \\ separators", () => {
      expect(baseName("/Users/me/shot.PNG")).toBe("shot.PNG");
      expect(baseName("C:\\Users\\me\\notes.md")).toBe("notes.md");
      expect(baseName("notes.md")).toBe("notes.md");
   });

   it("ignores trailing separators; falls back to the path", () => {
      expect(baseName("/Users/me/project/")).toBe("project");
      expect(baseName("/")).toBe("/");
      expect(baseName("")).toBe("");
   });
});
