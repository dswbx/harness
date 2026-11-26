import { dockPanel } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisteredPanelMenuItems } from "../../panels/PanelHeader";
import type { HostedPanel } from "../usePanelHost";
import { defaultLayout, type Layout, noZones, show } from "./model";
import { Stripe } from "./Stripe";
import { useStripes } from "./useStripes";

vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   dockPanel: vi.fn(),
}));

afterEach(cleanup);

const entry = (id: string, label: string): HostedPanel => ({
   id,
   label,
   placement: { edge: "right" },
   overlay: false,
   mount: "whenOpen",
   self: { id, open: false, opened: false, show() {}, hide() {}, target: null },
   Body: () => null,
   props: {},
});

function setup(popped: ReadonlySet<string>, openIds: string[] = []) {
   const zones = noZones();
   zones.rightTop.push("plan", "tasks");
   const lay: Layout = openIds.reduce(show, { ...defaultLayout(), zones });
   const update = vi.fn();
   const onFocusWindow = vi.fn();
   const onDockBack = vi.fn();
   const onPopOut = vi.fn();
   const { result } = renderHook(() =>
      useStripes({
         entries: [{ ...entry("plan", "Plan"), expandable: true }, entry("tasks", "Tasks")],
         statuses: new Map(),
         lay,
         shown: lay,
         available: new Set(["plan", "tasks"]),
         update,
         popped,
         onFocusWindow,
         onDockBack,
         onPopOut,
         zones: ["rightTop", "leftTop"],
      }),
   );
   return { result, update, onFocusWindow, onDockBack, onPopOut, lay };
}

describe("useStripes: popped panels", () => {
   it("marks a popped panel and says so in its tip", () => {
      const { result } = setup(new Set(["plan"]));
      const items = result.current.right[0].items;
      expect(items.map((i) => [i.id, !!i.popped, i.tip])).toEqual([
         ["plan", true, "Plan · in its own window"],
         ["tasks", false, "Tasks"],
      ]);
   });

   it("a click on a popped panel focuses its window, others toggle", () => {
      const { result, update, onFocusWindow } = setup(new Set(["plan"]));
      result.current.onToggle("plan");
      expect(onFocusWindow).toHaveBeenCalledWith("plan");
      expect(update).not.toHaveBeenCalled();
      result.current.onToggle("tasks");
      expect(update).toHaveBeenCalledTimes(1);
      expect(onFocusWindow).toHaveBeenCalledTimes(1);
   });
});

describe("useStripes: the icon's context menu", () => {
   it("a docked panel: Expand only while open, Move to its zones (current marked), New window", () => {
      const { result, update, onPopOut, lay } = setup(new Set(), ["plan"]);
      const m = result.current.menuOf("plan");
      expect(m.window).toBeUndefined();
      expect(m.moves).toEqual([
         { id: "rightTop", label: expect.any(String), current: true },
         { id: "leftTop", label: expect.any(String), current: false },
      ]);
      expect(m.expand?.expanded).toBe(false);
      m.expand!.onToggle();
      expect(update.mock.calls[0]![0](lay).expanded).toBe("plan");
      m.onMove("leftTop");
      expect(update.mock.calls[1]![0](lay).zones.leftTop).toEqual(["plan"]);
      m.onPopOut!();
      expect(onPopOut).toHaveBeenCalledWith("plan");
      // Not open, or not expandable: no Expand.
      expect(result.current.menuOf("tasks").expand).toBeUndefined();
      expect(setup(new Set()).result.current.menuOf("plan").expand).toBeUndefined();
   });

   it("a popped panel: Show window and Dock back", () => {
      const { result, onFocusWindow, onDockBack } = setup(new Set(["plan"]), ["plan"]);
      const w = result.current.menuOf("plan").window!;
      w.onShow();
      expect(onFocusWindow).toHaveBeenCalledWith("plan");
      w.onDockBack();
      expect(onDockBack).toHaveBeenCalledWith("plan");
   });

   it("right-click on a popped icon: Dock back docks it (dockPanel); a left click still focuses its window", () => {
      const zones = noZones();
      zones.rightTop.push("plan");
      const lay: Layout = show({ ...defaultLayout(), zones }, "plan");
      const onFocusWindow = vi.fn();
      function Rail() {
         const s = useStripes({
            entries: [entry("plan", "Plan")],
            statuses: new Map(),
            lay,
            shown: lay,
            available: new Set(["plan"]),
            update: () => {},
            popped: new Set(["plan"]),
            onFocusWindow,
            onDockBack: (id) => dockPanel("s1", id),
            onPopOut: () => {},
         });
         return (
            <Stripe
               side="right"
               groups={[s.right[0], s.right[1], s.right[2]]}
               drag={null}
               onToggle={s.onToggle}
               onPress={() => {}}
               menu={(id) => <RegisteredPanelMenuItems id={id} model={s.menuOf(id)} />}
            />
         );
      }
      render(
         <TooltipProvider>
            <Rail />
         </TooltipProvider>,
      );
      const icon = screen.getByRole("button", { name: "Plan" });
      fireEvent.click(icon);
      expect(onFocusWindow).toHaveBeenCalledWith("plan");
      fireEvent.contextMenu(icon);
      expect(screen.getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
         "Show window",
         "Dock back",
         "Move to",
      ]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Dock back" }));
      expect(dockPanel).toHaveBeenCalledWith("s1", "plan");
   });
});
