import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNestDrag } from "./useNestDrag";

/** What `document.elementFromPoint` answers (happy-dom does no layout). */
let hit: Element | null = null;
beforeEach(() => {
   hit = null;
   document.elementFromPoint = () => hit;
});
afterEach(cleanup);

function Rows({ onDrop }: { onDrop: (id: string, target: string | null) => void }) {
   const { start } = useNestDrag(onDrop, () => true);
   return (
      <div>
         <div data-testid="header">Column header</div>
         <div data-nest-target="b" data-testid="b">
            <span data-testid="b-title">B</span>
         </div>
         <div data-testid="a" onPointerDown={(e) => start("a", e)}>
            A
         </div>
      </div>
   );
}

/** Every row's box covers the whole window, as a row scrolled out under the header would. */
function coverAll() {
   vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 1000,
      left: 0,
      right: 1000,
      width: 1000,
      height: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
   });
}

function drag(to: { x: number; y: number }) {
   fireEvent.pointerDown(screen.getByTestId("a"), {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 1,
   });
   fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
   fireEvent.pointerUp(window, { pointerId: 1 });
}

describe("useNestDrag", () => {
   afterEach(() => vi.restoreAllMocks());

   it("drops on the row under the pointer", () => {
      const onDrop = vi.fn();
      render(<Rows onDrop={onDrop} />);
      coverAll();
      hit = screen.getByTestId("b-title");
      drag({ x: 50, y: 50 });
      expect(onDrop).toHaveBeenCalledWith("a", "b");
   });

   it("does not drop on a row hidden under the header", () => {
      const onDrop = vi.fn();
      render(<Rows onDrop={onDrop} />);
      // The row's box holds the point, but the header is on top there.
      coverAll();
      hit = screen.getByTestId("header");
      drag({ x: 50, y: 50 });
      expect(onDrop).not.toHaveBeenCalled();
   });
});
