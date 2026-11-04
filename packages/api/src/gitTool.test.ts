import { describe, expect, it } from "vitest";
import { gitToolSummary } from "./gitTool";

const blocks = (text: string) => [{ type: "text", text }];
const content = (text: string) => [{ type: "content", content: { type: "text", text } }];
const hex = "a".repeat(40);

describe("gitToolSummary", () => {
   it("null for other tools", () => {
      expect(gitToolSummary("render_ui", {}, null)).toBeNull();
      expect(gitToolSummary(null, {}, null)).toBeNull();
   });

   it("commit: subject, body, short hash", () => {
      expect(
         gitToolSummary(
            "git_commit",
            { message: "Fix it\n\nBecause." },
            blocks(`Committed ${hex}`),
         ),
      ).toEqual({ subject: "Fix it", body: "Because.", hash: "aaaaaaa" });
      expect(
         gitToolSummary("git_commit", { message: "Fix" }, null, content(`Committed ${hex}`)),
      ).toEqual({
         subject: "Fix",
         hash: "aaaaaaa",
      });
      expect(gitToolSummary("git_commit", {}, null)).toEqual({});
   });

   it("push: branch, also from content", () => {
      expect(gitToolSummary("git_push", {}, blocks("Pushed harness/x-1."))).toEqual({
         branch: "harness/x-1",
      });
      expect(gitToolSummary("git_push", {}, "Pushed main.")).toEqual({ branch: "main" });
      expect(gitToolSummary("git_push", {}, blocks("Pushed."))).toEqual({});
   });

   it("failure: first line, fences stripped, string or blocks", () => {
      expect(
         gitToolSummary(
            "git_push",
            {},
            "The operation timed out.",
            content("```\nThe operation timed out.\n```"),
         ),
      ).toEqual({ error: "The operation timed out." });
      expect(
         gitToolSummary(
            "git_commit",
            { message: "x" },
            null,
            content("```\nthe user denied this\nmore\n```"),
         ),
      ).toEqual({
         subject: "x",
         error: "the user denied this",
      });
   });

   it("status: branch and changed count", () => {
      const out = JSON.stringify(
         { branch: "main", upstream: null, ahead: 0, behind: 0, files: [{}, {}] },
         null,
         2,
      );
      expect(gitToolSummary("git_status", {}, blocks(out))).toEqual({ branch: "main", changed: 2 });
      expect(gitToolSummary("git_status", {}, blocks("nope"))).toEqual({});
   });

   it("diff: range and line counts", () => {
      const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-x\n+y\n+z\n";
      expect(gitToolSummary("git_diff", {}, blocks(patch))).toEqual({
         range: "working tree",
         additions: 2,
         deletions: 1,
      });
      expect(
         gitToolSummary("git_diff", { from: "main", to: "HEAD" }, blocks("No changes.")),
      ).toEqual({
         range: "main..HEAD",
         additions: 0,
         deletions: 0,
      });
      expect(gitToolSummary("git_diff", {}, null)).toEqual({ range: "working tree" });
   });

   it("list_branches: count", () => {
      expect(gitToolSummary("list_branches", {}, blocks('[{"name":"a"},{"name":"b"}]'))).toEqual({
         count: 2,
      });
      expect(gitToolSummary("list_branches", {}, blocks("x"))).toEqual({});
   });
});
