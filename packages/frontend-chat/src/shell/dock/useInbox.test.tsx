import { PANEL_OPEN_TTL, sendPanelOpen } from "@harness/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelCtx } from "../../panels/contract";
import type { DockMode } from "./useDockLayout";
import { useInbox } from "./useInbox";

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

const key = (panel: string) => `harness.panelOpen.s1#${panel}`;
const put = (panel: string, v: unknown) => mem.set(key(panel), JSON.stringify(v));

function mount(o: { mode?: DockMode; popout?: string; popped?: string[]; hosted?: string[] } = {}) {
   const open = vi.fn();
   const props = {
      sessionId: "s1",
      mode: o.mode ?? "main",
      popout: o.popout,
      popped: new Set(o.popped ?? []),
      hosted: o.hosted ?? ["files", "plan", "changes"],
      open: open as unknown as PanelCtx["open"],
   };
   const view = renderHook((p: typeof props) => useInbox(p), { initialProps: props });
   return { open, view, props };
}

describe("useInbox", () => {
   it("main view: applies an open once with its target, then removes the key", async () => {
      const { open, view, props } = mount();
      await act(() => sendPanelOpen("s1", "files", { path: "a.ts" }));
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith({ id: "files" }, { path: "a.ts" });
      expect(mem.get(key("files"))).toBeUndefined();
      view.rerender({ ...props });
      expect(open).toHaveBeenCalledTimes(1);
   });

   it("an open without a target opens without one", () => {
      put("plan", { v: 1, at: Date.now() });
      const { open } = mount();
      expect(open).toHaveBeenCalledWith({ id: "plan" });
      expect(open.mock.calls[0]).toHaveLength(1);
   });

   it("main view: leaves an open of a popped panel to its window", () => {
      put("changes", { v: 1, at: Date.now(), target: "all" });
      const { open } = mount({ popped: ["changes"] });
      expect(open).not.toHaveBeenCalled();
      expect(mem.get(key("changes"))).toBeDefined();
   });

   it("panel window: applies only its own panel", () => {
      put("changes", { v: 1, at: Date.now(), target: "all" });
      put("files", { v: 1, at: Date.now(), target: "b.ts" });
      const { open } = mount({ mode: "window", popout: "changes" });
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith({ id: "changes" }, "all");
      expect(mem.get(key("changes"))).toBeUndefined();
      expect(mem.get(key("files"))).toBeDefined();
   });

   it("Quick overlay: applies nothing", () => {
      put("files", { v: 1, at: Date.now(), target: "c.ts" });
      const { open } = mount({ mode: "overlay" });
      expect(open).not.toHaveBeenCalled();
      expect(mem.get(key("files"))).toBeDefined();
   });

   it("an open of a panel not hosted yet waits; applied once it is hosted", () => {
      put("slot:x", { v: 1, at: Date.now(), target: "item" });
      const { open, view, props } = mount();
      expect(open).not.toHaveBeenCalled();
      expect(mem.get(key("slot:x"))).toBeDefined();
      view.rerender({ ...props, hosted: [...props.hosted, "slot:x"] });
      expect(open).toHaveBeenCalledWith({ id: "slot:x" }, "item");
      expect(mem.get(key("slot:x"))).toBeUndefined();
   });

   it("a stale open is dropped, not applied", async () => {
      put("files", { v: 1, at: Date.now() - PANEL_OPEN_TTL - 1, target: "old.ts" });
      const { open } = mount();
      expect(open).not.toHaveBeenCalled();
      await act(async () => {});
      expect(mem.get(key("files"))).toBeUndefined();
   });
});
