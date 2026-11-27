import {
   ContextMenu,
   ContextMenuContent,
   ContextMenuTrigger,
   DropdownMenuItem,
   TooltipProvider,
} from "@harness/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
   createPanelMenus,
   type PanelChrome,
   PanelContext,
   PanelHeader,
   PanelMenuItems,
   type PanelMenuModel,
   PanelMenusContext,
   RegisteredPanelMenuItems,
} from "./PanelHeader";

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

   it("in a panel window: the whole header drags the window, its controls stay clickable", () => {
      const onDockBack = vi.fn();
      const { container } = render(
         <TooltipProvider>
            <PanelContext.Provider
               value={chrome({
                  window: {
                     icon: <svg data-testid="icon" />,
                     sessionTitle: "S",
                     onShowSession: () => {},
                     onDockBack,
                  },
               })}
            >
               <PanelHeader title="Plan">
                  <span data-testid="own">3 files</span>
                  <div data-testid="spacer" className="flex-1" />
               </PanelHeader>
            </PanelContext.Provider>
         </TooltipProvider>,
      );
      // "deep" (Tauri >= 2.12): a press anywhere in the subtree drags, except on clickable elements.
      const region = container.querySelector("[data-tauri-drag-region]")!;
      expect(region.getAttribute("data-tauri-drag-region")).toBe("deep");
      // What Tauri's drag script counts as clickable (it blocks the drag there).
      const clickable = (el: Element) =>
         ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"].includes(el.tagName) ||
         (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
         ["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"].includes(
            el.getAttribute("role") ?? "",
         );
      const drags = (el: Element) => {
         for (let e: Element | null = el; e && e !== region; e = e.parentElement)
            if (clickable(e)) return false;
         return true;
      };
      for (const id of ["icon", "own", "spacer"]) expect(drags(screen.getByTestId(id))).toBe(true);
      expect(drags(screen.getByText("Plan"))).toBe(true);
      expect(drags(region.querySelector("[aria-hidden].w-px")!)).toBe(true);
      for (const b of region.querySelectorAll("button")) expect(drags(b)).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Dock back Plan" }));
      expect(onDockBack).toHaveBeenCalledTimes(1);
   });

   it("with onPopOut: Open in window button and Move to › New window", () => {
      const onPopOut = vi.fn();
      setup(chrome({ onPopOut }));
      fireEvent.click(screen.getByRole("button", { name: "Open Plan in window" }));
      expect(onPopOut).toHaveBeenCalledTimes(1);
      openMenu();
      const sub = screen.getByRole("menuitem", { name: "Move to" });
      fireEvent.keyDown(sub, { key: "ArrowRight" });
      fireEvent.click(screen.getByRole("menuitem", { name: "New window" }));
      expect(onPopOut).toHaveBeenCalledTimes(2);
   });

   it("without onPopOut: no Open in window, no New window", () => {
      setup(chrome());
      expect(screen.queryByRole("button", { name: "Open Plan in window" })).toBeNull();
      openMenu();
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to" }), { key: "ArrowRight" });
      expect(screen.getByRole("menuitem", { name: "Right top" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "New window" })).toBeNull();
   });

   it("puts its own menu entries in the panel menus registry, and takes them out on unmount", () => {
      const menus = createPanelMenus();
      const view = render(
         <TooltipProvider>
            <PanelMenusContext.Provider value={menus}>
               <PanelContext.Provider value={chrome()}>
                  <PanelHeader title="Plan" menu="own entries" />
               </PanelContext.Provider>
            </PanelMenusContext.Provider>
         </TooltipProvider>,
      );
      expect(menus.get("plan")).toBe("own entries");
      view.unmount();
      expect(menus.get("plan")).toBeUndefined();
   });
});

const model = (over: Partial<PanelMenuModel> = {}): PanelMenuModel => ({
   moves: [
      { id: "rightTop", label: "Right top", current: true },
      { id: "leftTop", label: "Left top", current: false },
   ],
   onMove: () => {},
   ...over,
});

/** Opens a context menu with `items` on a trigger; returns its top-level entries. */
function openContextMenu(items: ReactNode) {
   render(
      <ContextMenu>
         <ContextMenuTrigger>icon</ContextMenuTrigger>
         <ContextMenuContent>{items}</ContextMenuContent>
      </ContextMenu>,
   );
   fireEvent.contextMenu(screen.getByText("icon"));
   return screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
}

describe("PanelMenuItems", () => {
   it("the same entries in a context menu as in the ⋮ menu", () => {
      setup(chrome({ onPopOut: () => {} }));
      const dropdown = openMenu();
      cleanup();
      const ctx = openContextMenu(
         <PanelMenuItems
            model={model({
               expand: { expanded: false, onToggle: () => {} },
               onPopOut: () => {},
            })}
            own={<div role="menuitem">Copy plan</div>}
         />,
      );
      expect(ctx).toEqual(dropdown);
      expect(ctx).toEqual(["Copy plan", "Expand", "Move to"]);
   });

   it("a popped panel: Show window and Dock back, no Expand, no New window", () => {
      const onShow = vi.fn();
      const onDockBack = vi.fn();
      const items = openContextMenu(
         <PanelMenuItems
            model={model({
               expand: { expanded: false, onToggle: () => {} },
               onPopOut: () => {},
               window: { onShow, onDockBack },
            })}
         />,
      );
      expect(items).toEqual(["Show window", "Dock back", "Move to"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Dock back" }));
      expect(onDockBack).toHaveBeenCalledTimes(1);
   });

   it("Move to › a zone and New window work in a context menu", () => {
      const onMove = vi.fn();
      const onPopOut = vi.fn();
      openContextMenu(<PanelMenuItems model={model({ onMove, onPopOut })} />);
      fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move to" }), { key: "ArrowRight" });
      expect(screen.getByRole("menuitem", { name: "New window" })).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: "Left top" }));
      expect(onMove).toHaveBeenCalledWith("leftTop");
   });

   it("RegisteredPanelMenuItems: the mounted panel's own DropdownMenuItems show in the context menu", () => {
      const menus = createPanelMenus();
      const onCopy = vi.fn();
      menus.set("plan", <DropdownMenuItem onSelect={onCopy}>Copy plan</DropdownMenuItem>);
      render(
         <PanelMenusContext.Provider value={menus}>
            <ContextMenu>
               <ContextMenuTrigger>icon</ContextMenuTrigger>
               <ContextMenuContent>
                  <RegisteredPanelMenuItems id="plan" model={model()} />
               </ContextMenuContent>
            </ContextMenu>
         </PanelMenusContext.Provider>,
      );
      fireEvent.contextMenu(screen.getByText("icon"));
      expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
         "Copy plan",
         "Move to",
      ]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy plan" }));
      expect(onCopy).toHaveBeenCalledTimes(1);
   });
});
