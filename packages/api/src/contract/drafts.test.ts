import { describe, expect, it } from "vitest";
import { draftKey, draftStorageKey, parseDraftKey } from "./drafts";

describe("draft keys (stored in localStorage: the format is pinned)", () => {
   it("Main Thread is the Session id, a Side Thread is sessionId#threadId", () => {
      expect(draftKey("s1", null)).toBe("s1");
      expect(draftKey("s1", "t9")).toBe("s1#t9");
      expect(draftStorageKey(draftKey("s1", "t9"))).toBe("harness.draft.s1#t9");
   });
   it("parses back", () => {
      expect(parseDraftKey("s1")).toEqual({ sessionId: "s1", threadId: null });
      expect(parseDraftKey("s1#t9")).toEqual({ sessionId: "s1", threadId: "t9" });
   });
});
