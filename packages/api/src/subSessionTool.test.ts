import { describe, expect, it } from "vitest";
import { subSessionToolSummary } from "./subSessionTool";

const call = (
   harnessTool: string | null,
   rawInput: unknown,
   rawOutput: unknown,
   content?: unknown,
) => subSessionToolSummary({ harnessTool, rawInput, rawOutput, content });
const blocks = (v: unknown) => [{ type: "text", text: JSON.stringify(v, null, 2) }];
const content = (v: unknown) => [
   { type: "content", content: { type: "text", text: JSON.stringify(v) } },
];

describe("subSessionToolSummary", () => {
   it("null for other tools", () => {
      expect(call("git_push", {}, null)).toBeNull();
      expect(call(null, {}, null)).toBeNull();
   });

   it("start: input and JSON result, repo as folder name", () => {
      expect(
         call(
            "session_start",
            { prompt: "Fix the docs", folder: "/w/docs", title: "ignored" },
            blocks({
               session_id: "s2",
               title: "Docs fix",
               folder: "/w/.worktrees/docs-1",
               repo: "/w/docs",
               branch: "harness/docs-1",
               model: "opus",
               effort: "high",
            }),
         ),
      ).toEqual({
         sessionId: "s2",
         title: "Docs fix",
         repo: "docs",
         branch: "harness/docs-1",
         model: "opus",
         effort: "high",
         prompt: "Fix the docs",
      });
   });

   it("start running: only the input", () => {
      expect(
         call("session_start", { prompt: "Go", folder: "/w/api/", title: "API", model: "m" }, null),
      ).toEqual({ title: "API", repo: "api", model: "m", prompt: "Go" });
   });

   it("send: id, title, message; also from content", () => {
      expect(
         call(
            "session_send",
            { id: "s2", text: "More" },
            null,
            content({ session_id: "s2", title: "T" }),
         ),
      ).toEqual({ sessionId: "s2", title: "T", text: "More" });
      expect(call("session_send", { id: "s2", text: "More" }, null)).toEqual({
         sessionId: "s2",
         text: "More",
      });
   });

   it("wait: reply, duration, status, stop reason", () => {
      expect(
         call(
            "session_wait",
            { id: "s2" },
            blocks({
               session_id: "s2",
               title: "T",
               status: "idle",
               stop_reason: "end_turn",
               duration_ms: 4200,
               reply: "Done.",
            }),
         ),
      ).toEqual({
         sessionId: "s2",
         title: "T",
         status: "idle",
         stopReason: "end_turn",
         durationMs: 4200,
         reply: "Done.",
      });
      expect(call("session_wait", { id: "s2" }, null)).toEqual({ sessionId: "s2" });
   });

   it("failure: first line of the fenced text", () => {
      expect(
         call(
            "session_send",
            { id: "s2", text: "x" },
            '```\nSub Session "T" is still working. Call session_wait first.\n```',
         ),
      ).toEqual({
         sessionId: "s2",
         text: "x",
         error: 'Sub Session "T" is still working. Call session_wait first.',
      });
   });
});
