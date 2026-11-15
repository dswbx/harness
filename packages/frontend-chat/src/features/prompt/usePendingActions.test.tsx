import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
   type PendingActions,
   type PendingMessage,
   pendingActions,
   removePendingActions,
   setPendingActions,
} from "./pendingMessages";
import { usePendingActions } from "./usePendingActions";

const make = (tag: string) => {
   const calls: string[] = [];
   const a: PendingActions = {
      retry: vi.fn(() => void calls.push(`retry:${tag}`)),
      edit: vi.fn((i: PendingMessage) => void calls.push(`edit:${tag}:${i.id}`)),
   };
   return { a, calls };
};

describe("usePendingActions", () => {
   it("registers on mount and removes on unmount", () => {
      const { a } = make("a");
      const h = renderHook(() => usePendingActions("pa-1", a));
      expect(pendingActions("pa-1")).toBeDefined();
      h.unmount();
      expect(pendingActions("pa-1")).toBeUndefined();
   });

   it("calls the latest closures after a re-render", () => {
      const first = make("1");
      const second = make("2");
      const h = renderHook(({ a }) => usePendingActions("pa-2", a), {
         initialProps: { a: first.a },
      });
      const registered = pendingActions("pa-2");
      h.rerender({ a: second.a });
      // Same registration, newest closures.
      expect(pendingActions("pa-2")).toBe(registered);
      registered?.retry();
      registered?.edit({ id: "m" } as PendingMessage);
      expect(first.calls).toEqual([]);
      expect(second.calls).toEqual(["retry:2", "edit:2:m"]);
      h.unmount();
   });

   it("moves the registration when the key changes", () => {
      const { a } = make("a");
      const h = renderHook(({ key }) => usePendingActions(key, a), {
         initialProps: { key: "pa-3" },
      });
      h.rerender({ key: "pa-4" });
      expect(pendingActions("pa-3")).toBeUndefined();
      expect(pendingActions("pa-4")).toBeDefined();
      h.unmount();
   });

   it("an unmounting box does not remove a newer box's registration", () => {
      const old = make("old");
      const h = renderHook(() => usePendingActions("pa-5", old.a));
      const newer = make("new");
      setPendingActions("pa-5", newer.a);
      h.unmount();
      expect(pendingActions("pa-5")).toBe(newer.a);
      removePendingActions("pa-5");
      expect(pendingActions("pa-5")).toBeUndefined();
   });
});
