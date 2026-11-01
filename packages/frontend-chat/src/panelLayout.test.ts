import { describe, expect, it } from "vitest";
import {
  clampSize, closeThread, computeRects, defaultLayout, expand, hide, migratePanel, move, openThread, parseLayout, reconcile, resetLayout, resize,
  selectThread, show, shownOpen, slotPanel, toggle, withShownIn, zoneOf, type Layout, type PanelId,
} from "./panelLayout";

const empty = defaultLayout();
const open = (l: Layout, ...ids: PanelId[]) => ids.reduce(show, l);

describe("toggle, show, hide", () => {
  it("toggle opens the panel in its zone, then hides it", () => {
    const on = toggle(empty, "changes");
    expect(on.open.leftTop).toBe("changes");
    expect(toggle(on, "changes").open.leftTop).toBeNull();
  });
  it("showing another panel of the zone replaces the open one", () => {
    const l = move(open(empty, "changes"), "artifacts", "leftTop");
    expect(show(l, "artifacts").open.leftTop).toBe("artifacts");
  });
  it("show is a no-op when already shown, hide when not shown", () => {
    const l = open(empty, "events");
    expect(show(l, "events")).toBe(l);
    expect(hide(l, "terminal")).toBe(l);
    expect(hide(l, "events").open.bottomRight).toBeNull();
  });
  it("unknown panels are ignored", () => {
    expect(toggle(empty, slotPanel("nope"))).toBe(empty);
  });
  it("hiding the expanded panel shrinks it", () => {
    const l = expand(open(empty, "events"), "events");
    expect(l.expanded).toBe("events");
    expect(hide(l, "events").expanded).toBeNull();
    expect(toggle(l, "events").expanded).toBeNull();
  });
  it("only an open panel expands", () => {
    expect(expand(empty, "events")).toBe(empty);
  });
});

describe("move", () => {
  it("moves between zones, to the end by default", () => {
    const l = move(empty, "events", "rightTop");
    expect(l.zones.bottomRight).toEqual([]);
    expect(l.zones.rightTop).toEqual(["side", "events"]);
    expect(zoneOf(l, "events")).toBe("rightTop");
  });
  it("inserts at an index", () => {
    expect(move(empty, "events", "rightTop", 0).zones.rightTop).toEqual(["events", "side"]);
  });
  it("an open panel stays open in its new zone and leaves the old one empty", () => {
    const l = move(open(empty, "terminal"), "terminal", "rightBottom");
    expect(l.open.bottomLeft).toBeNull();
    expect(l.open.rightBottom).toBe("terminal");
  });
  it("a closed panel stays closed", () => {
    const l = move(empty, "terminal", "rightBottom");
    expect(l.open.rightBottom).toBeNull();
  });
  it("replaces what the target zone showed", () => {
    const l = move(open(empty, "events", "side"), "events", "rightTop");
    expect(l.open.rightTop).toBe("events");
    expect(l.zones.rightTop).toEqual(["side", "events"]);
  });
  it("the expanded panel stays expanded when it moves, and shrinks if its zone's panel is replaced", () => {
    const l = expand(open(empty, "events"), "events");
    expect(move(l, "events", "rightTop").expanded).toBe("events");
    expect(move(open(l, "side"), "terminal", "rightTop").expanded).toBe("events");
  });
  describe("reorder in the same zone (index = position before the move)", () => {
    const l = move(move(empty, "events", "rightTop"), "changes", "rightTop"); // side, events, changes
    it("forward", () => {
      expect(move(l, "side", "rightTop", 2).zones.rightTop).toEqual(["events", "side", "changes"]);
      expect(move(l, "side", "rightTop", 3).zones.rightTop).toEqual(["events", "changes", "side"]);
    });
    it("backward", () => {
      expect(move(l, "changes", "rightTop", 0).zones.rightTop).toEqual(["changes", "side", "events"]);
      expect(move(l, "changes", "rightTop", 1).zones.rightTop).toEqual(["side", "changes", "events"]);
    });
    it("dropping on its own place changes nothing", () => {
      expect(move(l, "events", "rightTop", 1).zones.rightTop).toEqual(["side", "events", "changes"]);
      expect(move(l, "events", "rightTop", 2).zones.rightTop).toEqual(["side", "events", "changes"]);
    });
    it("keeps the open panel", () => {
      expect(move(show(l, "events"), "events", "rightTop", 0).open.rightTop).toBe("events");
    });
  });
});

describe("Side Threads", () => {
  it("opening a thread appends it, activates it and shows the side chats panel", () => {
    const s = openThread(openThread(empty, "a"), "b");
    expect(s.threads).toEqual(["a", "b"]);
    expect(s.thread).toBe("b");
    expect(s.open.rightTop).toBe("side");
    expect(openThread(s, "a").thread).toBe("a");
    expect(openThread(s, "a").threads).toEqual(["a", "b"]);
  });
  it("the panel opens in whatever zone it was moved to", () => {
    expect(openThread(move(empty, "side", "leftBottom"), "a").open.leftBottom).toBe("side");
  });
  it("hiding the panel keeps the open threads", () => {
    const s = toggle(openThread(empty, "a"), "side");
    expect(s.open.rightTop).toBeNull();
    expect(s.threads).toEqual(["a"]);
    expect(s.thread).toBe("a");
  });
  it("selecting only works for open threads", () => {
    const s = openThread(openThread(empty, "a"), "b");
    expect(selectThread(s, "a").thread).toBe("a");
    expect(selectThread(s, "zzz")).toBe(s);
  });
  it("closing the active thread shows its left neighbour, else right", () => {
    let s = ["a", "b", "c"].reduce(openThread, empty);
    s = closeThread(s, "c");
    expect(s.thread).toBe("b");
    s = selectThread(s, "a");
    expect(closeThread(s, "a").thread).toBe("b");
  });
  it("closing a background thread keeps the active one", () => {
    const s = closeThread(["a", "b"].reduce(openThread, empty), "a");
    expect(s.threads).toEqual(["b"]);
    expect(s.thread).toBe("b");
    expect(s.open.rightTop).toBe("side");
  });
  it("closing the last thread hides the panel", () => {
    const s = closeThread(openThread(empty, "a"), "a");
    expect(s.threads).toEqual([]);
    expect(s.thread).toBeNull();
    expect(s.open.rightTop).toBeNull();
  });
  it("closing the last thread leaves other panels alone", () => {
    const s = closeThread(open(openThread(empty, "a"), "terminal"), "a");
    expect(s.open.bottomLeft).toBe("terminal");
  });
});

describe("reset", () => {
  it("restores places and sizes but keeps the threads, and shows them", () => {
    const l = resize(move(openThread(empty, "a"), "side", "leftTop"), { left: 500 });
    const r = resetLayout(l);
    expect(r.zones).toEqual(empty.zones);
    expect(r.sizes).toEqual(empty.sizes);
    expect(r.threads).toEqual(["a"]);
    expect(r.open.rightTop).toBe("side");
  });
  it("shows nothing without threads", () => {
    expect(resetLayout(open(empty, "events")).open).toEqual(empty.open);
  });
});

describe("reconcile", () => {
  it("is the identity when nothing is missing", () => {
    expect(reconcile(empty, [])).toBe(empty);
  });
  it("puts built-in panels missing from the zones in their default zone", () => {
    const l = { ...empty, zones: { ...empty.zones, bottomRight: [], leftTop: [] } };
    const r = reconcile(l, []);
    expect(r.zones.bottomRight).toEqual(["events"]);
    expect(r.zones.leftTop).toEqual(["changes"]);
  });
  it("drops unknown ids and duplicates", () => {
    const l = { ...empty, zones: { ...empty.zones, leftBottom: ["nope", "changes", "artifacts"] as PanelId[] } };
    const r = reconcile(l, []);
    expect(r.zones.leftBottom).toEqual(["artifacts"]);
    expect(r.zones.leftTop).toEqual(["changes"]);
  });
  it("places new slots by placement and leaves placed ones where the user put them", () => {
    let l = reconcile(empty, [{ id: slotPanel("a"), zone: "rightTop" }, { id: slotPanel("b"), zone: "leftTop" }]);
    expect(l.zones.rightTop).toEqual(["side", "slot:a"]);
    expect(l.zones.leftTop).toEqual(["changes", "slot:b"]);
    l = move(l, slotPanel("a"), "bottomRight");
    const again = reconcile(l, [{ id: slotPanel("a"), zone: "rightTop" }, { id: slotPanel("b"), zone: "leftTop" }]);
    expect(again).toBe(l);
  });
  it("keeps the spot of a slot that is gone (it only loses its icon)", () => {
    const l = reconcile(empty, [{ id: slotPanel("a"), zone: "rightTop" }]);
    expect(reconcile(l, [])).toBe(l);
  });
  it("clears an open entry that is not in its zone", () => {
    const l = { ...empty, open: { ...empty.open, rightTop: "events" as PanelId } };
    expect(reconcile(l, []).open.rightTop).toBeNull();
  });
});

describe("shownOpen / withShownIn", () => {
  it("shownOpen hides what cannot render, without touching the layout", () => {
    const l = open(empty, "changes", "events");
    const s = shownOpen(l, new Set<PanelId>(["events"]));
    expect(s.open.leftTop).toBeNull();
    expect(s.open.bottomRight).toBe("events");
    expect(l.open.leftTop).toBe("changes");
    expect(shownOpen(l, new Set<PanelId>(["events", "changes"]))).toBe(l);
  });
  it("shownOpen shrinks an expanded panel that cannot render", () => {
    const l = expand(open(empty, "events"), "events");
    expect(shownOpen(l, new Set<PanelId>()).expanded).toBeNull();
    expect(shownOpen(l, new Set<PanelId>(["events"]))).toBe(l);
  });
  it("withShownIn moves the open mark only", () => {
    const l = withShownIn(open(empty, "events"), "events", "rightTop");
    expect(l.open.bottomRight).toBeNull();
    expect(l.open.rightTop).toBe("events");
  });
});

describe("persistence", () => {
  it("round-trips through parseLayout, minus Terminal and expanded", () => {
    const l = expand(resize(open(move(openThread(empty, "a"), "events", "rightBottom"), "events", "terminal"), { right: 450, rightSplit: 0.4 }), "events");
    const stored = JSON.parse(JSON.stringify({ zones: l.zones, open: l.open, sizes: l.sizes, threads: l.threads, thread: l.thread }));
    const r = parseLayout(stored);
    expect(r.zones).toEqual(l.zones);
    expect(r.open.rightBottom).toBe("events");
    expect(r.open.rightTop).toBe("side");
    expect(r.open.bottomLeft).toBeNull();
    expect(r.sizes.right).toBe(450);
    expect(r.threads).toEqual(["a"]);
    expect(r.expanded).toBeNull();
  });
  it("garbage gives the defaults", () => {
    expect(parseLayout(null)).toEqual(empty);
    expect(parseLayout("x")).toEqual(empty);
    expect(parseLayout({ zones: { rightTop: [1, "nope"] }, sizes: { left: "wide" } })).toEqual(empty);
  });
  it("drops duplicates, bad open entries and bad sizes", () => {
    const r = parseLayout({ zones: { rightTop: ["side", "events"], leftTop: ["events", "changes"] }, open: { rightTop: "changes", leftTop: "terminal" }, sizes: { left: -5, right: 500 } });
    expect(r.zones.leftTop).toEqual(["events", "changes"]);
    expect(r.zones.rightTop).toEqual(["side"]);
    expect(r.open.rightTop).toBeNull();
    expect(r.open.leftTop).toBeNull();
    expect(r.sizes.left).toBe(empty.sizes.left);
    expect(r.sizes.right).toBe(500);
  });
});

describe("migration of the old right panel state", () => {
  it("keeps threads and opens the old view in its zone", () => {
    const l = migratePanel({ threads: ["a", "b"], thread: "a", view: { kind: "events" } });
    expect(l.threads).toEqual(["a", "b"]);
    expect(l.thread).toBe("a");
    expect(l.open.bottomRight).toBe("events");
    expect(l.open.rightTop).toBeNull();
  });
  it("the side view opens the side chats", () => {
    expect(migratePanel({ threads: ["a"], thread: "a", view: { kind: "side" } }).open.rightTop).toBe("side");
  });
  it("a slot view opens in right top", () => {
    const l = migratePanel({ threads: [], view: { kind: "slot", id: "notes" } });
    expect(l.zones.rightTop).toEqual(["side", "slot:notes"]);
    expect(l.open.rightTop).toBe("slot:notes");
  });
  it("no view or garbage opens nothing", () => {
    expect(migratePanel({ threads: [], view: null }).open).toEqual(empty.open);
    expect(migratePanel(null)).toEqual(empty);
    expect(migratePanel({ view: { kind: "terminal" } }).open).toEqual(empty.open);
  });
  it("the active thread falls back to the last", () => {
    expect(migratePanel({ threads: ["a", "b"], thread: "zzz" }).thread).toBe("b");
  });
});

describe("computeRects", () => {
  const W = 1200;
  const H = 800;
  const rects = (l: Layout) => computeRects(l, W, H);
  it("nothing open: the chat fills the dock", () => {
    const g = rects(empty);
    expect(g.chat).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(g.zones).toEqual({});
  });
  it("one right zone takes the full height", () => {
    const g = rects(open(empty, "side"));
    expect(g.zones.rightTop).toEqual({ x: W - 380, y: 0, w: 380, h: H });
    expect(g.chat).toEqual({ x: 0, y: 0, w: W - 380, h: H });
  });
  it("the bottom-half zone alone also fills it", () => {
    const g = rects(move(open(empty, "side"), "side", "rightBottom"));
    expect(g.zones.rightBottom).toEqual({ x: W - 380, y: 0, w: 380, h: H });
  });
  it("both right zones split the height by rightSplit", () => {
    const g = rects(open(move(empty, "events", "rightBottom"), "side", "events"));
    const t = Math.round(H * 0.55);
    expect(g.zones.rightTop).toEqual({ x: W - 380, y: 0, w: 380, h: t });
    expect(g.zones.rightBottom).toEqual({ x: W - 380, y: t, w: 380, h: H - t });
  });
  it("both left zones split by leftSplit", () => {
    const g = rects(open(empty, "changes", "artifacts"));
    expect(g.zones.leftTop).toEqual({ x: 0, y: 0, w: 280, h: 400 });
    expect(g.zones.leftBottom).toEqual({ x: 0, y: 400, w: 280, h: 400 });
    expect(g.chat.x).toBe(280);
  });
  it("one bottom zone fills the width under the sides; the chat sits above it", () => {
    const g = rects(open(empty, "terminal", "side", "changes"));
    expect(g.zones.bottomLeft).toEqual({ x: 0, y: H - 240, w: W, h: 240 });
    expect(g.zones.rightTop).toEqual({ x: W - 380, y: 0, w: 380, h: H - 240 });
    expect(g.chat).toEqual({ x: 280, y: 0, w: W - 280 - 380, h: H - 240 });
  });
  it("the right bottom zone alone also fills the bottom width", () => {
    const g = rects(move(open(empty, "events"), "events", "bottomLeft"));
    expect(g.zones.bottomLeft).toEqual({ x: 0, y: H - 240, w: W, h: 240 });
    expect(g.zones.bottomRight).toBeUndefined();
    expect(rects(open(empty, "events")).zones.bottomRight).toEqual({ x: 0, y: H - 240, w: W, h: 240 });
  });
  it("both bottom zones split the width by bottomSplit", () => {
    const g = rects(open(empty, "terminal", "events"));
    expect(g.zones.bottomLeft).toEqual({ x: 0, y: H - 240, w: 600, h: 240 });
    expect(g.zones.bottomRight).toEqual({ x: 600, y: H - 240, w: 600, h: 240 });
  });
  it("the chat keeps 360 px: both columns shrink together", () => {
    const g = computeRects(resize(open(empty, "side", "changes"), { left: 600, right: 600 }), 1000, H);
    expect(g.chat.w).toBe(360);
    expect(g.left + g.right).toBe(640);
    expect(g.left).toBe(g.right);
    expect(g.zones.rightTop!.x).toBe(1000 - g.right);
  });
  it("the bottom height is bounded so the chat keeps height", () => {
    const g = computeRects(resize(open(empty, "terminal"), { bottom: 5000 }), W, H);
    expect(g.bottom).toBe(H - 220);
    expect(computeRects(resize(open(empty, "terminal"), { bottom: 10 }), W, H).bottom).toBe(120);
  });
  it("zones tile the dock without overlap", () => {
    const l = open(move(empty, "events", "rightBottom"), "side", "events", "changes", "artifacts", "terminal");
    const g = rects(l);
    const area = Object.values(g.zones).reduce((a, r) => a + r.w * r.h, 0) + g.chat.w * g.chat.h;
    expect(area).toBe(W * H);
  });
});

describe("clampSize", () => {
  const l = open(empty, "side", "changes");
  const g = computeRects(l, 1000, 800);
  it("keeps the chat wide enough", () => {
    expect(clampSize("left", 900, g, 1000, 800)).toBe(1000 - 360 - g.right);
    expect(clampSize("left", 10, g, 1000, 800)).toBe(180);
    expect(clampSize("right", 900, g, 1000, 800)).toBe(1000 - 360 - g.left);
  });
  it("bounds the bottom and the splits", () => {
    expect(clampSize("bottom", 5000, g, 1000, 800)).toBe(580);
    expect(clampSize("bottom", 1, g, 1000, 800)).toBe(120);
    expect(clampSize("leftSplit", 0, g, 1000, 800)).toBe(0.15);
    expect(clampSize("bottomSplit", 1, g, 1000, 800)).toBe(0.8);
  });
});
