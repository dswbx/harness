import { Virtualizer } from "@tanstack/react-virtual";
import { describe, expect, it, vi } from "vitest";
import { keepRowsAbove } from "./virtual-list";

/** Ten rows of 80px, the view scrolled to `offset` and the user scrolling up. */
function make(offset = 400) {
   const scrollToFn = vi.fn();
   const v = new Virtualizer<HTMLDivElement, Element>({
      count: 10,
      estimateSize: () => 80,
      getScrollElement: () => null,
      scrollToFn,
      observeElementRect: () => {},
      observeElementOffset: () => {},
      initialOffset: offset,
      initialRect: { width: 300, height: 300 },
   });
   v.shouldAdjustScrollPositionOnItemSizeChange = keepRowsAbove;
   v.getTotalSize(); // builds the measurements
   v.isScrolling = true;
   v.scrollDirection = "backward";
   return { v, scrollToFn };
}

describe("keepRowsAbove", () => {
   it("keeps the view still when a measured row above it changes size while the user scrolls up", () => {
      const { v, scrollToFn } = make();
      v.resizeItem(1, 130); // first measure (rows 0-1 end at 210, above 400)
      scrollToFn.mockClear();
      // It remounts at another height (a placeholder while it loads): the library default skips this.
      v.resizeItem(1, 90);
      expect(scrollToFn).toHaveBeenCalled();
   });

   it("does not move the view for a later change of a row that reaches into it", () => {
      const { v, scrollToFn } = make(350);
      v.resizeItem(4, 120); // row 4 starts at 320, above the view, and reaches into it
      scrollToFn.mockClear();
      v.resizeItem(4, 200); // grows at its bottom, in view (a streaming message)
      expect(scrollToFn).not.toHaveBeenCalled();
   });
});
