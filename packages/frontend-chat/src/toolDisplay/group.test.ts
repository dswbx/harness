import { describe, expect, it } from "vitest";
import type { Item } from "../reducer";
import { type ChatSubagent, groupTools, placeSteps, type Tool } from "./group";

const tool = (id: string): Tool => ({
   type: "tool",
   id,
   title: id,
   kind: null,
   status: "completed",
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
});
const thought = (id: string) => ({ type: "thought", id, text: id, ts: 0 }) as Item;
const agent = (id: string) => ({ type: "agent", id, text: id }) as unknown as Item;

describe("groupTools", () => {
   it("folds runs of tool calls and thoughts, keyed by the first step", () => {
      const out = groupTools([
         thought("t"),
         tool("a"),
         tool("b"),
         agent("m"),
         tool("c"),
         thought("u"),
      ]);
      expect(
         out.map((r) =>
            r.type === "tools" ? `${r.id}:${r.steps.map((c) => c.id).join(",")}` : r.id,
         ),
      ).toEqual(["t:t,a,b", "m", "c:c,u"]);
   });
});

describe("placeSteps", () => {
   const sub = (steps: Item[]): ChatSubagent => ({
      calls: steps.filter((s): s is Tool => s.type === "tool"),
      steps,
      report: null,
      endedAt: null,
   });
   it("maps each step, and subagent steps (nested too), to its row and path", () => {
      const rows = groupTools([tool("a"), tool("task"), agent("m"), tool("b")]);
      const subagents = new Map([
         ["task", sub([thought("st"), tool("inner"), agent("sm")])],
         ["inner", sub([tool("deep")])],
      ]);
      const m = placeSteps(rows, subagents);
      expect(m.get("a")).toEqual({ row: "a", path: ["a"] });
      expect(m.get("task")).toEqual({ row: "a", path: ["task"] });
      expect(m.get("st")).toEqual({ row: "a", path: ["task", "st"] });
      expect(m.get("inner")).toEqual({ row: "a", path: ["task", "inner"] });
      expect(m.get("deep")).toEqual({ row: "a", path: ["task", "inner", "deep"] });
      expect(m.get("b")).toEqual({ row: "b", path: ["b"] });
      expect(m.has("m")).toBe(false);
      expect(m.has("sm")).toBe(false);
   });
});
