import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../generated";
import {
   childrenOf,
   dueCount,
   isOverdue,
   localDay,
   openCount,
   topicProgress,
   upstreamId,
   webLink,
} from "./tasks";

const t = (
   id: string,
   status: TaskStatus,
   due: string | null = null,
   parent_id: string | null = null,
   order = 1,
) => ({ id, status, due, parent_id, order });

describe("due and open counts", () => {
   const today = "2026-11-18";
   const tasks = [
      t("t1", "todo", "2026-11-17"),
      t("t2", "in_progress", "2026-11-18"),
      t("t3", "todo", "2026-11-19"),
      t("t4", "done", "2026-11-01"),
      t("t5", "cancelled", "2026-11-01"),
      t("t6", "blocked"),
   ];

   it("counts open Tasks due today or before", () => {
      expect(dueCount(tasks, today)).toBe(2);
   });

   it("counts open Tasks", () => {
      expect(openCount(tasks)).toBe(4);
   });

   it("is overdue only before today", () => {
      expect(isOverdue("2026-11-17", today)).toBe(true);
      expect(isOverdue("2026-11-18", today)).toBe(false);
      expect(isOverdue(null, today)).toBe(false);
   });

   it("formats a local day", () => {
      expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
   });
});

describe("topics", () => {
   const tasks = [
      t("t1", "todo"),
      t("t2", "done", null, "t1", 2),
      t("t3", "todo", null, "t1", 1),
      t("t4", "cancelled", null, "t1", 3),
      t("t5", "todo", null, "t3"),
   ];

   it("lists children by order", () => {
      expect(childrenOf(tasks, "t1").map((x) => x.id)).toEqual(["t3", "t2", "t4"]);
      expect(childrenOf(tasks, null).map((x) => x.id)).toEqual(["t1"]);
   });

   it("counts direct children without cancelled ones", () => {
      expect(topicProgress(tasks, "t1")).toEqual({ done: 1, total: 2 });
      expect(topicProgress(tasks, "t5")).toEqual({ done: 0, total: 0 });
   });
});

describe("upstreamId", () => {
   it.each([
      ["https://linear.app/acme/issue/ABC-123/fix-login", "ABC-123"],
      ["https://linear.app/acme/issue/abc-7", "ABC-7"],
      ["https://github.com/dswbx/harness/issues/42", "#42"],
      ["https://github.com/dswbx/harness/pull/190#discussion", "#190"],
      ["https://github.com/dswbx/harness", null],
      ["https://example.com/issue/ABC-1", null],
      ["not a url", null],
   ])("%s", (url, id) => {
      expect(upstreamId(url)).toBe(id);
   });
});

describe("webLink", () => {
   it.each([
      ["https://linear.app/x/issue/ABC-1", "https://linear.app/x/issue/ABC-1"],
      [" HTTP://localhost:3000/a ", "HTTP://localhost:3000/a"],
      ["linear.app/x/issue/ABC-1", "https://linear.app/x/issue/ABC-1"],
      ["localhost:3000/a", "https://localhost:3000/a"],
      ["javascript:alert(1)", null],
      ["file:///etc/passwd", null],
      ["ftp://x", null],
      ["https://", null],
      ["https:// a", null],
      ["two words", null],
      ["  ", null],
   ])("%s", (input, out) => {
      expect(webLink(input)).toBe(out);
   });
});
