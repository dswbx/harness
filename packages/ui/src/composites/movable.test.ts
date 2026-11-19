import { describe, expect, it } from "vitest";
import { centeredRect, clampRect, resizeRect } from "./movable";

const min = { w: 640, h: 420 };
const view = { w: 1400, h: 900 };

describe("clampRect", () => {
   it("keeps a box inside the window", () => {
      expect(clampRect({ x: 1000, y: -50, w: 800, h: 600 }, min, view)).toEqual({
         x: 600,
         y: 0,
         w: 800,
         h: 600,
      });
   });
   it("grows to the minimum", () =>
      expect(clampRect({ x: 0, y: 0, w: 100, h: 100 }, min, view)).toMatchObject({
         w: 640,
         h: 420,
      }));
   it("shrinks to a window smaller than the minimum", () =>
      expect(clampRect({ x: 50, y: 50, w: 800, h: 600 }, min, { w: 500, h: 400 })).toEqual({
         x: 0,
         y: 0,
         w: 500,
         h: 400,
      }));
});

describe("resizeRect", () => {
   const start = { x: 200, y: 100, w: 800, h: 600 };
   it("east edge grows to the window edge, no further", () =>
      expect(resizeRect(start, "e", 1000, 0, min, view)).toEqual({ ...start, w: 1200 }));
   it("west edge keeps the right edge fixed and stops at the minimum", () =>
      expect(resizeRect(start, "w", 500, 0, min, view)).toEqual({ ...start, x: 360, w: 640 }));
   it("north-west corner stops at the window corner", () =>
      expect(resizeRect(start, "nw", -500, -500, min, view)).toEqual({
         x: 0,
         y: 0,
         w: 1000,
         h: 700,
      }));
   it("south edge stops at the minimum", () =>
      expect(resizeRect(start, "s", 0, -400, min, view)).toEqual({ ...start, h: 420 }));
});

describe("centeredRect", () => {
   it("centers the size", () =>
      expect(centeredRect({ w: 1000, h: 700 }, min, view)).toEqual({
         x: 200,
         y: 100,
         w: 1000,
         h: 700,
      }));
});
