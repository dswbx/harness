import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionApi } from "../client/client";
import { coreApi } from "../client/session/core";
import type { Event } from "../generated";
import { MockTransport } from "../mock/mock";
import { forgetSession } from "../platform/forgetSession";
import { clearFoldCache, type LogLoad, useSessionEvents } from "./hooks";

const FRAME = 16;

beforeEach(() => {
   vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
   });
});
afterEach(() => {
   vi.useRealTimers();
   clearFoldCache();
});

/** The fold: every `seq` in order, so a gap or a duplicate shows. */
const seqs = (s: readonly number[], e: Event) => [...s, e.seq];
const EMPTY: readonly number[] = [];
const none = () => EMPTY;
const whole = (n: number, from = 0) => Array.from({ length: n - from }, (_, i) => from + i);

/**
 * A Session of the mock core that Views mount on, paged `pageEvents` at a time. `append` adds
 * Events (live to every subscriber); `afterRead` runs after each page is cut, before the View has
 * it; `reads` lists each page read, `from` each core subscribe, `open` the live subscriptions.
 */
function session(id = "s1", pageEvents = 1000) {
   const mock = new MockTransport([], []);
   mock.pageEvents = pageEvents;
   mock.logs.set(id, []);
   const from: number[] = [];
   const reads: [number, number | null][] = [];
   let open = 0;
   const subscribe = mock.subscribe.bind(mock);
   mock.subscribe = async (sid, fromSeq, onEvent, onLagged) => {
      from.push(fromSeq);
      const off = await subscribe(sid, fromSeq, onEvent, onLagged);
      open++;
      return () => {
         open--;
         off();
      };
   };
   const core = coreApi(mock, id);
   const s = {
      mock,
      from,
      reads,
      open: () => open,
      afterRead: (() => {}) as () => void,
      append: (count: number) => {
         for (let i = 0; i < count; i++) mock.emit(id, { type: "Error", message: "x" }, null);
      },
      api: {
         sessionId: id,
         subscribe: core.subscribe,
         readLogPage: async (fromSeq: number, toSeq: number | null = null) => {
            reads.push([fromSeq, toSeq]);
            const page = await core.readLogPage(fromSeq, toSeq);
            s.afterRead();
            return page;
         },
         warmUp: async () => {},
      } as unknown as SessionApi,
      mount: (strict = false) => {
         const renders: (readonly number[])[] = [];
         const loads: LogLoad[] = [];
         function View() {
            const got = useSessionEvents(s.api, seqs, none, undefined, (l) => loads.push(l));
            if (renders.at(-1) !== got) renders.push(got);
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
         return { view, renders, loads, sizes: () => renders.map((r) => r.length) };
      },
   };
   return s;
}

const frames = (n: number) => act(() => vi.advanceTimersByTimeAsync(n * FRAME));

it("reads the log in pages up to the first page's end and renders once, when it is whole", async () => {
   const s = session("s1", 40);
   s.append(250);
   const v = s.mount();
   await frames(1);
   expect(v.sizes()).toEqual([0, 250]);
   expect(v.renders.at(-1)).toEqual(whole(250));
   expect(s.reads).toEqual([[0, null], ...whole(7, 1).map((p) => [p * 40, 250])]);
   expect(s.from).toEqual([250]);
   // Progress after each page but the last, then whole.
   expect(v.loads.map((l) => l.next)).toEqual([40, 80, 120, 160, 200, 240, 250]);
   expect(v.loads.every((l) => l.end === 250)).toBe(true);
});

it("Events appended during the load fold on top of the pages, with no gap and no duplicate", async () => {
   const s = session("s1", 30);
   s.append(100);
   // After every page is cut: the first lands between the read of the end and the subscription,
   // the others while the live subscription is open and held.
   s.afterRead = () => s.append(3);
   const v = s.mount();
   await frames(1);
   s.afterRead = () => {};
   const total = 100 + 3 * s.reads.length;
   expect(s.from).toEqual([100]);
   expect(v.sizes()).toEqual([0, total]);
   expect(v.renders.at(-1)).toEqual(whole(total));
   // Live after the load: one render per frame.
   s.append(2);
   await frames(1);
   expect(v.renders.at(-1)).toEqual(whole(total + 2));
});

it("a resubscribe after Lagged, during the load or after it, leaves no gap and no duplicate", async () => {
   const s = session("s1", 10);
   s.append(50);
   s.afterRead = () => {
      s.append(2);
      if (s.reads.length === 3) s.mock.dropSubscribersAsLagged("s1");
   };
   const v = s.mount();
   await frames(1);
   s.afterRead = () => {};
   const total = 50 + 2 * s.reads.length;
   expect(v.renders.at(-1)).toEqual(whole(total));
   expect(s.from[0]).toBe(50);
   expect(s.from).toHaveLength(2);
   s.mock.dropSubscribersAsLagged("s1");
   await frames(1);
   s.append(3);
   await frames(1);
   expect(v.renders.at(-1)).toEqual(whole(total + 3));
   expect(s.from.at(-1)).toBe(total);
   expect(s.open()).toBe(1);
});

it("unmounting during the load stops the paging, unsubscribes and caches nothing", async () => {
   const s = session("s1", 10);
   s.append(100);
   let view: { unmount: () => void } | undefined;
   s.afterRead = () => {
      if (s.reads.length === 3) view?.unmount();
   };
   const v = s.mount();
   view = v.view;
   await frames(5);
   expect(s.reads).toHaveLength(3);
   expect(v.sizes()).toEqual([0]);
   expect(s.open()).toBe(0);
   expect(vi.getTimerCount()).toBe(0);
   // Nothing partial was cached: the next mount loads from 0.
   s.afterRead = () => {};
   const again = s.mount();
   expect(again.sizes()[0]).toBe(0);
   await frames(1);
   expect(s.reads.at(-10)).toEqual([0, null]);
   expect(again.renders.at(-1)).toEqual(whole(100));
});

it("a Session shown before renders its fold at once and loads only what came since", async () => {
   const s = session();
   s.append(30);
   const first = s.mount();
   await frames(1);
   expect(first.sizes().at(-1)).toBe(30);
   first.view.unmount();
   s.append(5);
   const again = s.mount();
   // The first render is the cached fold: no wait for the load.
   expect(again.sizes()[0]).toBe(30);
   await frames(1);
   expect(s.reads).toEqual([
      [0, null],
      [30, null],
   ]);
   expect(s.from).toEqual([30, 35]);
   expect(again.renders.at(-1)).toEqual(whole(35));
});

it("live Events after a cache hit fold on top of the cached fold", async () => {
   const s = session();
   s.append(10);
   const first = s.mount();
   await frames(1);
   first.view.unmount();
   const second = s.mount();
   expect(second.sizes()[0]).toBe(10);
   await frames(1);
   s.append(1);
   await frames(1);
   s.append(2);
   await frames(1);
   expect(second.renders.at(-1)).toEqual(whole(13));
   second.view.unmount();
   expect(s.mount().sizes()[0]).toBe(13);
   await frames(1);
   expect(s.reads.at(-1)).toEqual([13, null]);
});

it("keeps the folds of the five most recently shown Sessions", async () => {
   const all = ["a", "b", "c", "d", "e", "f"].map((id) => session(id));
   for (const s of all) {
      s.append(4);
      const v = s.mount();
      await frames(1);
      v.view.unmount();
   }
   // `a` was shown first: evicted by `f`.
   expect(all[0].mount().sizes()[0]).toBe(0);
   await frames(1);
   expect(all[0].reads.at(-1)).toEqual([0, null]);
   // Showing `a` again evicted `b`; `c` is still there.
   expect(all[2].mount().sizes()[0]).toBe(4);
});

it("a forgotten (deleted) Session loses its fold", async () => {
   const s = session("a");
   s.append(3);
   const v = s.mount();
   await frames(1);
   v.view.unmount();
   forgetSession("a");
   expect(s.mount().sizes()[0]).toBe(0);
});

it("StrictMode: mount, unmount, mount folds each Event once and caches the right seq", async () => {
   const s = session();
   s.append(20);
   const first = s.mount(true);
   await frames(1);
   expect(first.renders.at(-1)).toEqual(whole(20));
   // Only the second effect's subscription is still open.
   expect(s.open()).toBe(1);
   s.append(2);
   await frames(1);
   expect(first.renders.at(-1)).toEqual(whole(22));
   first.view.unmount();
   expect(s.open()).toBe(0);
   const again = s.mount(true);
   expect(again.sizes()[0]).toBe(22);
   await frames(2);
   expect(again.renders.at(-1)).toEqual(whole(22));
   expect(s.from.slice(-1)).toEqual([22]);
});

it("two Views of one Session at once keep one correct cached fold", async () => {
   const s = session();
   s.append(10);
   const one = s.mount();
   await frames(1);
   const two = s.mount();
   expect(two.sizes()[0]).toBe(10);
   await frames(1);
   s.append(3);
   await frames(1);
   expect([one.sizes().at(-1), two.sizes().at(-1)]).toEqual([13, 13]);
   one.view.unmount();
   s.append(2);
   await frames(1);
   expect(two.renders.at(-1)).toEqual(whole(15));
   two.view.unmount();
   expect(s.mount().sizes()[0]).toBe(15);
});
