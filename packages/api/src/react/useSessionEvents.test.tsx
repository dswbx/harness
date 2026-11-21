import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionApi } from "../client/client";
import type { Event } from "../generated";
import { forgetSession } from "../platform/forgetSession";
import { clearFoldCache, useSessionEvents } from "./hooks";

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
afterEach(() => {
   vi.useRealTimers();
   clearFoldCache();
});

/** A view that counts Events, and what it rendered each time. */
function setup() {
   let emit!: (e: Event) => void;
   const unsub = vi.fn();
   const api = {
      sessionId: "s1",
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

const add = (n: number) => n + 1;
const zero = () => 0;

/**
 * A Session with a log that Views mount and unmount on: `append` adds Events (live to every
 * subscriber), `mount` renders a View of it, `from` lists the `seq` each subscribe started at.
 */
function session(id: string) {
   const log: Event[] = [];
   const subs = new Set<(e: Event) => void>();
   const from: number[] = [];
   const api = {
      sessionId: id,
      subscribe: async (on: (e: Event) => void, fromSeq = 0) => {
         from.push(fromSeq);
         for (const e of log) if (e.seq >= fromSeq) on(e);
         subs.add(on);
         return () => void subs.delete(on);
      },
      warmUp: async () => {},
   } as unknown as SessionApi;
   const append = (count: number, ts = OLD) => {
      for (let i = 0; i < count; i++) {
         const e = { seq: log.length, ts_ms: ts } as Event;
         log.push(e);
         for (const on of subs) on(e);
      }
   };
   const mount = (strict = false) => {
      const renders: number[] = [];
      function View() {
         const n = useSessionEvents(api, add, zero);
         renders.push(n);
         return null;
      }
      const view = render(
         strict ? (
            <StrictMode>
               <View />
            </StrictMode>
         ) : (
            <View />
         ),
      );
      return { view, renders };
   };
   return { append, mount, from, subs };
}

const frames = (n: number) => act(() => vi.advanceTimersByTimeAsync(n * FRAME));

it("a Session shown before renders its fold at once and subscribes from the next seq", async () => {
   const s = session("a");
   s.append(30);
   const first = s.mount();
   await frames(5);
   expect(first.renders.at(-1)).toBe(30);
   first.view.unmount();
   s.append(5);
   const again = s.mount();
   // The first render is the cached fold: no `0`, no wait for a replay.
   expect(again.renders[0]).toBe(30);
   expect(s.from).toEqual([0, 30]);
   await frames(1);
   expect(again.renders.at(-1)).toBe(35);
});

it("live Events after a cache hit fold on top of the cached fold", async () => {
   const s = session("a");
   s.append(10);
   s.mount().view.unmount();
   // Unmounted before the replay was folded: nothing cached, the next mount replays from 0.
   const second = s.mount();
   expect(s.from).toEqual([0, 0]);
   await frames(5);
   second.view.unmount();
   const third = s.mount();
   expect(third.renders[0]).toBe(10);
   await frames(1);
   s.append(1, Date.now());
   await frames(1);
   s.append(2, Date.now());
   await frames(1);
   expect(third.renders.at(-1)).toBe(13);
   third.view.unmount();
   expect(s.mount().renders[0]).toBe(13);
   expect(s.from.at(-1)).toBe(13);
});

it("keeps the folds of the five most recently shown Sessions", async () => {
   const all = ["a", "b", "c", "d", "e", "f"].map(session);
   for (const s of all) {
      s.append(4);
      const v = s.mount();
      await frames(5);
      v.view.unmount();
   }
   // `a` was shown first: evicted by `f`.
   expect(all[0].mount().renders[0]).toBe(0);
   expect(all[0].from).toEqual([0, 0]);
   // Showing `b` makes it the newest, so mounting `a` again (above) evicted `c`, not `b`.
   expect(all[1].mount().renders[0]).toBe(4);
   expect(all[1].from).toEqual([0, 4]);
});

it("a forgotten (deleted) Session loses its fold", async () => {
   const s = session("a");
   s.append(3);
   const v = s.mount();
   await frames(5);
   v.view.unmount();
   forgetSession("a");
   expect(s.mount().renders[0]).toBe(0);
   expect(s.from).toEqual([0, 0]);
});

it("StrictMode: mount, unmount, mount folds each Event once and caches the right seq", async () => {
   const s = session("a");
   s.append(20);
   const first = s.mount(true);
   await frames(5);
   expect(first.renders.at(-1)).toBe(20);
   // Only the second effect's subscription is still open.
   expect(s.subs.size).toBe(1);
   s.append(2, Date.now());
   await frames(1);
   expect(first.renders.at(-1)).toBe(22);
   first.view.unmount();
   expect(s.subs.size).toBe(0);
   const again = s.mount(true);
   expect(again.renders[0]).toBe(22);
   await frames(2);
   expect(again.renders.at(-1)).toBe(22);
   expect(s.from.slice(-2)).toEqual([22, 22]);
});

it("two Views of one Session at once keep one correct cached fold", async () => {
   const s = session("a");
   s.append(10);
   const one = s.mount();
   await frames(5);
   const two = s.mount();
   expect(two.renders[0]).toBe(10);
   s.append(3, Date.now());
   await frames(1);
   expect([one.renders.at(-1), two.renders.at(-1)]).toEqual([13, 13]);
   one.view.unmount();
   s.append(2, Date.now());
   await frames(1);
   expect(two.renders.at(-1)).toBe(15);
   two.view.unmount();
   expect(s.mount().renders[0]).toBe(15);
   expect(s.from).toEqual([0, 10, 15]);
});
