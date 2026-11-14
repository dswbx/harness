import { describe, expect, it } from "vitest";
import { clampSize, computeRects, dropRects, shownOpen, sideWidths } from "./geometry";
import { defaultLayout, expand, hide, type Layout, move, reconcile, resize, show } from "./model";

/** A fixed arrangement, so these tests don't follow the defaults. */
const empty: Layout = {
   ...defaultLayout(),
   zones: {
      leftTop: ["changes"],
      leftBottom: ["artifacts", "references"],
      bottomLeft: ["terminal"],
      bottomRight: ["events"],
      rightBottom: ["files"],
      rightTop: ["side"],
   },
};
const open = (l: Layout, ...ids: string[]) => ids.reduce(show, l);

describe("shownOpen", () => {
   it("shownOpen hides what cannot render, without touching the layout", () => {
      const l = open(empty, "changes", "events");
      const s = shownOpen(l, new Set<string>(["events"]));
      expect(s.open.leftTop).toBeNull();
      expect(s.open.bottomRight).toBe("events");
      expect(l.open.leftTop).toBe("changes");
      expect(shownOpen(l, new Set<string>(["events", "changes"]))).toBe(l);
   });
   it("shownOpen shrinks an expanded panel that cannot render", () => {
      const l = expand(open(empty, "events"), "events");
      expect(shownOpen(l, new Set<string>()).expanded).toBeNull();
      expect(shownOpen(l, new Set<string>(["events"]))).toBe(l);
   });
});

describe("dropRects", () => {
   it("tiles the dock with all six zones at the current sizes, the chat left free", () => {
      const t = dropRects(open(empty, "side"), 1200, 800);
      const top = 800 - 240;
      expect(t.rightTop).toEqual({ x: 1200 - 380, y: 0, w: 380, h: Math.round(top * 0.55) });
      expect(t.rightBottom.y + t.rightBottom.h).toBe(top);
      expect(t.bottomLeft).toEqual({ x: 0, y: top, w: 600, h: 240 });
      expect(t.bottomRight).toEqual({ x: 600, y: top, w: 600, h: 240 });
      expect(t.leftTop.x).toBe(0);
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
      expect(rects(open(empty, "events")).zones.bottomRight).toEqual({
         x: 0,
         y: H - 240,
         w: W,
         h: 240,
      });
   });
   it("both bottom zones split the width by bottomSplit", () => {
      const g = rects(open(empty, "terminal", "events"));
      expect(g.zones.bottomLeft).toEqual({ x: 0, y: H - 240, w: 600, h: 240 });
      expect(g.zones.bottomRight).toEqual({ x: 600, y: H - 240, w: 600, h: 240 });
   });
   it("the chat keeps 360 px: both columns shrink together", () => {
      const g = computeRects(
         resize(open(empty, "side", "changes"), { left: 600, right: 600 }),
         1000,
         H,
      );
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
      const l = open(
         move(empty, "events", "rightBottom"),
         "side",
         "events",
         "changes",
         "artifacts",
         "terminal",
      );
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

describe("sideWidths", () => {
   const slot = "slot:chart";
   const withSlot = (zone: "leftTop" | "rightTop" | "rightBottom") =>
      reconcile(empty, [{ id: slot, zone }]);
   it("is 0 when no side is open", () => {
      expect(sideWidths(empty)).toEqual({ left: 0, right: 0 });
   });
   it("has the open right column at its size", () => {
      expect(sideWidths(show(withSlot("rightTop"), slot))).toEqual({ left: 0, right: 380 });
   });
   it("drops a side when its panel hides", () => {
      expect(sideWidths(hide(show(withSlot("rightTop"), slot), slot)).right).toBe(0);
   });
});
