import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PanelChrome, PanelContext, PanelHeader } from "./PanelHeader";

afterEach(cleanup);

const chrome = (over: Partial<PanelChrome> = {}): PanelChrome => ({
   id: "plan",
   label: "Plan",
   moves: [{ id: "rightTop", label: "Right top", current: true }],
   expandable: true,
   expanded: false,
   onExpand: () => {},
   onMove: () => {},
   onHide: () => {},
   onDragStart: () => {},
   ...over,
});

function setup(c: PanelChrome) {
   render(
      <TooltipProvider>
         <PanelContext.Provider value={c}>
            <PanelHeader title="Plan" menu={<div role="menuitem">Copy plan</div>} />
         </PanelContext.Provider>
      </TooltipProvider>,
   );
}
/** Opens the ⋮ menu; returns its entries. */
function openMenu() {
   fireEvent.keyDown(screen.getByRole("button", { name: "Plan options" }), { key: "Enter" });
   return screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
}

describe("PanelHeader", () => {
   it("in a dock: Hide and Move to", () => {
      setup(chrome());
      expect(screen.getByRole("button", { name: "Hide Plan" })).toBeTruthy();
      const items = openMenu();
      expect(items).toContain("Move to");
      expect(items).not.toContain("Dock back");
   });

   it("in a panel window: session chip, Dock back, no Hide, Move to or Expand", () => {
      const onShowSession = vi.fn();
      const onDockBack = vi.fn();
      setup(
         chrome({
            window: {
               sessionTitle: "Fix the parser",
               project: "demo-app",
               onShowSession,
               onDockBack,
            },
         }),
      );
      expect(screen.queryByRole("button", { name: "Hide Plan" })).toBeNull();
      expect(screen.getByRole("button", { name: "Dock back Plan" })).toBeTruthy();
      const chip = screen.getByRole("button", { name: "Show session Fix the parser" });
      expect(chip.textContent).toContain("Fix the parser");
      fireEvent.click(chip);
      expect(onShowSession).toHaveBeenCalledTimes(1);

      expect(openMenu()).toEqual(["Copy plan", "Dock back"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Dock back" }));
      expect(onDockBack).toHaveBeenCalledTimes(1);
   });

   it("in a panel window: the header is a drag region and Dock back is a button", () => {
      const onDockBack = vi.fn();
      const { container } = render(
         <TooltipProvider>
            <PanelContext.Provider
               value={chrome({
                  window: { sessionTitle: "S", onShowSession: () => {}, onDockBack },
               })}
            >
               <PanelHeader title="Plan" />
            </PanelContext.Provider>
         </TooltipProvider>,
      );
      expect(container.querySelector("[data-tauri-drag-region]")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Dock back Plan" }));
      expect(onDockBack).toHaveBeenCalledTimes(1);
   });
});
