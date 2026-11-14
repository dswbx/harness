import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { OpenStep, type OpenStepRequest, useOpenStep } from "./openStep";

const withRequest =
   (req: OpenStepRequest | null) =>
   ({ children }: { children: ReactNode }) => (
      <OpenStep.Provider value={req}>{children}</OpenStep.Provider>
   );

describe("useOpenStep", () => {
   it("does nothing without a request or when the step is not on the path", () => {
      const open = vi.fn();
      renderHook(() => useOpenStep("s1", open), { wrapper: withRequest(null) });
      renderHook(() => useOpenStep("s1", open), {
         wrapper: withRequest({ path: ["a", "b"], nonce: 1 }),
      });
      expect(open).not.toHaveBeenCalled();
   });

   it("opens on mount when the request names the step (a parent on the path counts)", () => {
      const open = vi.fn();
      renderHook(() => useOpenStep("a", open), {
         wrapper: withRequest({ path: ["a", "b"], nonce: 1 }),
      });
      expect(open).toHaveBeenCalledTimes(1);
   });

   it("opens again for a new nonce, not for a re-render with the same request", () => {
      const open = vi.fn();
      let req: OpenStepRequest = { path: ["s1"], nonce: 1 };
      const { rerender } = renderHook(() => useOpenStep("s1", open), {
         wrapper: ({ children }: { children: ReactNode }) => (
            <OpenStep.Provider value={req}>{children}</OpenStep.Provider>
         ),
      });
      expect(open).toHaveBeenCalledTimes(1);
      req = { ...req };
      rerender();
      expect(open).toHaveBeenCalledTimes(1);
      req = { path: ["s1"], nonce: 2 };
      rerender();
      expect(open).toHaveBeenCalledTimes(2);
   });

   it("opens when a request arrives after mount", () => {
      const open = vi.fn();
      let req: OpenStepRequest | null = null;
      const { rerender } = renderHook(() => useOpenStep("s1", open), {
         wrapper: ({ children }: { children: ReactNode }) => (
            <OpenStep.Provider value={req}>{children}</OpenStep.Provider>
         ),
      });
      expect(open).not.toHaveBeenCalled();
      req = { path: ["x", "s1"], nonce: 1 };
      rerender();
      expect(open).toHaveBeenCalledTimes(1);
   });
});
