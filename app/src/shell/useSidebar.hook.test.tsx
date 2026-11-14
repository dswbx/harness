import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarOpen } from "./useSidebar";

const mem = new Map<string, string>();
afterEach(cleanup);
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
   });
});

describe("harness.sidebarOpen", () => {
   it("is open unless '0'; the toggle stores the new state as 1 / 0", () => {
      const { result } = renderHook(() => useSidebarOpen());
      expect(result.current[0]).toBe(true);
      act(() => result.current[1]());
      expect(mem.get("harness.sidebarOpen")).toBe("0");
      expect(result.current[0]).toBe(false);
      act(() => result.current[1]());
      expect(mem.get("harness.sidebarOpen")).toBe("1");
      mem.set("harness.sidebarOpen", "0");
      expect(renderHook(() => useSidebarOpen()).result.current[0]).toBe(false);
   });
});
