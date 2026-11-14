import type { SharedArtifactEntry } from "@harness/api";
import { describe, expect, it } from "vitest";
import { hasChanged, isSharedSeen, markSeen, visibleShared } from "./sharedSection";

const entry = (id: string, title: string, updated_ms: number): SharedArtifactEntry =>
   ({
      meta: {
         id,
         title,
         kind: "md",
         created_ms: 0,
         updated_ms,
         created_by: { session_id: "s1", session_title: "S" },
         attached: [],
      },
   }) as unknown as SharedArtifactEntry;

describe("visibleShared", () => {
   const list = [
      entry("a", "Release checklist", 10),
      entry("b", "Roadmap", 30),
      entry("c", "Notes", 20),
   ];

   it("sorts by updated, newest first", () => {
      expect(visibleShared(list, "").map((e) => e.meta.id)).toEqual(["b", "c", "a"]);
   });

   it("filters by title, case-insensitive, trimmed", () => {
      expect(visibleShared(list, "  RE ").map((e) => e.meta.id)).toEqual(["a"]);
      expect(visibleShared(list, "o").map((e) => e.meta.id)).toEqual(["b", "c"]);
      expect(visibleShared(list, "zzz")).toEqual([]);
   });

   it("does not change the input", () => {
      visibleShared(list, "");
      expect(list.map((e) => e.meta.id)).toEqual(["a", "b", "c"]);
   });
});

describe("change dot", () => {
   const seen = { since: 100, seen: { a: 50 } };

   it("shows when updated after last seen, or after `since` for unseen ids", () => {
      expect(hasChanged(entry("a", "A", 60), seen, null)).toBe(true);
      expect(hasChanged(entry("a", "A", 50), seen, null)).toBe(false);
      expect(hasChanged(entry("b", "B", 90), seen, null)).toBe(false);
      expect(hasChanged(entry("b", "B", 110), seen, null)).toBe(true);
   });

   it("hides on the open artifact", () => {
      expect(hasChanged(entry("a", "A", 60), seen, "a")).toBe(false);
   });

   it("markSeen records the newer time, keeps the object when nothing changes", () => {
      const next = markSeen(seen, "a", 60);
      expect(next.seen.a).toBe(60);
      expect(hasChanged(entry("a", "A", 60), next, null)).toBe(false);
      expect(markSeen(next, "a", 60)).toBe(next);
      expect(markSeen(seen, "b", 90)).toBe(seen);
   });

   it("validates the stored value", () => {
      expect(isSharedSeen(seen)).toBe(true);
      expect(isSharedSeen({ since: 1 })).toBe(false);
      expect(isSharedSeen(null)).toBe(false);
      expect(isSharedSeen("x")).toBe(false);
   });
});
