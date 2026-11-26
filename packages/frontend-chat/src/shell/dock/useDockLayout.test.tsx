import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hide, isOpen, resize } from "./model";
import { loadLayout } from "./persist";
import { useDockLayout } from "./useDockLayout";

const KEY = "harness.chat.layout.s1";

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
   });
});
afterEach(() => vi.unstubAllGlobals());

describe("useDockLayout", () => {
   it("main: saves changes", () => {
      const { result } = renderHook(() => useDockLayout("s1", "main"));
      act(() => result.current.update((l) => resize(l, { left: 300 })));
      expect(localStorage.getItem(KEY)).not.toBeNull();
   });

   it("window: shows its panel, keeps it shown and never saves", () => {
      const { result } = renderHook(() => useDockLayout("s1", "window", "plan"));
      expect(isOpen(result.current.lay, "plan")).toBe(true);
      act(() => result.current.update((l) => resize(l, { left: 300 })));
      act(() => result.current.update((l) => hide(l, "plan")));
      expect(isOpen(result.current.lay, "plan")).toBe(true);
      expect(localStorage.getItem(KEY)).toBeNull();
   });

   it("window: starts from the stored layout and leaves it as it is", () => {
      const { result: main } = renderHook(() => useDockLayout("s1", "main"));
      act(() => main.current.update((l) => hide(l, "plan")));
      const stored = localStorage.getItem(KEY);
      const { result } = renderHook(() => useDockLayout("s1", "window", "plan"));
      act(() => result.current.update((l) => resize(l, { left: 320 })));
      expect(localStorage.getItem(KEY)).toBe(stored);
      expect(isOpen(loadLayout("s1"), "plan")).toBe(false);
   });
});
