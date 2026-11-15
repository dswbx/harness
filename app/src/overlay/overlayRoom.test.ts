import { describe, expect, it } from "vitest";
import { type MenuRoom, menuRoomStep, panelRoomStep, samePanels } from "./overlayMode";

describe("menuRoomStep", () => {
   const room = (o: Partial<MenuRoom> = {}): MenuRoom => ({
      busy: false,
      grown: false,
      held: false,
      ...o,
   });

   it("a menu opens: the card is pinned first, then the window grows", () => {
      expect(menuRoomStep(room(), true, false)).toEqual({ held: false, act: "pin" });
      expect(menuRoomStep(room(), true, true)).toEqual({ held: false, act: "open" });
   });
   it("menus closing: the window shrinks, then the pin goes", () => {
      expect(menuRoomStep(room({ grown: true }), false, true)).toEqual({
         held: false,
         act: "close",
      });
      expect(menuRoomStep(room(), false, true)).toEqual({ held: false, act: "unpin" });
   });
   it("nothing to do when grown and wanted, or idle", () => {
      expect(menuRoomStep(room({ grown: true }), true, true).act).toBe("none");
      expect(menuRoomStep(room(), false, false).act).toBe("none");
   });
   it("held (after a show or mode change): no room while menus stay open, until they close", () => {
      expect(menuRoomStep(room({ held: true }), true, false)).toEqual({ held: true, act: "none" });
      expect(menuRoomStep(room({ held: true }), false, false)).toEqual({
         held: false,
         act: "none",
      });
      // Released: the next menu gets room.
      expect(menuRoomStep(room({ held: false }), true, false).act).toBe("pin");
   });
   it("one host call at a time, but held still drops", () => {
      expect(menuRoomStep(room({ busy: true }), true, true)).toEqual({ held: false, act: "none" });
      expect(menuRoomStep(room({ busy: true, grown: true }), false, true).act).toBe("none");
      expect(menuRoomStep(room({ busy: true, held: true }), false, true)).toEqual({
         held: false,
         act: "none",
      });
      expect(menuRoomStep(room({ busy: true, held: true }), true, true).held).toBe(true);
   });
   it("a full open and close cycle", () => {
      const r = room();
      expect(menuRoomStep(r, true, false).act).toBe("pin");
      expect(menuRoomStep(r, true, true).act).toBe("open");
      r.grown = true;
      expect(menuRoomStep(r, true, true).act).toBe("none");
      expect(menuRoomStep(r, false, true).act).toBe("close");
      r.grown = false;
      expect(menuRoomStep(r, false, true).act).toBe("unpin");
      expect(menuRoomStep(r, false, false).act).toBe("none");
   });
});

describe("panelRoomStep", () => {
   const none = { left: 0, right: 0 };
   const step = (
      want: { left: number; right: number },
      host: { left: number; right: number },
      edge: "left" | "right" = "left",
      busy = false,
   ) => panelRoomStep({ busy, want, host, edge });

   it("does nothing when the window already has the room, or a call runs", () => {
      expect(step(none, none)).toEqual({ type: "none" });
      expect(step({ left: 5, right: 7 }, { left: 5, right: 7 })).toEqual({ type: "none" });
      expect(step({ left: 5, right: 0 }, none, "left", true)).toEqual({ type: "none" });
   });
   it("a right panel keeps the left edge: resizes at once", () => {
      expect(step({ left: 0, right: 300 }, none)).toEqual({
         type: "resize",
         to: { left: 0, right: 300 },
      });
   });
   it("a left panel first moves the row to the right edge, then resizes", () => {
      expect(step({ left: 200, right: 0 }, none, "left")).toEqual({ type: "edge", edge: "right" });
      expect(step({ left: 200, right: 0 }, none, "right")).toEqual({
         type: "resize",
         to: { left: 200, right: 0 },
      });
   });
   it("when both sides change the row is back on the left edge first", () => {
      expect(step({ left: 200, right: 300 }, none, "right")).toEqual({
         type: "edge",
         edge: "left",
      });
      expect(step({ left: 200, right: 300 }, none, "left").type).toBe("resize");
   });
   it("shrinking only the left side stays on the right edge", () => {
      expect(step({ left: 0, right: 300 }, { left: 200, right: 300 }, "right")).toEqual({
         type: "resize",
         to: { left: 0, right: 300 },
      });
   });
});

describe("samePanels", () => {
   it("compares both sides", () => {
      expect(samePanels({ left: 1, right: 2 }, { left: 1, right: 2 })).toBe(true);
      expect(samePanels({ left: 1, right: 2 }, { left: 1, right: 3 })).toBe(false);
   });
});
