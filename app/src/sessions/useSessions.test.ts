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
         {
            type: "SessionStatus",
            session_id: "b",
            title: "new",
            status: "working",
            unused: false,
            unseen: false,
         },
         99,
      );
      expect(next?.[0]).toBe(list[0]);
      expect(next?.[1]).toMatchObject({ id: "b", title: "new", status: "working", updated_ms: 99 });
   });
   it("patches `unused` (a prompt was sent)", () => {
      const next = applyStatus(
         [s("a", { unused: true })],
         {
            type: "SessionStatus",
            session_id: "a",
            title: "t-a",
            status: "idle",
            unused: false,
            unseen: false,
         },
         1,
      );
      expect(next?.[0]?.unused).toBe(false);
   });
   it("patches `unseen`; clearing it alone is not activity", () => {
      const ev = {
         type: "SessionStatus",
         session_id: "a",
         title: "t-a",
         status: "idle",
         unused: false,
      } as const;
      const marked = applyStatus([s("a", { unused: false })], { ...ev, unseen: true }, 5);
      expect(marked?.[0]).toMatchObject({ unseen: true, updated_ms: 5 });
      const seen = applyStatus(marked ?? [], { ...ev, unseen: false }, 9);
      expect(seen?.[0]).toMatchObject({ unseen: false, updated_ms: 5 });
   });
   it("returns null for an unknown Session", () => {
      expect(
         applyStatus(
            [s("a")],
            {
               type: "SessionStatus",
               session_id: "x",
               title: "n",
               status: "idle",
               unused: false,
               unseen: false,
            },
            1,
         ),
      ).toBeNull();
   });
});
