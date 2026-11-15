import { describe, expect, it } from "vitest";
import { splitDetails } from "./errors";

describe("splitDetails", () => {
   it("keeps single-line text as head", () => {
      expect(splitDetails("boom")).toEqual({ head: "boom", details: null });
   });
   it("puts everything after the first blank line into details, newlines preserved", () => {
      const r = splitDetails(
         "Agent failed to start\nexit 1\n\nAgent output (stderr):\nline a\n\nline b\n",
      );
      expect(r.head).toBe("Agent failed to start\nexit 1");
      expect(r.details).toBe("Agent output (stderr):\nline a\n\nline b");
   });
});
