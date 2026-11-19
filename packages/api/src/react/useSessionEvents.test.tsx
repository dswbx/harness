import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionApi } from "../client/client";
import type { Event } from "../generated";
import { useSessionEvents } from "./hooks";

const FRAME = 16;
const OLD = Date.UTC(2020, 0, 1);

beforeEach(() => {
   vi.useFakeTimers({
      toFake: [
         "setTimeout",
         "clearTimeout",
         "requestAnimationFrame",
         "cancelAnimationFrame",
         "performance",
         "Date",
      ],
   });
});
afterEach(() => vi.useRealTimers());

/** A view that counts Events, and what it rendered each time. */
function setup() {
   let emit!: (e: Event) => void;
   const unsub = vi.fn();
   const api = {
      subscribe: async (on: (e: Event) => void) => {
         emit = on;
         return unsub;
      },
      warmUp: async () => {},
   } as unknown as SessionApi;
   const renders: number[] = [];
   const add = (n: number) => n + 1;
   const zero = () => 0;
   function View() {
      const n = useSessionEvents(api, add, zero);
      if (renders.at(-1) !== n) renders.push(n);
      return null;
   }
   const view = render(<View />);
   let seq = 0;
   const send = (count: number, ts = OLD) => {
      for (let i = 0; i < count; i++) emit({ seq: seq++, ts_ms: ts } as Event);
   };
   const frames = (n: number) => act(() => vi.advanceTimersByTimeAsync(n * FRAME));
   return { view, send, frames, renders, unsub };
}

it("renders a replay that comes in over several frames at once", async () => {
   const { send, frames, renders } = setup();
   await frames(1);
   for (let i = 0; i < 5; i++) {
      send(50);
      await frames(1);
   }
   expect(renders).toEqual([0]);
   await frames(2);
   expect(renders).toEqual([0, 250]);
});

it("a frame with no Event between two parts of the replay does not end the wait", async () => {
   const { send, frames, renders } = setup();
   await frames(1);
   send(50);
   // Two frames back to back after a long task: the second sees no new Event.
   await frames(2);
   expect(renders).toEqual([0]);
   send(50);
   await frames(4);
   expect(renders).toEqual([0, 100]);
});

it("renders live Events in the next frame once the replay is shown", async () => {
   const { send, frames, renders } = setup();
   await frames(1);
   send(10);
   await frames(3);
   expect(renders).toEqual([0, 10]);
   // Every frame brings Events again: no second wait.
   send(1, Date.now());
   await frames(1);
   send(1, Date.now());
   await frames(1);
   expect(renders).toEqual([0, 10, 11, 12]);
});

it("does not wait for a pause when the replay reaches Events from just now (a running Agent)", async () => {
   const { send, frames, renders } = setup();
   await frames(1);
   send(100);
   await frames(1);
   // The Agent streams: an Event every frame, for longer than the cap.
   for (let i = 0; i < 4; i++) {
      send(1, Date.now());
      await frames(1);
   }
   expect(renders.length).toBeGreaterThan(1);
   expect(renders[1]).toBeGreaterThanOrEqual(101);
});

it("shows what it has after a second when old Events keep coming every frame", async () => {
   const { send, frames, renders } = setup();
   await frames(1);
   for (let t = 0; t < 900; t += FRAME) {
      send(5);
      await frames(1);
   }
   expect(renders).toEqual([0]);
   for (let t = 0; t < 200; t += FRAME) {
      send(5);
      await frames(1);
   }
   expect(renders.length).toBeGreaterThan(1);
});

it("a slow replay (pauses longer than a frame) shows in parts, never stalls", async () => {
   const { send, frames, renders } = setup();
   await frames(1);
   send(10);
   await frames(4);
   send(10);
   await frames(4);
   expect(renders).toEqual([0, 10, 20]);
});

it("unmounting while it waits unsubscribes and renders nothing more", async () => {
   const { view, send, frames, renders, unsub } = setup();
   await frames(1);
   send(10);
   view.unmount();
   expect(unsub).toHaveBeenCalledTimes(1);
   send(10);
   await frames(5);
   expect(renders).toEqual([0]);
   expect(vi.getTimerCount()).toBe(0);
});
