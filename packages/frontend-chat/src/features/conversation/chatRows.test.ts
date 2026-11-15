import type { Event, EventKind } from "@harness/api";
import { describe, expect, it } from "vitest";
import { type Item, initialState } from "../../state/reducer";
import { reduce } from "../renderUi/chatReducer";
import { splitRenderUi } from "../renderUi/slots";
import { chatRows, chatRowsOf, renderUiOf, stabilizeRows } from "./chatRows";

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

   it("a pending approval stands in for any linked step, an Agent's tool call too", () => {
      expect(
         rowIds([
            tool("t1", { kind: "execute", status: "pending" }),
            perm("p1", { stepId: "t1", toolCall: { toolCallId: "t1", kind: "execute" } }),
         ]),
      ).toEqual(["p1"]);
      const rows = chatRows(
         [tool("t1", { kind: "execute" }), perm("p1", { stepId: "t1" })],
         splitRenderUi([]),
      ).rows;
      expect(rows[0]).toMatchObject({ type: "permission", step: { id: "t1" } });
   });

   it("a pending approval without a step hides nothing", () => {
      expect(
         rowIds([
            tool("t1", { harnessTool: "git_status" }),
            tool("t2", { harnessTool: "git_commit" }),
            perm("p2", { harnessTool: "git_commit" }),
         ]),
      ).toEqual(["tools:t1+t2", "p2"]);
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

describe("stabilizeRows", () => {
   const rowsOf = (items: Item[]) => chatRows(items, splitRenderUi(items));
   const task = tool("task", { subagentPrompt: "do it" });
   const c1 = tool("c1", { parent: "task" });

   it("keeps what did not change: groups, the rows array and the subagents map", () => {
      const items: Item[] = [tool("t1"), tool("t2"), task, c1];
      const a = stabilizeRows(null, rowsOf(items));
      const b = stabilizeRows(a, rowsOf([...items]));
      expect(b.rows).toBe(a.rows);
      expect(b.subagents).toBe(a.subagents);
   });
   it("a new step makes a new group and leaves the others as they were", () => {
      const items: Item[] = [tool("t1"), { type: "user", id: "u", text: "x" } as Item, tool("t2")];
      const a = stabilizeRows(null, rowsOf(items));
      const b = stabilizeRows(a, rowsOf([...items, tool("t3")]));
      expect(b.rows).not.toBe(a.rows);
      expect(b.rows[0]).toBe(a.rows[0]);
      expect(b.rows[1]).toBe(a.rows[1]);
      expect(b.rows[2]).not.toBe(a.rows[2]);
      expect((b.rows[2] as { steps: unknown[] }).steps).toHaveLength(2);
   });
   it("a changed call replaces its group and its subagent, not the other subagents", () => {
      const other = tool("other", { subagentPrompt: "x" });
      const o1 = tool("o1", { parent: "other" });
      const items: Item[] = [task, c1, other, o1];
      const a = stabilizeRows(null, rowsOf(items));
      const c2 = tool("c2", { parent: "task" });
      const b = stabilizeRows(a, rowsOf([...items, c2]));
      expect(b.subagents).not.toBe(a.subagents);
      expect(b.subagents.get("other")).toBe(a.subagents.get("other"));
      expect(b.subagents.get("task")).not.toBe(a.subagents.get("task"));
      expect(b.subagents.get("task")?.calls).toHaveLength(2);
   });
   it("a subagent that goes away is gone", () => {
      const a = stabilizeRows(null, rowsOf([task, c1]));
      const b = stabilizeRows(a, rowsOf([tool("t1")]));
      expect(b.subagents.size).toBe(0);
      expect(b.rows.map((r) => r.id)).toEqual(["t1"]);
   });
});
