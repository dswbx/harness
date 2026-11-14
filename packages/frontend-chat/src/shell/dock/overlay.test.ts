import { describe, expect, it } from "vitest";
import { dropRects } from "./geometry";
import { defaultLayout, hide, type Layout, move, reconcile, show } from "./model";
import { OVERLAY_ZONES, overlayGeometry, overlayProfile } from "./overlay";

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

describe("overlay profile", () => {
   it("has only the side zones; bottom zones go to the right", () => {
      expect(OVERLAY_ZONES).toEqual(["leftTop", "leftBottom", "rightBottom", "rightTop"]);
   });
   it("moves bottom panels to right bottom and keeps the open one open", () => {
      const l = overlayProfile(show(empty, "terminal"));
      expect(l.zones.bottomLeft).toEqual([]);
      expect(l.zones.bottomRight).toEqual([]);
      expect(l.zones.rightBottom).toEqual(["files", "terminal", "events"]);
      expect(l.open.rightBottom).toBe("terminal");
      expect(l.open.bottomLeft).toBeNull();
   });
   it("does not replace what right bottom shows", () => {
      const base = show(move(empty, "side", "rightBottom"), "side");
      const l = overlayProfile(show(base, "events"));
      expect(l.open.rightBottom).toBe("side");
      expect(l.zones.rightBottom).toEqual(["files", "side", "terminal", "events"]);
   });
   it("returns the same layout when there is nothing to move", () => {
      const l = overlayProfile(empty);
      expect(overlayProfile(l)).toBe(l);
   });
   it("drop targets span the full height without bottom zones", () => {
      const t = dropRects(empty, 1000, 800, OVERLAY_ZONES);
      expect(t.leftTop.h + t.leftBottom.h).toBe(800);
      expect(t.rightTop.h + t.rightBottom.h).toBe(800);
   });
});

describe("overlayGeometry", () => {
   const slot = "slot:chart";
   const right = show(reconcile(empty, [{ id: slot, zone: "rightTop" }]), slot);
   const left = show(reconcile(empty, [{ id: slot, zone: "leftTop" }]), slot);
   const none = { left: false, right: false };
   it("is the card alone without panels or stripes", () => {
      const g = overlayGeometry(empty, { left: 0, right: 0 }, none, 540);
      expect(g).toMatchObject({ width: 540, offset: 0, stripes: none });
      expect(g.layout).toBe(empty);
   });
   it("does not draw a right panel before the window has room for it", () => {
      // The stripe has its room, the panel not yet: the card keeps its width and place.
      const g = overlayGeometry(right, { left: 0, right: 40 }, { left: false, right: true }, 540);
      expect(g.layout.open.rightTop).toBeNull();
      expect(g).toMatchObject({ width: 580, offset: 0, stripes: { left: false, right: true } });
      // The window grew: now it shows, at its size.
      const open = overlayGeometry(
         right,
         { left: 0, right: 420 },
         { left: false, right: true },
         540,
      );
      expect(open.layout.open.rightTop).toBe(slot);
      expect(open).toMatchObject({ width: 960, offset: 0 });
   });
   it("stops drawing a closed panel while the window still has its room", () => {
      const closed = hide(right, slot);
      const g = overlayGeometry(closed, { left: 0, right: 420 }, { left: false, right: true }, 540);
      expect(g).toMatchObject({ width: 580, offset: 0 });
   });
   it("keeps the card at room.left while a left panel waits for its room", () => {
      const g = overlayGeometry(left, { left: 40, right: 0 }, { left: true, right: false }, 540);
      expect(g.layout.open.leftTop).toBeNull();
      expect(g).toMatchObject({ width: 580, offset: 0 });
      // Closing: the window still has 320 on the left; the dock starts after it.
      const closing = overlayGeometry(
         hide(left, slot),
         { left: 320, right: 0 },
         { left: true, right: false },
         540,
      );
      expect(closing).toMatchObject({ width: 580, offset: 280 });
   });
   it("draws a side no wider than its room (a panel resize in flight)", () => {
      const g = overlayGeometry(right, { left: 0, right: 300 }, { left: false, right: true }, 540);
      expect(g.layout.sizes.right).toBe(260);
      expect(g.width).toBe(540 + 40 + 260);
   });
   it("does not draw a stripe without room", () => {
      const g = overlayGeometry(empty, { left: 0, right: 0 }, { left: true, right: true }, 540);
      expect(g).toMatchObject({ width: 540, stripes: none });
   });
});
