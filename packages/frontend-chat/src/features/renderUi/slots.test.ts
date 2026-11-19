import type { Event, EventKind } from "@harness/api";
import { describe, expect, it, test } from "vitest";
import { initialState } from "../../state/reducer";
import { reduce } from "./chatReducer";
import { lastSlot, nextSeen, type Slot, slotDot, slotToAutoOpen, splitRenderUi } from "./slots";

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
   ev({ type: "FrontendToolOutput", tool: "render_ui", call_id: `c${seq}`, path: "p", input });
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
      expect(slots.left.map((x) => [x.id, x.root])).toEqual([
         ["a", md("a2")],
         ["c", md("c")],
      ]);
      expect(slots.right.map((x) => x.id)).toEqual(["b"]);
   });

   it("moves an id between placements", () => {
      const s = fold([
         ui({ id: "x", root: md("a") }),
         ui({ id: "x", placement: "top", root: md("b") }),
      ]);
      const { inline, slots } = splitRenderUi(s.items);
      expect(inline.get(s.items[0]!.id)).toBeNull();
      expect(slots.top.map((x) => x.root)).toEqual([md("b")]);
   });

   it("rebuilds the Session State from StateChanged on any Thread", () => {
      const s = fold([
         ev({ type: "ThreadStarted", agent_id: "a", main: true }),
         ev({
            type: "StateChanged",
            ops: [{ op: "add", path: "/quiz/score", value: 1 }],
            by: "agent",
         }),
         {
            ...ev({
               type: "StateChanged",
               ops: [{ op: "add", path: "/quiz/answers/q1", value: "b" }],
               by: "user",
            }),
            thread_id: "side",
         },
      ]);
      expect(s.uiState).toEqual({ quiz: { score: 1, answers: { q1: "b" } } });
   });
});

describe("user edits of panels (PanelEdited, PanelDeleted)", () => {
   const edit = (id: string, title: string | null, icon: string | null): Event =>
      ev({ type: "PanelEdited", tool: "render_ui", id, title, icon });
   const del = (id: string): Event => ev({ type: "PanelDeleted", tool: "render_ui", id });
   const split = (s: ReturnType<typeof fold>) =>
      splitRenderUi(s.items, s.sharedAttached, s.panelEdits);
   const panel = (title: string, root = "a") =>
      ui({ id: "p", placement: "right", title, icon: "file", root: md(root) });

   it("an override replaces the title and icon, and survives the Agent sending the id again", () => {
      const s = fold([panel("Agent"), edit("p", "Mine", "star"), panel("Agent 2", "b")]);
      const [p] = split(s).slots.right;
      expect([p!.title, p!.icon, p!.root]).toEqual(["Mine", "star", md("b")]);
      expect(p!.agent).toEqual({ title: "Agent 2", icon: "file" });
   });

   it("overrides each value apart; none left goes back to the Agent's", () => {
      let s = fold([panel("Agent"), edit("p", "Mine", null)]);
      expect(split(s).slots.right.map((x) => [x.title, x.icon])).toEqual([["Mine", "file"]]);
      s = [edit("p", null, null)].reduce(reduce, s);
      const [p] = split(s).slots.right;
      expect([p!.title, p!.icon, p!.agent]).toEqual(["Agent", "file", null]);
   });

   it("a deleted id shows nowhere (inline rows hide too); a later call brings it back with its override", () => {
      const s = fold([
         ui({ id: "q", root: md("inline") }),
         panel("Agent"),
         edit("p", "Mine", null),
         del("p"),
         del("q"),
      ]);
      const { inline, slots } = split(s);
      expect(slots.right).toEqual([]);
      expect(inline.get(s.items[0]!.id)).toBeNull();
      expect(s.panelEdits.deleted).toEqual({ p: true, q: true });
      const back = [panel("Agent again", "c")].reduce(reduce, s);
      expect(back.panelEdits.deleted).toEqual({ q: true });
      expect(split(back).slots.right.map((x) => [x.title, x.root])).toEqual([["Mine", md("c")]]);
   });

   it("ignores overrides for another tool and does not touch a shared panel", () => {
      const s = fold([
         ui({ id: "p", placement: "right", title: "Plan", source: "shared:plan-3f9a1c" }),
         ev({ type: "ArtifactAttached", id: "plan-3f9a1c", by: "user" }),
         edit("p", "Mine", "star"),
         ev({ type: "PanelEdited", tool: "other", id: "x", title: "No", icon: null }),
      ]);
      expect(Object.keys(s.panelEdits.overrides)).toEqual(["p"]);
      const [p] = split(s).slots.right;
      expect([p!.title, p!.icon, p!.agent]).toEqual(["Plan", null, null]);
   });
});

describe("Shared Artifacts in slots (ADR 0024)", () => {
   const attach = (id: string, ts = 5): Event => ({
      ...ev({ type: "ArtifactAttached", id, by: "user" }),
      thread_id: null,
      ts_ms: ts,
   });
   const detach = (id: string): Event => ({
      ...ev({ type: "ArtifactDetached", id, by: "user" }),
      thread_id: null,
   });
   const shared = (s: ReturnType<typeof fold>) => splitRenderUi(s.items, s.sharedAttached);

   it("gives an attached artifact no item shows a right panel of its own", () => {
      const s = fold([attach("map-a1b2c3", 7)]);
      expect(shared(s).slots.right).toEqual([
         {
            id: "shared:map-a1b2c3",
            title: null,
            icon: null,
            root: { type: "Shared", props: { id: "map-a1b2c3" } },
            files: {},
            ts: 7,
            source: "shared:map-a1b2c3",
            agent: null,
         },
      ]);
   });

   it("adds no synthetic panel when an item shows the artifact", () => {
      const s = fold([
         ui({ id: "plan", placement: "right", title: "Plan", source: "plan.md" }),
         ui({ id: "plan", placement: "right", title: "Plan", source: "shared:plan-3f9a1c" }),
         attach("plan-3f9a1c"),
      ]);
      expect(shared(s).slots.right.map((x) => [x.id, x.source])).toEqual([
         ["plan", "shared:plan-3f9a1c"],
      ]);
   });

   it("hides the item and the synthetic panel once detached", () => {
      const s = fold([
         ui({ id: "plan", placement: "right", title: "Plan", source: "shared:plan-3f9a1c" }),
         attach("plan-3f9a1c"),
         attach("map-a1b2c3"),
         detach("plan-3f9a1c"),
         detach("map-a1b2c3"),
      ]);
      const { inline, slots } = shared(s);
      expect(slots.right).toEqual([]);
      expect(inline.get(s.items[0]!.id)).toBeNull();
   });

   it("lists an artifact attached twice once", () => {
      const s = fold([attach("map-a1b2c3"), attach("map-a1b2c3", 9)]);
      expect(shared(s).slots.right.map((x) => [x.id, x.ts])).toEqual([["shared:map-a1b2c3", 9]]);
   });
});

const slot = (id: string, over: Partial<Slot> = {}): Slot => ({
   id,
   title: null,
   icon: null,
   root: { type: "text", text: id } as never,
   files: {},
   ts: 1,
   source: null,
   agent: null,
   ...over,
});
describe("slotDot", () => {
   const s = slot("a");
   test("only for a slot that was seen, is closed and changed since", () => {
      expect(slotDot(s, false, { a: "old" }, {})).toBe(true);
      expect(slotDot(s, true, { a: "old" }, {})).toBe(false);
      expect(slotDot(s, false, {}, {})).toBe(false);
      expect(slotDot(undefined, false, { a: "old" }, {})).toBe(false);
   });
   test("no dot when the seen key is current", () => {
      const seen = nextSeen(
         {},
         [s],
         {},
         () => false,
         () => false,
      );
      expect(slotDot(s, false, seen, {})).toBe(false);
   });
   test("a file-backed slot changes with its file hash", () => {
      const f = slot("f", { source: "f.json" });
      const seen = nextSeen(
         {},
         [f],
         { "f.json": { hash: "1" } },
         () => false,
         () => false,
      );
      expect(slotDot(f, false, seen, { "f.json": { hash: "1" } })).toBe(false);
      expect(slotDot(f, false, seen, { "f.json": { hash: "2" } })).toBe(true);
   });
});

describe("nextSeen", () => {
   const closed = () => false;
   test("first sight counts as seen", () => {
      const out = nextSeen({}, [slot("a")], {}, () => false, closed);
      expect(Object.keys(out)).toEqual(["a"]);
   });
   test("a change while closed is not marked seen", () => {
      const prev = nextSeen({}, [slot("a")], {}, () => false, closed);
      const changed = slot("a", { root: { type: "text", text: "new" } as never });
      expect(nextSeen(prev, [changed], {}, () => false, closed)).toBe(prev);
   });
   test("a change while open is marked seen", () => {
      const prev = nextSeen({}, [slot("a")], {}, () => false, closed);
      const changed = slot("a", { root: { type: "text", text: "new" } as never });
      const out = nextSeen(
         prev,
         [changed],
         {},
         () => false,
         () => true,
      );
      expect(out).not.toBe(prev);
      expect(out.a).not.toBe(prev.a);
   });
   test("same object when nothing changed", () => {
      const prev = nextSeen({}, [slot("a")], {}, () => false, closed);
      expect(
         nextSeen(
            prev,
            [slot("a")],
            {},
            () => false,
            () => true,
         ),
      ).toBe(prev);
   });
   test("a source not read yet is not seen yet; a shared one is", () => {
      const f = slot("f", { source: "f.json" });
      expect(nextSeen({}, [f], {}, () => false, closed)).toEqual({});
      expect(Object.keys(nextSeen({}, [f], {}, () => true, closed))).toEqual(["f"]);
      expect(
         Object.keys(nextSeen({}, [f], { "f.json": { hash: "h" } }, () => false, closed)),
      ).toEqual(["f"]);
   });
});

describe("auto open", () => {
   test("lastSlot is the newest, the first on a tie", () => {
      expect(lastSlot([])).toBeNull();
      expect(lastSlot([slot("a", { ts: 5 }), slot("b", { ts: 9 }), slot("c", { ts: 9 })])?.id).toBe(
         "b",
      );
   });
   test("a slot opens only when placed at or after the Session was opened", () => {
      expect(slotToAutoOpen(null, 10)).toBeNull();
      expect(slotToAutoOpen(slot("a", { ts: 9 }), 10)).toBeNull();
      expect(slotToAutoOpen(slot("a", { ts: 10 }), 10)?.id).toBe("a");
      expect(slotToAutoOpen(slot("a", { ts: 11 }), 10)?.id).toBe("a");
   });
});
