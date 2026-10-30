import { describe, expect, it } from "vitest";
import type { Item } from "../reducer";
import { groupTools, type Tool } from "./group";

const tool = (id: string): Tool => ({
  type: "tool", id, title: id, kind: null, status: "completed", content: [], locations: null,
  rawInput: null, rawOutput: null, parent: null, background: false, report: null, harnessTool: null,
});
const agent = (id: string) => ({ type: "agent", id, text: id }) as unknown as Item;

describe("groupTools", () => {
  it("folds runs of tool calls, keyed by the first call", () => {
    const out = groupTools([tool("a"), tool("b"), agent("m"), tool("c")]);
    expect(out.map((r) => (r.type === "tools" ? `${r.id}:${r.calls.map((c) => c.id).join(",")}` : r.id))).toEqual(["a:a,b", "m", "c:c"]);
  });
});
