import { describe, expect, test } from "vitest";
import { pickTarget, type TargetRects } from "./fileDropTargets";

// Window 1000x600: stripe 0-40, main column 40-700 (messages above, box at 500-580), gap 700-720, side panel 720-1000.
const mainT: TargetRects = {
   box: { left: 60, top: 500, right: 680, bottom: 580 },
   region: { left: 40, top: 0, right: 700, bottom: 600 },
   main: true,
};
const sideT: TargetRects = {
   box: { left: 730, top: 500, right: 990, bottom: 580 },
   region: { left: 720, top: 40, right: 1000, bottom: 600 },
   main: false,
};

describe("pickTarget", () => {
   for (const [name, targets, main, side] of [
      ["main first", [mainT, sideT], 0, 1],
      ["side first", [sideT, mainT], 1, 0],
   ] as const) {
      describe(name, () => {
         test("on a box: that box", () => {
            expect(pickTarget([...targets], { x: 300, y: 540 })).toBe(main);
            expect(pickTarget([...targets], { x: 800, y: 540 })).toBe(side);
         });
         test("over the messages of a chat: its box", () => {
            expect(pickTarget([...targets], { x: 300, y: 100 })).toBe(main);
            expect(pickTarget([...targets], { x: 800, y: 100 })).toBe(side);
         });
         test("over the stripe, a header or a third panel: the main box", () => {
            expect(pickTarget([...targets], { x: 10, y: 300 })).toBe(main);
            expect(pickTarget([...targets], { x: 800, y: 10 })).toBe(main);
            expect(pickTarget([...targets], { x: 710, y: 300 })).toBe(main);
         });
         test("no point: the main box", () => {
            expect(pickTarget([...targets], undefined)).toBe(main);
         });
      });
   }

   test("the smaller of two regions containing the point wins", () => {
      const inner: TargetRects = {
         box: null,
         region: { left: 100, top: 100, right: 200, bottom: 200 },
         main: false,
      };
      expect(pickTarget([mainT, inner], { x: 150, y: 150 })).toBe(1);
   });

   test("a single target always takes it; no targets means none", () => {
      expect(pickTarget([sideT], { x: 10, y: 10 })).toBe(0);
      expect(pickTarget([sideT], undefined)).toBe(0);
      expect(pickTarget([], { x: 1, y: 1 })).toBe(-1);
   });

   test("no main target: the first", () => {
      expect(pickTarget([sideT, { ...sideT }], { x: 10, y: 10 })).toBe(0);
   });

   test("an unmounted box has no rects and is never picked by position", () => {
      const gone: TargetRects = { box: null, region: null, main: false };
      expect(pickTarget([gone, mainT], { x: 300, y: 540 })).toBe(1);
   });
});
