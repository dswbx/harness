import { describe, expect, it } from "vitest";
import type { Event, EventKind, LineComment } from "../generated";
import { activeCommentCount, anchorLine, lineCommentsOf } from "./comments";

let seq = 0;
const ev = (kind: EventKind): Event => ({
   v: 1,
   seq: seq++,
   session_id: "s",
   thread_id: null,
   ts_ms: 0,
   kind,
});
const c = (id: string, by: "user" | "agent" = "user"): LineComment => ({
   id,
   path: "a.ts",
   line: 3,
   side: "new",
   code: "x",
   text: `t${id}`,
   by,
});

describe("lineCommentsOf", () => {
   it("user comments start pending, Agent comments open", () => {
      const s = lineCommentsOf([
         ev({ type: "CommentAdded", comment: c("c1") }),
         ev({ type: "CommentAdded", comment: c("c2", "agent") }),
      ]);
      expect(s.map((x) => x.status)).toEqual(["pending", "open"]);
   });
   it("edit only changes pending, sent marks open, resolve records who and the note", () => {
      const s = lineCommentsOf([
         ev({ type: "CommentAdded", comment: c("c1") }),
         ev({ type: "CommentEdited", id: "c1", text: "new" }),
         ev({ type: "CommentsSent", ids: ["c1"] }),
         ev({ type: "CommentEdited", id: "c1", text: "late" }),
         ev({ type: "CommentResolved", id: "c1", by: "agent", note: "done" }),
      ]);
      expect(s[0]).toMatchObject({
         text: "new",
         status: "resolved",
         resolvedBy: "agent",
         note: "done",
      });
   });
   it("delete removes; unrelated events keep the same list", () => {
      const a = lineCommentsOf([ev({ type: "CommentAdded", comment: c("c1") })]);
      expect(
         lineCommentsOf([
            ev({ type: "CommentAdded", comment: c("c1") }),
            ev({ type: "CommentDeleted", id: "c1" }),
         ]),
      ).toEqual([]);
      expect(a.length).toBe(1);
   });
   it("counts pending and open", () => {
      const s = lineCommentsOf([
         ev({ type: "CommentAdded", comment: c("c1") }),
         ev({ type: "CommentAdded", comment: c("c2", "agent") }),
         ev({ type: "CommentResolved", id: "c2", by: "user" }),
      ]);
      expect(activeCommentCount(s)).toBe(1);
   });
});

describe("anchorLine", () => {
   const lines = ["a", "b", "x", "d", "x", "f"];
   it("keeps a matching line", () =>
      expect(anchorLine(lines, 3, "x")).toEqual({ line: 3, outdated: false }));
   it("finds the nearest match", () => {
      expect(anchorLine(lines, 4, "x")).toEqual({ line: 3, outdated: false });
      expect(anchorLine(lines, 6, "x")).toEqual({ line: 5, outdated: false });
   });
   it("outdated when gone, unknown when not loaded", () => {
      expect(anchorLine(lines, 2, "zzz")).toEqual({ line: 2, outdated: true });
      expect(anchorLine(null, 2, "zzz")).toEqual({ line: 2, outdated: false });
   });
});
