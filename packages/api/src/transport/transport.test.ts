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

import type { AppEvent, Event } from "../generated";
import { createAppSubscriber, type TerminalOutput, tauriTransport } from "./transport";

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

describe("tauriTransport.subscribe", () => {
   const logEvent = { v: 1, seq: 3, session_id: "s1", thread_id: null, kind: {} } as Event;

   it("opens a core channel for the Session and delivers Events", async () => {
      invoke.mockResolvedValue(7);
      const got: Event[] = [];
      await tauriTransport.subscribe("s1", 3, (e) => got.push(e));
      expect(invoke).toHaveBeenCalledWith("subscribe", {
         sessionId: "s1",
         fromSeq: 3,
         channel: channels[0],
      });
      channels[0].onmessage?.(logEvent);
      expect(got).toEqual([logEvent]);
   });

   it("calls onLagged for the core's Lagged message, not onEvent", async () => {
      const onEvent = vi.fn();
      const onLagged = vi.fn();
      await tauriTransport.subscribe("s1", 0, onEvent, onLagged);
      channels[0].onmessage?.({ last_seq: 5 });
      expect(onLagged).toHaveBeenCalledTimes(1);
      expect(onEvent).not.toHaveBeenCalled();
   });

   it("does not fail on Lagged without an onLagged callback", async () => {
      await tauriTransport.subscribe("s1", 0, () => {});
      expect(() => channels[0].onmessage?.({ last_seq: 5 })).not.toThrow();
   });

   it("unsubscribes with the id the core returned, and ignores a failing unsubscribe", async () => {
      invoke.mockResolvedValueOnce(42);
      const off = await tauriTransport.subscribe("s1", 0, () => {});
      invoke.mockRejectedValueOnce(new Error("gone"));
      expect(() => off()).not.toThrow();
      expect(invoke).toHaveBeenLastCalledWith("unsubscribe", { sessionId: "s1", id: 42 });
      await Promise.resolve();
   });
});

describe("tauriTransport.attachTerminal", () => {
   const bytes = (...b: number[]) => new Uint8Array(b).buffer;
   const attach = async () => {
      invoke.mockResolvedValue(9);
      const out: TerminalOutput[] = [];
      const off = await tauriTransport.attachTerminal("s1", 2, 80, 24, (o) => out.push(o));
      return { out, off, send: (m: unknown) => channels[0].onmessage?.(m) };
   };

   it("attaches with the size and the channel", async () => {
      await attach();
      expect(invoke).toHaveBeenCalledWith("terminal_attach", {
         sessionId: "s1",
         terminalId: 2,
         cols: 80,
         rows: 24,
         channel: channels[0],
      });
   });

   it("bytes before the replayed marker are the replay, bytes after are live, exit ends", async () => {
      const { out, send } = await attach();
      send(bytes(1, 2));
      expect(out).toEqual([]);
      send({ replayed: true });
      send(bytes(3));
      send(bytes(4, 5));
      send({ exit: 0 });
      expect(out).toEqual([
         { replay: new Uint8Array([1, 2]) },
         new Uint8Array([3]),
         new Uint8Array([4, 5]),
         { exit: 0 },
      ]);
   });

   it("delivers an empty replay when the marker comes first", async () => {
      const { out, send } = await attach();
      send({ replayed: true });
      expect(out).toEqual([{ replay: new Uint8Array() }]);
   });

   it("passes a shell that ended without an exit code", async () => {
      const { out, send } = await attach();
      send({ replayed: true });
      send({ exit: null });
      expect(out.at(-1)).toEqual({ exit: null });
   });

   it("detaches with the id the core returned and drops later output", async () => {
      const { out, off, send } = await attach();
      send({ replayed: true });
      off();
      expect(invoke).toHaveBeenLastCalledWith("terminal_detach", {
         sessionId: "s1",
         terminalId: 2,
         id: 9,
      });
      send(bytes(1));
      send({ exit: 1 });
      expect(out).toEqual([{ replay: new Uint8Array() }]);
   });
});
