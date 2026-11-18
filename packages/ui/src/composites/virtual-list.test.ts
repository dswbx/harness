import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it, vi } from "vitest";
import { holdCorrectionsWhileScrolling } from "./virtual-list";

function make() {
   const scrollToFn = vi.fn();
   const v = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 10,
      estimateSize: () => 80,
      getScrollElement: () => null,
      scrollToFn,
      observeElementRect: () => {},
      observeElementOffset: () => {},
      initialOffset: 400,
      initialRect: { width: 300, height: 300 },
   });
   v.getTotalSize(); // builds the measurements
   return { v, scrollToFn };
}

describe("holdCorrectionsWhileScrolling", () => {
   it("relies on a private member of @tanstack/virtual-core that still exists", () => {
      const { v } = make();
      expect(typeof (v as unknown as { _canWriteScroll: unknown })._canWriteScroll).toBe(
         "function",
      );
   });

   it("holds a row above the view in the offsets while the user scrolls, not in scrollTop", () => {
      const { v, scrollToFn } = make();
      holdCorrectionsWhileScrolling(v);
      v.isScrolling = true;
      // Row 1 (start 80, above the offset 400) measures 50px taller than its estimate.
      v.resizeItem(1, 130);
      expect(scrollToFn).not.toHaveBeenCalled();
      // Held in the offsets: the rows' layout loses the 50px again, so the rows below stay on screen.
      expect(v.getTotalSize()).toBe(800);
   });

   it("writes scrollTop at once when the user is not scrolling", () => {
      const { v, scrollToFn } = make();
      holdCorrectionsWhileScrolling(v);
      v.resizeItem(1, 130);
      expect(scrollToFn).toHaveBeenCalled();
      expect(v.getTotalSize()).toBe(850);
   });
});
