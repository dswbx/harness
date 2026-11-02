import { describe, expect, it } from "vitest";
import type { Item } from "../reducer";
import { groupTools, type Tool } from "./group";

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
