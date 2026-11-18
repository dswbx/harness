import { CommandError } from "@harness/api";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, useAutosave } from "./useAutosave";

afterEach(() => vi.useRealTimers());

function setup(save = vi.fn(async (_: string) => {})) {
   const hook = renderHook(() => useAutosave(save));
   return { save, hook };
}

describe("useAutosave", () => {
   it("saves the last value once typing stops", async () => {
      vi.useFakeTimers();
      const { save, hook } = setup();
      act(() => {
         hook.result.current.change("a");
         hook.result.current.change("ab");
      });
      expect(hook.result.current.status).toBe("pending");
      await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1));
      expect(save).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(save.mock.calls).toEqual([["ab"]]);
      expect(hook.result.current.status).toBe("saved");
   });

   it("saves at once on unmount", () => {
      const { save, hook } = setup();
      act(() => hook.result.current.change("unsaved"));
      hook.unmount();
      expect(save.mock.calls).toEqual([["unsaved"]]);
   });

   it("saves at once on flush, and not again when nothing changed", async () => {
      const { save, hook } = setup();
      act(() => hook.result.current.change("x"));
      await act(() => hook.result.current.flush());
      await act(() => hook.result.current.flush());
      hook.unmount();
      expect(save.mock.calls).toEqual([["x"]]);
   });

   it("saves a change made during a save after it", async () => {
      let finish = () => {};
      const save = vi.fn(
         (_: string) =>
            new Promise<void>((ok) => {
               finish = ok;
            }),
      );
      const { hook } = setup(save);
      act(() => hook.result.current.change("one"));
      let first!: Promise<void>;
      act(() => {
         first = hook.result.current.flush();
         hook.result.current.change("two");
      });
      const second = hook.result.current.flush();
      expect(save.mock.calls).toEqual([["one"]]);
      await act(async () => finish());
      await act(async () => {
         finish();
         await Promise.all([first, second]);
      });
      expect(save.mock.calls).toEqual([["one"], ["two"]]);
   });

   it("stops on a conflict until reset", async () => {
      const save = vi.fn(async (_: string) => {
         throw new CommandError("conflict", "the note changed elsewhere: reload it");
      });
      const { hook } = setup(save);
      act(() => hook.result.current.change("mine"));
      await act(() => hook.result.current.flush());
      expect(hook.result.current.status).toBe("conflict");
      act(() => hook.result.current.change("more"));
      await act(() => hook.result.current.flush());
      expect(save).toHaveBeenCalledTimes(1);
      act(() => hook.result.current.reset());
      expect(hook.result.current.status).toBe("idle");
      hook.unmount();
      expect(save).toHaveBeenCalledTimes(1);
   });

   it("keeps a failed value for the next try", async () => {
      const save = vi.fn(async (_: string) => {}).mockRejectedValueOnce(new Error("disk full"));
      const { hook } = setup(save);
      act(() => hook.result.current.change("keep"));
      await act(() => hook.result.current.flush());
      expect(hook.result.current.status).toBe("error");
      expect(hook.result.current.error).toContain("disk full");
      await act(() => hook.result.current.flush());
      expect(save.mock.calls).toEqual([["keep"], ["keep"]]);
      expect(hook.result.current.status).toBe("saved");
   });
});
