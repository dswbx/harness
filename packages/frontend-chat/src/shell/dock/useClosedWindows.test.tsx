import { closePanel, dockPanel, popPanel } from "@harness/api";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isOpen, show } from "./model";
import { loadLayout, saveLayout } from "./persist";
import { useClosedWindows } from "./useClosedWindows";
import { useDockLayout } from "./useDockLayout";

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
   vi.stubGlobal("open", vi.fn());
   // The layout has Plan open, as popping out leaves it.
   saveLayout("s1", show(loadLayout("s1"), "plan"));
});
afterEach(() => vi.unstubAllGlobals());

function mount(mode: "main" | "window" = "main") {
   return renderHook(() => {
      const d = useDockLayout("s1", mode, mode === "window" ? "plan" : undefined);
      useClosedWindows("s1", mode === "main", d.lay, d.update);
      return d;
   });
}

describe("useClosedWindows", () => {
   it("a window closed while the view is mounted: hides the panel, saves, then removes the key", async () => {
      await popPanel("s1", "plan", { title: "Plan" });
      const { result } = mount();
      expect(isOpen(result.current.lay, "plan")).toBe(true);
      act(() => closePanel("s1", "plan"));
      expect(isOpen(result.current.lay, "plan")).toBe(false);
      expect(isOpen(loadLayout("s1"), "plan")).toBe(false);
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("a window closed before the view mounts (other Session shown, app not running): applied on mount", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, closed: true }));
      const { result } = mount();
      expect(isOpen(result.current.lay, "plan")).toBe(false);
      expect(isOpen(loadLayout("s1"), "plan")).toBe(false);
      expect(mem.get(KEY)).toBeUndefined();
   });

   it("Dock back (key removed) keeps the panel open in its zone", async () => {
      await popPanel("s1", "plan", { title: "Plan" });
      const { result } = mount();
      act(() => dockPanel("s1", "plan"));
      expect(isOpen(result.current.lay, "plan")).toBe(true);
      expect(isOpen(loadLayout("s1"), "plan")).toBe(true);
   });

   it("not in the main view: leaves the key and the stored layout", () => {
      mem.set(KEY, JSON.stringify({ v: 1, at: 1, closed: true }));
      mount("window");
      expect(mem.get(KEY)).toBeDefined();
      expect(isOpen(loadLayout("s1"), "plan")).toBe(true);
   });
});
