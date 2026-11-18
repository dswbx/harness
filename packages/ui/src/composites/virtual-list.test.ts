import { Virtualizer, type VirtualizerOptions } from "@tanstack/react-virtual";
import { describe, expect, it, vi } from "vitest";
import { keepRowsAbove, pinBottomOnResize, scrollByCorrection } from "./virtual-list";

type Opts = Partial<VirtualizerOptions<HTMLDivElement, Element>>;

/** Ten rows of 80px, the view (300px high) scrolled to `offset` and the user scrolling up. */
function make(offset = 400, opts: Opts = {}) {
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
      ...opts,
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
      expect(scrollToFn).toHaveBeenCalledTimes(1);
      expect(scrollToFn.mock.calls[0]?.[1]).toMatchObject({ adjustments: -40 });
   });

   it("does not move the view for a later change of a row that reaches into it", () => {
      const { v, scrollToFn } = make(350);
      v.resizeItem(4, 120); // row 4 starts at 320, above the view, and reaches into it
      scrollToFn.mockClear();
      v.resizeItem(4, 200); // grows at its bottom, in view (a streaming message)
      expect(scrollToFn).not.toHaveBeenCalled();
   });

   it("moves by the first measure of a row that starts above the view and reaches into it", () => {
      const { v, scrollToFn } = make(350);
      v.resizeItem(4, 120);
      expect(scrollToFn.mock.calls.at(-1)?.[1]).toMatchObject({ adjustments: 40 });
   });

   it("does not move the view for rows in it or below it (a message streaming at the end)", () => {
      const { v, scrollToFn } = make();
      v.resizeItem(5, 200); // starts at 400: the top row in view
      v.resizeItem(9, 300);
      v.resizeItem(9, 900);
      expect(scrollToFn).not.toHaveBeenCalled();
   });
});

/** A scroll element as the virtualizer uses it: what was written to it. */
function fakeElement() {
   const el = { scrollTop: 400, scrollHeight: 2000, scrollBy: vi.fn(), scrollTo: vi.fn() };
   return el as typeof el & HTMLDivElement;
}

describe("scrollByCorrection", () => {
   it("writes a row's size change as a relative scroll: the gesture's own position is kept", () => {
      const el = fakeElement();
      const { v } = make(400, { scrollToFn: scrollByCorrection });
      v.scrollElement = el;
      v.resizeItem(1, 130);
      expect(el.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: undefined });
      expect(el.scrollTo).not.toHaveBeenCalled();
      expect(v.scrollOffset).toBe(450);
   });

   it("writes a jump to a row as an absolute scroll", () => {
      const el = fakeElement();
      const { v } = make(400, { scrollToFn: scrollByCorrection });
      v.scrollElement = el;
      scrollByCorrection(160, { behavior: undefined }, v);
      expect(el.scrollTo).toHaveBeenCalledWith({ top: 160, behavior: undefined });
      expect(el.scrollBy).not.toHaveBeenCalled();
   });

   it("falls back to the absolute write where the element has no scrollBy", () => {
      const el = fakeElement();
      (el as { scrollBy?: unknown }).scrollBy = undefined;
      const { v } = make(400, { scrollToFn: scrollByCorrection });
      v.scrollElement = el;
      scrollByCorrection(400, { adjustments: 50, behavior: undefined }, v);
      expect(el.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: undefined });
   });
});

describe("pinBottomOnResize", () => {
   function pinned(following: () => boolean) {
      const el = fakeElement();
      const pin = pinBottomOnResize(() => el, following);
      const { v } = make(400, { onChange: pin });
      v.shouldAdjustScrollPositionOnItemSizeChange = () => false;
      return { el, v };
   }

   it("pins the bottom when a row changes size while following, not on a scroll", () => {
      const { el, v } = pinned(() => true);
      v.resizeItem(9, 300);
      expect(el.scrollTop).toBe(2000);
      // The user scrolls (wheel): the virtualizer notifies, the size is the same.
      el.scrollTop = 1900;
      v.options.onChange?.(v, true);
      v.options.onChange?.(v, false);
      expect(el.scrollTop).toBe(1900);
   });

   it("never writes while not following (the user scrolled up, or jumped to a message)", () => {
      const { el, v } = pinned(() => false);
      v.resizeItem(9, 300);
      v.resizeItem(2, 500);
      expect(el.scrollTop).toBe(400);
   });

   it("does not pull the view down for a size change from before following again", () => {
      let following = true;
      const { el, v } = pinned(() => following);
      v.resizeItem(9, 300);
      following = false;
      el.scrollTop = 400;
      v.resizeItem(9, 600); // grows while the user reads further up
      // Back within reach of the bottom, still scrolling: following again, no size change.
      following = true;
      el.scrollTop = 1950;
      v.options.onChange?.(v, true);
      expect(el.scrollTop).toBe(1950);
      v.resizeItem(9, 700);
      expect(el.scrollTop).toBe(2000);
   });
});
