import { describe, expect, test } from "vitest";
import type { Slot } from "../features/renderUi/slots";
import { closeThread, defaultLayout, type Layout, type PanelId, slotPanel } from "./panelLayout";
import {
   activeThreadId,
   availablePanels,
   lastSlot,
   newThreadTabId,
   nextSeen,
   openThreadIds,
   panelCount,
   planToAutoOpen,
   renderablePanels,
   slotDot,
   slotToAutoOpen,
   stripeGroup,
   threadStarted,
} from "./viewState";

const slot = (id: string, over: Partial<Slot> = {}): Slot => ({
   id,
   title: null,
   icon: null,
   root: { type: "text", text: id } as never,
   files: {},
   ts: 1,
   source: null,
   ...over,
});
const none = { overlay: false, slotPanels: [], git: false, hasPlans: false, hasSubagents: false };

describe("availablePanels", () => {
   test("base panels without git, plans or subagents", () => {
      expect([...availablePanels(none)].sort()).toEqual(
         ["artifacts", "events", "files", "references", "side", "terminal"].sort(),
      );
   });
   test("git, plans and subagents each add one", () => {
      expect(availablePanels({ ...none, git: true }).has("changes")).toBe(true);
      expect(availablePanels({ ...none, hasPlans: true }).has("plan")).toBe(true);
      expect(availablePanels({ ...none, hasSubagents: true }).has("subagents")).toBe(true);
      expect(availablePanels(none).has("changes")).toBe(false);
   });
   test("slot panels are always available", () => {
      expect(availablePanels({ ...none, slotPanels: [slotPanel("a")] }).has("slot:a")).toBe(true);
   });
   test("the overlay shows only slot panels, whatever else is set", () => {
      const a = availablePanels({
         overlay: true,
         slotPanels: [slotPanel("a")],
         git: true,
         hasPlans: true,
         hasSubagents: true,
      });
      expect([...a]).toEqual(["slot:a"]);
   });
});

test("renderablePanels drops side without open tabs", () => {
   const a = availablePanels(none);
   expect(renderablePanels(a, 0).has("side")).toBe(false);
   expect(renderablePanels(a, 1).has("side")).toBe(true);
   expect(a.has("side")).toBe(true);
});

test("panelCount", () => {
   const n = { sideThreads: 3, artifacts: 2, references: 5, runningSubagents: 0 };
   expect(panelCount("side", n)).toBe(3);
   expect(panelCount("artifacts", n)).toBe(2);
   expect(panelCount("references", n)).toBe(5);
   expect(panelCount("references", { ...n, references: undefined })).toBeUndefined();
   expect(panelCount("subagents", n)).toBeUndefined();
   expect(panelCount("subagents", { ...n, runningSubagents: 2 })).toBe(2);
   expect(panelCount("files", n)).toBeUndefined();
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

describe("stripeGroup", () => {
   const lay = defaultLayout();
   const base = (over: Record<string, unknown> = {}) => ({
      zones: { ...lay.zones, rightTop: ["files", "changes", "plan"] as PanelId[] },
      openIn: "files" as PanelId | null,
      available: new Set<PanelId>(["files", "plan"]),
      slotById: new Map<PanelId, Slot>(),
      seen: {},
      stamps: {},
      label: (id: PanelId) => `L:${id}`,
      tip: (id: PanelId) => `T:${id}`,
      count: (id: PanelId) => (id === "plan" ? 4 : undefined),
      shortcut: (id: PanelId) => (id === "files" ? ["x"] : undefined),
      icon: (id: PanelId) => `I:${id}`,
      ...over,
   });
   test("lists available panels with their index in the full zone list", () => {
      const g = stripeGroup("rightTop", base());
      expect(g.zone).toBe("rightTop");
      expect(g.items.map((i) => [i.id, i.index, i.on])).toEqual([
         ["files", 0, true],
         ["plan", 2, false],
      ]);
      expect(g.items[1]).toMatchObject({
         label: "L:plan",
         tip: "T:plan",
         count: 4,
         icon: "I:plan",
      });
      expect(g.items[0]!.shortcut).toEqual(["x"]);
   });
   test("an empty zone has no items", () => {
      expect(stripeGroup("leftTop", base({ zones: { ...lay.zones, leftTop: [] } })).items).toEqual(
         [],
      );
   });
   test("the dot shows on a closed slot with changes", () => {
      const s = slot("a");
      const id = slotPanel("a");
      const o = base({
         zones: { ...lay.zones, rightTop: [id] },
         available: new Set([id]),
         slotById: new Map([[id, s]]),
         seen: { a: "stale" },
         openIn: null,
      });
      expect(stripeGroup("rightTop", o).items[0]!.dot).toBe(true);
      expect(stripeGroup("rightTop", { ...o, openIn: id }).items[0]!.dot).toBe(false);
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
   test("a pending plan opens once per request, never in the overlay", () => {
      const seen = new Set<string>();
      expect(planToAutoOpen(false, "r1", seen)).toBe("r1");
      seen.add("r1");
      expect(planToAutoOpen(false, "r1", seen)).toBeNull();
      expect(planToAutoOpen(false, "r2", seen)).toBe("r2");
      expect(planToAutoOpen(false, null, seen)).toBeNull();
      expect(planToAutoOpen(true, "r3", seen)).toBeNull();
   });
});

describe("Side Thread tabs", () => {
   const lay = (threads: string[], thread: string | null): Layout => ({
      ...defaultLayout(),
      threads,
      thread,
   });
   test("open tabs: drafts and Threads that arrived", () => {
      expect(openThreadIds(["draft:1", "t1", "t2"], { t1: {} })).toEqual(["draft:1", "t1"]);
   });
   test("active: the selected one if open, else the last", () => {
      expect(activeThreadId("t1", ["t1", "t2"])).toBe("t1");
      expect(activeThreadId("gone", ["t1", "t2"])).toBe("t2");
      expect(activeThreadId(null, ["t1"])).toBe("t1");
      expect(activeThreadId(null, [])).toBeNull();
   });
   test("new tab reuses an open draft", () => {
      expect(newThreadTabId(lay(["t1", "draft:a"], null), () => "zz")).toBe("draft:a");
      expect(newThreadTabId(lay(["t1"], null), () => "zz")).toBe("draft:zz");
   });
   test("a started Thread replaces its draft tab in place and keeps it active", () => {
      const l = threadStarted(lay(["t1", "draft:a", "t2"], "draft:a"), "draft:a", "t9");
      expect(l.threads).toEqual(["t1", "t9", "t2"]);
      expect(l.thread).toBe("t9");
   });
   test("a started Thread replaces an inactive draft without taking the focus", () => {
      const l = threadStarted(lay(["draft:a", "t2"], "t2"), "draft:a", "t9");
      expect(l.threads).toEqual(["t9", "t2"]);
      expect(l.thread).toBe("t2");
   });
   test("without a draft, or when its tab closed meanwhile, a new tab opens active and shows the panel", () => {
      for (const draft of [undefined, "draft:gone"]) {
         const l = threadStarted(lay(["t1"], "t1"), draft, "t9");
         expect(l.threads).toEqual(["t1", "t9"]);
         expect(l.thread).toBe("t9");
         expect(l.zones.rightTop).toContain("side");
         expect(l.open.rightTop).toBe("side");
      }
   });
   test("closing the active tab activates its left neighbour; the last one hides the panel", () => {
      let l = lay(["a", "b", "c"], "b");
      l = closeThread(l, "b");
      expect(l.threads).toEqual(["a", "c"]);
      expect(l.thread).toBe("a");
      l = closeThread(closeThread(l, "a"), "c");
      expect(l.threads).toEqual([]);
      expect(l.thread).toBeNull();
      expect(Object.values(l.open)).not.toContain("side");
   });
});
