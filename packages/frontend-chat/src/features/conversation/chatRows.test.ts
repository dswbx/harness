import type { Event, EventKind } from "@harness/api";
import { describe, expect, it } from "vitest";
import { type Item, initialState } from "../../state/reducer";
import { reduce } from "../renderUi/chatReducer";
import { splitRenderUi } from "../renderUi/slots";
import { chatRows, chatRowsOf, renderUiOf } from "./chatRows";

type Tool = Extract<Item, { type: "tool" }>;
type Perm = Extract<Item, { type: "permission" }>;

const tool = (id: string, over: Partial<Tool> = {}): Tool => ({
   type: "tool",
   id,
   title: id,
   kind: null,
   status: null,
   content: [],
   locations: null,
   rawInput: null,
   rawOutput: null,
   parent: null,
   background: false,
   report: null,
   harnessTool: null,
   subagentPrompt: null,
   subagentMeta: null,
   ts: 0,
   endedAt: null,
   commitMessage: null,
   ...over,
});
const perm = (id: string, over: Partial<Perm> = {}): Perm => ({
   type: "permission",
   id,
   requestId: id,
   toolCall: { id: "x", title: "x" } as never,
   harnessTool: null,
   plan: null,
   commitMessage: null,
   frontendTool: null,
   stepId: null,
   options: [],
   resolved: false,
   ...over,
});
const agent = (id: string, parent: string | null = null): Item => ({
   type: "agent",
   id,
   text: id,
   ts: 0,
   parent,
});

const rowIds = (items: Item[], ui = splitRenderUi(items)) =>
   chatRows(items, ui).rows.map((r) =>
      r.type === "tools" ? `tools:${r.steps.map((s) => s.id).join("+")}` : r.id,
   );

describe("chatRows", () => {
   it("keeps ordinary items and groups consecutive tool calls", () => {
      expect(rowIds([agent("a"), tool("t1"), tool("t2"), agent("b")])).toEqual([
         "a",
         "tools:t1+t2",
         "b",
      ]);
   });

   it("hides a resolved permission, keeps a pending one", () => {
      expect(rowIds([perm("p1", { resolved: true }), perm("p2")])).toEqual(["p2"]);
   });

   it("keeps a resolved plan: its row records the answer", () => {
      expect(rowIds([perm("p1", { resolved: true, plan: "# plan" })])).toEqual(["p1"]);
   });

   it("keeps a resolved permission that the policy answered, when it has no step", () => {
      expect(
         rowIds([perm("p1", { resolved: true, auto: { allowed: true, ruleId: null } })]),
      ).toEqual(["p1"]);
   });

   it("hides an auto permission that has a step (the step shows the note)", () => {
      expect(
         rowIds([
            tool("t1"),
            perm("p1", { auto: { allowed: true, ruleId: "r" }, stepId: "t1", resolved: true }),
            perm("p2", { auto: { allowed: false, ruleId: null }, stepId: "t1" }),
         ]),
      ).toEqual(["tools:t1"]);
   });

   it("a pending git approval stands in for its step", () => {
      expect(
         rowIds([
            tool("t1", { harnessTool: "git_commit" }),
            perm("p1", { stepId: "t1", harnessTool: "git_commit" }),
         ]),
      ).toEqual(["p1"]);
      expect(
         rowIds([
            tool("t1", { harnessTool: "git_push" }),
            perm("p1", { stepId: "t1", harnessTool: "git_push" }),
         ]),
      ).toEqual(["p1"]);
   });

   it("once the git approval is answered, the step shows again", () => {
      expect(
         rowIds([
            tool("t1", { harnessTool: "git_commit" }),
            perm("p1", { stepId: "t1", harnessTool: "git_commit", resolved: true }),
         ]),
      ).toEqual(["tools:t1"]);
   });

   it("a pending approval of another Harness tool or without a step hides nothing", () => {
      expect(
         rowIds([
            tool("t1", { harnessTool: "git_status" }),
            perm("p1", { stepId: "t1", harnessTool: "git_status" }),
            tool("t2", { harnessTool: "git_commit" }),
            perm("p2", { harnessTool: "git_commit" }),
         ]),
      ).toEqual(["tools:t1", "p1", "tools:t2", "p2"]);
   });

   describe("render_ui items", () => {
      let seq = 0;
      const ev = (kind: EventKind): Event => ({
         v: 1,
         seq: seq++,
         session_id: "s",
         thread_id: "main",
         ts_ms: 0,
         kind,
      });
      const md = (text: string) => ({ type: "Markdown", props: { text } });
      const ui = (input: Record<string, unknown>) =>
         ev({
            type: "FrontendToolOutput",
            tool: "render_ui",
            call_id: `c${seq}`,
            path: "p",
            input,
         });
      const fold = (events: Event[]) => events.reduce(reduce, initialState()).items;

      it("moves slot, replaced and removed items out of the rows; inline stays", () => {
         const items = fold([
            ui({ root: md("plain") }),
            ui({ id: "q", root: md("q1") }),
            ui({ id: "q", root: md("q2") }),
            ui({ id: "side", placement: "right", title: "S", root: md("s") }),
            ui({ id: "top", placement: "top", root: md("t") }),
            ui({ id: "gone", root: md("g") }),
            ui({ id: "gone", remove: true }),
         ]);
         const ids = items.map((i) => i.id);
         // plain and the first "q" (shown where it first appeared, with the latest content).
         expect(rowIds(items)).toEqual([ids[0], ids[1]]);
      });
   });

   describe("subagent calls", () => {
      it("nest under their Task call instead of being rows", () => {
         const items: Item[] = [
            tool("task", { subagentPrompt: "do it" }),
            tool("c1", { parent: "task" }),
            agent("a1", "task"),
            agent("a2"),
         ];
         const r = chatRows(items, splitRenderUi(items));
         expect(r.rows.map((x) => x.id)).toEqual(["task", "a2"]);
         expect(r.subagents.get("task")?.steps.map((s) => s.id)).toEqual(["c1", "a1"]);
      });
   });

   it("a hidden step does not break a run of tool calls", () => {
      const items = [tool("t1"), perm("p1", { resolved: true }), tool("t2")];
      expect(rowIds(items)).toEqual(["tools:t1+t2"]);
   });
});

describe("shared computation", () => {
   it("two callers with the same items and attached get one result", () => {
      const items: Item[] = [
         tool("task", { subagentPrompt: "do it" }),
         tool("c1", { parent: "task" }),
      ];
      const a = chatRowsOf(items, renderUiOf(items, undefined));
      const b = chatRowsOf(items, renderUiOf(items, undefined));
      expect(b).toBe(a);
   });
   it("recomputes for other items, or another attached list", () => {
      const items: Item[] = [tool("t1")];
      const a = chatRowsOf(items, renderUiOf(items, []));
      expect(chatRowsOf(items, renderUiOf(items, [{ id: "x", ts: 1 }]))).not.toBe(a);
      const other = [...items];
      expect(chatRowsOf(other, renderUiOf(other, []))).not.toBe(a);
   });
});
