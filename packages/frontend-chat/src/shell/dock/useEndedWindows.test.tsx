import { closePanel, dockPanel, popPanel } from "@harness/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpen, movePopped, show } from "./model";
import { loadLayout, saveLayout } from "./persist";
import { useDockLayout } from "./useDockLayout";
import { useEndedWindows } from "./useEndedWindows";

const KEY = "harness.panelWindow.s1#plan";

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      get length() {
         return mem.size;
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
   });
   vi.stubGlobal(
      "open",
      vi.fn(() => ({})),
   );
});
afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
});

function mount(mode: "main" | "window" = "main") {
   return renderHook(() => {
      const d = useDockLayout("s1", mode, mode === "window" ? "plan" : undefined);
      useEndedWindows("s1", mode === "main", d.lay, d.update);
      return d;
   });
}

describe("useEndedWindows: closed (red X)", () => {
   beforeEach(() => saveLayout("s1", show(loadLayout("s1"), "plan")));

   it("closed while the view is mounted: hides the panel, saves, then removes the key", async () => {
      await popPanel("s1", "plan", { title: "Plan" });
      const { result } = mount();
      expect(isOpen(result.current.lay, "plan")).toBe(true);
      act(() => closePanel("s1", "plan"));
      expect(isOpen(result.current.lay, "plan")).toBe(false);
      expect(isOpen(loadLayout("s1"), "plan")).toBe(false);
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("an old `closed: true` value written before the view mounts: applied on mount", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, closed: true }));
      const { result } = mount();
      expect(isOpen(result.current.lay, "plan")).toBe(false);
      expect(isOpen(loadLayout("s1"), "plan")).toBe(false);
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("not in the main view: leaves the key and the stored layout", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, closed: true }));
      mount("window");
      expect(mem.get(KEY)).toBeDefined();
      expect(isOpen(loadLayout("s1"), "plan")).toBe(true);
   });
});

describe("useEndedWindows: Dock back", () => {
   // Tasks is shown in the zone; Plan (same zone, hidden) is popped out. Popping does not touch the layout.
   beforeEach(() => saveLayout("s1", show(loadLayout("s1"), "tasks")));

   it("pop out a hidden panel keeps the zone's shown panel; Dock back shows it in its zone", async () => {
      const { result } = mount();
      await act(() => popPanel("s1", "plan", { title: "Plan" }));
      expect(result.current.lay.open.rightTop).toBe("tasks");
      act(() => dockPanel("s1", "plan"));
      expect(result.current.lay.open.rightTop).toBe("plan");
      expect(loadLayout("s1").open.rightTop).toBe("plan");
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("docked while the main view showed another Session: applied when the view mounts", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, docked: true }));
      const { result } = mount();
      expect(result.current.lay.open.rightTop).toBe("plan");
      expect(loadLayout("s1").open.rightTop).toBe("plan");
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("a popped panel moved to another zone: no zone's shown panel changes; docked, it opens there", async () => {
      saveLayout("s1", show(loadLayout("s1"), "artifacts"));
      const { result } = mount();
      await act(() => popPanel("s1", "plan", { title: "Plan" }));
      act(() => result.current.update((l) => movePopped(l, "plan", "leftTop")));
      expect(result.current.lay.open.rightTop).toBe("tasks");
      expect(result.current.lay.open.leftTop).toBe("artifacts");
      expect(result.current.lay.zones.leftTop).toContain("plan");
      act(() => dockPanel("s1", "plan"));
      expect(result.current.lay.open.leftTop).toBe("plan");
      expect(result.current.lay.open.rightTop).toBe("tasks");
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("two panels of one zone docked: applied once, the keys go", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, docked: true }));
      mem.set("harness.panelWindow.s1#files", JSON.stringify({ v: 1, at: 2, docked: true }));
      const { result } = mount();
      expect(result.current.lay.open.rightTop).toBe("files");
      expect(mem.get(KEY)).toBeUndefined();
      expect(mem.get("harness.panelWindow.s1#files")).toBeUndefined();
   });

   it("not in the main view: leaves the key", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, docked: true }));
      mount("window");
      expect(mem.get(KEY)).toBeDefined();
      expect(loadLayout("s1").open.rightTop).toBe("tasks");
   });
});
