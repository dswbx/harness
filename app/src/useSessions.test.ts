import type { SessionSummary } from "@harness/api";
import { describe, expect, it } from "vitest";
import { applyStatus } from "./useSessions";

const s = (id: string, over: Partial<SessionSummary> = {}) =>
   ({ id, title: `t-${id}`, status: "idle", updated_ms: 1, ...over }) as SessionSummary;

describe("applyStatus", () => {
   it("patches status, title and activity of one row only", () => {
      const list = [s("a"), s("b")];
      const next = applyStatus(
         list,
         { type: "SessionStatus", session_id: "b", title: "new", status: "working" },
         99,
      );
      expect(next?.[0]).toBe(list[0]);
      expect(next?.[1]).toMatchObject({ id: "b", title: "new", status: "working", updated_ms: 99 });
   });
   it("returns null for an unknown Session", () => {
      expect(
         applyStatus(
            [s("a")],
            { type: "SessionStatus", session_id: "x", title: "n", status: "idle" },
            1,
         ),
      ).toBeNull();
   });
});
