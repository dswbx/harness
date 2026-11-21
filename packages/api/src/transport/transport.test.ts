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
import {
   createAppSubscriber,
   subscribeResilient,
   type TerminalOutput,
   type Transport,
   tauriTransport,
} from "./transport";

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

describe("tauriTransport.readLogPage", () => {
   it("asks the core for one page and hands back its answer", async () => {
      const page = { events: [], end: 7, more: false };
      invoke.mockResolvedValueOnce(page);
      expect(await tauriTransport.readLogPage("s1", 3, null)).toBe(page);
      expect(invoke).toHaveBeenCalledWith("read_log_page", {
         sessionId: "s1",
         fromSeq: 3,
         toSeq: null,
      });
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

describe("subscribeResilient", () => {
   it("closes a handle that resolves for an older open than the current one", async () => {
      const opens: { lagged?: () => void; resolve: (off: () => void) => void }[] = [];
      const transport = {
         subscribe: (_s: string, _from: number, _on: unknown, lagged?: () => void) =>
            new Promise<() => void>((resolve) => opens.push({ lagged, resolve })),
      } as unknown as Transport;
      const started = subscribeResilient(transport, "s1", 0, () => {}, { retryMs: 1 });
      // Lagged before the first subscribe has resolved: a second open starts.
      opens[0].lagged?.();
      await vi.waitFor(() => expect(opens).toHaveLength(2));
      const off1 = vi.fn();
      const off2 = vi.fn();
      // The second resolves first, then the older one.
      opens[1].resolve(off2);
      opens[0].resolve(off1);
      const unsubscribe = await started;
      await Promise.resolve();
      expect(off1).toHaveBeenCalledTimes(1);
      expect(off2).not.toHaveBeenCalled();
      unsubscribe();
      expect(off2).toHaveBeenCalledTimes(1);
   });

   it("tries a failed first open again and resolves once it is open", async () => {
      const froms: number[] = [];
      const off = vi.fn();
      const transport = {
         subscribe: async (_s: string, from: number) => {
            froms.push(from);
            if (froms.length < 3) throw new Error("down");
            return off;
         },
      } as unknown as Transport;
      const unsubscribe = await subscribeResilient(transport, "s1", 7, () => {}, { retryMs: 1 });
      expect(froms).toEqual([7, 7, 7]);
      unsubscribe();
      expect(off).toHaveBeenCalledTimes(1);
   });

   it("rejects when the first open still fails after the retries", async () => {
      let opens = 0;
      const transport = {
         subscribe: async () => {
            opens++;
            throw new Error("down");
         },
      } as unknown as Transport;
      await expect(
         subscribeResilient(transport, "s1", 0, () => {}, { retryMs: 1 }),
      ).rejects.toThrow("down");
      expect(opens).toBe(6);
   });

   it("stops retrying the first open when its signal aborts, and opens nothing", async () => {
      let opens = 0;
      const transport = {
         subscribe: async () => {
            opens++;
            throw new Error("down");
         },
      } as unknown as Transport;
      const stop = new AbortController();
      const started = subscribeResilient(transport, "s1", 0, () => {}, {
         retryMs: 1000,
         signal: stop.signal,
      });
      await vi.waitFor(() => expect(opens).toBe(1));
      stop.abort();
      const unsubscribe = await started;
      expect(opens).toBe(1);
      unsubscribe();
   });
});
