import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const channels: { onmessage?: (e: unknown) => void }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
   invoke: (...args: unknown[]) => invoke(...args),
   convertFileSrc: () => "",
   Channel: class {
      onmessage?: (e: unknown) => void;
      constructor() {
         channels.push(this);
      }
   },
}));

import type { AppEvent } from "./generated";
import { createAppSubscriber } from "./transport";

const event = { type: "SharedArtifactsChanged" } as AppEvent;

beforeEach(() => {
   invoke.mockReset();
   invoke.mockResolvedValue(1);
   channels.length = 0;
});

describe("createAppSubscriber", () => {
   it("opens one core channel for many subscribe/unsubscribe cycles", async () => {
      const subscribeApp = createAppSubscriber();
      for (const off of await Promise.all([subscribeApp(() => {}), subscribeApp(() => {})])) off();
      for (let i = 0; i < 5; i++) (await subscribeApp(() => {}))();
      const calls = invoke.mock.calls.filter((c) => c[0] === "subscribe_app");
      expect(calls).toHaveLength(1);
      expect(channels).toHaveLength(1);
   });

   it("delivers to live listeners only, and a throwing listener does not stop the rest", async () => {
      const subscribeApp = createAppSubscriber();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const a = vi.fn();
      const b = vi.fn();
      const bad = vi.fn(() => {
         throw new Error("boom");
      });
      const offA = await subscribeApp(a);
      await subscribeApp(bad);
      await subscribeApp(b);
      channels[0].onmessage?.(event);
      offA();
      channels[0].onmessage?.(event);
      expect(a).toHaveBeenCalledTimes(1);
      expect(bad).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
   });

   it("retries after a failed first invoke", async () => {
      const subscribeApp = createAppSubscriber();
      invoke.mockRejectedValueOnce(new Error("nope"));
      await expect(subscribeApp(() => {})).rejects.toThrow("nope");
      const got = vi.fn();
      await subscribeApp(got);
      expect(invoke).toHaveBeenCalledTimes(2);
      channels[1].onmessage?.(event);
      expect(got).toHaveBeenCalledTimes(1);
   });
});
