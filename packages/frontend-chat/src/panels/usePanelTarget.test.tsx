import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PanelSelf } from "./contract";
import { usePanelTarget } from "./usePanelTarget";

const self = (target: PanelSelf<string>["target"]): PanelSelf<string> => ({
   id: "p",
   open: true,
   opened: true,
   show() {},
   hide() {},
   target,
});

describe("usePanelTarget", () => {
   it("applies a target once, however often it renders", () => {
      const apply = vi.fn();
      const t = { value: "a", seq: 1 };
      const { rerender } = renderHook((s) => usePanelTarget(s, apply), {
         initialProps: self(t),
      });
      rerender(self(t));
      rerender(self(t));
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith("a");
   });

   it("applies the same value again when it comes with a new seq", () => {
      const apply = vi.fn();
      const { rerender } = renderHook((s) => usePanelTarget(s, apply), {
         initialProps: self({ value: "a", seq: 1 }),
      });
      rerender(self({ value: "a", seq: 2 }));
      expect(apply).toHaveBeenCalledTimes(2);
   });

   it("does nothing without a target", () => {
      const apply = vi.fn();
      renderHook(() => usePanelTarget(self(null), apply));
      expect(apply).not.toHaveBeenCalled();
   });

   it("does not apply an already applied seq again after a remount", () => {
      const apply = vi.fn();
      const t = { value: "a", seq: 1 };
      const first = renderHook(() => usePanelTarget(self(t), apply));
      first.unmount();
      renderHook(() => usePanelTarget(self(t), apply));
      expect(apply).toHaveBeenCalledTimes(1);
   });
});
