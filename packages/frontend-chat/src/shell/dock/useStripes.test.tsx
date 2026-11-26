import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HostedPanel } from "../usePanelHost";
import { defaultLayout, type Layout, noZones } from "./model";
import { useStripes } from "./useStripes";

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

function setup(popped: ReadonlySet<string>) {
   const zones = noZones();
   zones.rightTop.push("plan", "tasks");
   const lay: Layout = { ...defaultLayout(), zones };
   const update = vi.fn();
   const onFocusWindow = vi.fn();
   const { result } = renderHook(() =>
      useStripes({
         entries: [entry("plan", "Plan"), entry("tasks", "Tasks")],
         statuses: new Map(),
         lay,
         shown: lay,
         available: new Set(["plan", "tasks"]),
         update,
         popped,
         onFocusWindow,
      }),
   );
   return { result, update, onFocusWindow };
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
