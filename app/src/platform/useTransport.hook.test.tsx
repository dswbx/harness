import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTransport } from "./useTransport";

describe("useTransport", () => {
   it("is null until the mock transport is made, then stays the same one", async () => {
      const hook = renderHook(() => useTransport());
      expect(hook.result.current).toBeNull();
      await waitFor(() => expect(hook.result.current).not.toBeNull());
      const t = hook.result.current;
      hook.rerender();
      expect(hook.result.current).toBe(t);
   });

   it("an unmount before it is made sets nothing", async () => {
      const hook = renderHook(() => useTransport());
      hook.unmount();
      await new Promise((r) => setTimeout(r, 50));
      expect(hook.result.current).toBeNull();
   });
});
