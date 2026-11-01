import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "@harness/api";
import { initialState, reduce } from "./reducer";
import { splitRenderUi } from "./slots";

let seq = 0;
const ev = (kind: EventKind): Event => ({ v: 1, seq: seq++, session_id: "s", thread_id: "main", ts_ms: 0, kind });
const md = (text: string) => ({ type: "Markdown", props: { text } });
const ui = (input: Record<string, unknown>) => ev({ type: "FrontendToolOutput", tool: "render_ui", call_id: `c${seq}`, path: "p", input });
const fold = (events: Event[]) => events.reduce(reduce, initialState());

describe("render_ui placements", () => {
  it("routes slots, replaces by id, removes, and keeps inline ids in place", () => {
    const s = fold([
      ui({ root: md("plain") }),
      ui({ id: "q", root: md("question 1") }),
      ui({ id: "score", placement: "bottom", root: md("0") }),
      ui({ id: "notes", placement: "right", title: "Notes", root: md("n") }),
      ui({ id: "q", root: md("question 2") }),
      ui({ id: "score", placement: "bottom", root: md("1") }),
      ui({ id: "notes", remove: true }),
    ]);
    const rows = s.items.map((i) => i.id);
    const { inline, slots } = splitRenderUi(s.items);
    expect(inline.has(rows[0]!)).toBe(false);
    expect(inline.get(rows[1]!)?.root).toEqual(md("question 2"));
    expect(inline.get(rows[4]!)).toBeNull();
    expect([rows[2], rows[3], rows[5], rows[6]].every((r) => inline.get(r!) === null)).toBe(true);
    expect(slots.bottom.map((x) => [x.id, x.root])).toEqual([["score", md("1")]]);
    expect(slots.right).toEqual([]);
  });

  it("collects left and right items apart, in first-seen order", () => {
    const s = fold([
      ui({ id: "a", placement: "left", title: "A", root: md("a") }),
      ui({ id: "b", placement: "right", title: "B", root: md("b") }),
      ui({ id: "c", placement: "left", title: "C", root: md("c") }),
      ui({ id: "a", placement: "left", title: "A", root: md("a2") }),
    ]);
    const { slots } = splitRenderUi(s.items);
    expect(slots.left.map((x) => [x.id, x.root])).toEqual([["a", md("a2")], ["c", md("c")]]);
    expect(slots.right.map((x) => x.id)).toEqual(["b"]);
  });

  it("moves an id between placements", () => {
    const s = fold([ui({ id: "x", root: md("a") }), ui({ id: "x", placement: "top", root: md("b") })]);
    const { inline, slots } = splitRenderUi(s.items);
    expect(inline.get(s.items[0]!.id)).toBeNull();
    expect(slots.top.map((x) => x.root)).toEqual([md("b")]);
  });

  it("rebuilds the Session State from StateChanged on any Thread", () => {
    const s = fold([
      ev({ type: "ThreadStarted", agent_id: "a", main: true }),
      ev({ type: "StateChanged", ops: [{ op: "add", path: "/quiz/score", value: 1 }], by: "agent" }),
      { ...ev({ type: "StateChanged", ops: [{ op: "add", path: "/quiz/answers/q1", value: "b" }], by: "user" }), thread_id: "side" },
    ]);
    expect(s.uiState).toEqual({ quiz: { score: 1, answers: { q1: "b" } } });
  });
});
