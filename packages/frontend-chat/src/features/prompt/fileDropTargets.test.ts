import { describe, expect, test } from "vitest";
import { pickTarget } from "./fileDropTargets";

const main = { left: 100, top: 500, right: 700, bottom: 580 };
const side = { left: 720, top: 500, right: 1000, bottom: 580 };

describe("pickTarget", () => {
   test("the box under the point takes the drop", () => {
      expect(pickTarget([main, side], { x: 800, y: 540 }, 0)).toBe(1);
      expect(pickTarget([main, side], { x: 200, y: 540 }, 1)).toBe(0);
   });

   test("a drop elsewhere on the window goes to the focused box, else the first", () => {
      expect(pickTarget([main, side], { x: 300, y: 100 }, 1)).toBe(1);
      expect(pickTarget([main, side], { x: 300, y: 100 }, -1)).toBe(0);
   });

   test("no position: the focused box, else the first", () => {
      expect(pickTarget([main, side], undefined, 1)).toBe(1);
      expect(pickTarget([main, side], undefined, -1)).toBe(0);
   });

   test("an unmounted box is never picked by position, and no boxes means no target", () => {
      expect(pickTarget([null, side], { x: 200, y: 540 }, -1)).toBe(0);
      expect(pickTarget([null, side], { x: 800, y: 540 }, -1)).toBe(1);
      expect(pickTarget([], { x: 1, y: 1 }, -1)).toBe(-1);
   });
});
