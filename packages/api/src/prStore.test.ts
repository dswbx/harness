import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionApi } from "./client";
import type { PrInfo, PrRefKey } from "./generated";
import { MockTransport } from "./mock";
import { createPrSearch, createPrStore, PR_BATCH } from "./prStore";

const key = (full: string, number: number): PrRefKey => {
   const [owner, name] = full.split("/") as [string, string];
   return { repo: { owner, name }, number };
};
let now = 0;
beforeEach(() => {
   vi.useFakeTimers();
   now = 1_000_000;
});
afterEach(() => vi.useRealTimers());

/** A fake `lookupPrs` that records its calls and answers from `prs` (or fails). */
function fake(prs: Record<string, Partial<PrInfo>>) {
   const calls: PrRefKey[][] = [];
   let fail = false;
   const api = {
      lookupPrs: async (refs: PrRefKey[]) => {
         calls.push(refs);
         if (fail) throw new Error("gh: not logged in");
         return refs.map(
            (r) =>
               (prs[`${r.repo.owner}/${r.repo.name}#${r.number}`] as PrInfo | undefined) ?? null,
         );
      },
   };
   return { api, calls, setFail: (f: boolean) => (fail = f) };
}

it("batches lookups within the delay into one call, and caches by state", async () => {
   const { api, calls } = fake({ "o/r#1": { state: "open" }, "o/r#2": { state: "merged" } });
   const store = createPrStore(api, { now: () => now });
   const seen = vi.fn();
   store.subscribe(seen);
   for (const n of [1, 2, 3, 1]) store.request(key("o/r", n));
   expect(store.peek(key("o/r", 1))).toEqual({ status: "loading" });
   await vi.advanceTimersByTimeAsync(30);
   expect(calls).toHaveLength(1);
   expect(calls[0]!.map((k) => k.number)).toEqual([1, 2, 3]);
   expect(seen).toHaveBeenCalledTimes(1);
   expect(store.peek(key("o/r", 1))).toMatchObject({ status: "found", pr: { state: "open" } });
   expect(store.peek(key("o/r", 3))).toEqual({ status: "missing" });

   // Open: 60s; merged: 24h; not found: 10min.
   now += 61_000;
   for (const n of [1, 2, 3]) store.request(key("o/r", n));
   await vi.advanceTimersByTimeAsync(30);
   expect(calls[1]!.map((k) => k.number)).toEqual([1]);
   now += 10 * 60_000;
   for (const n of [2, 3]) store.request(key("o/r", n));
   await vi.advanceTimersByTimeAsync(30);
   expect(calls[2]!.map((k) => k.number)).toEqual([3]);
});

it(`splits more than ${PR_BATCH} refs into several calls`, async () => {
   const { api, calls } = fake({});
   const store = createPrStore(api, { now: () => now });
   for (let n = 1; n <= PR_BATCH + 3; n++) store.request(key("o/r", n));
   await vi.advanceTimersByTimeAsync(30);
   expect(calls.map((c) => c.length)).toEqual([PR_BATCH, 3]);
});

it("marks refs unavailable when the lookup fails and retries after a backoff", async () => {
   const { api, calls, setFail } = fake({ "o/r#1": { state: "open" } });
   const store = createPrStore(api, { now: () => now });
   store.request(key("o/r", 1));
   await vi.advanceTimersByTimeAsync(30);
   setFail(true);
   store.request(key("o/r", 2));
   now += 61_000;
   store.request(key("o/r", 1));
   await vi.advanceTimersByTimeAsync(30);
   expect(store.peek(key("o/r", 2))).toEqual({ status: "unavailable" });
   // A PR already shown stays shown.
   expect(store.peek(key("o/r", 1))).toMatchObject({ status: "found" });
   store.request(key("o/r", 2));
   await vi.advanceTimersByTimeAsync(30);
   expect(calls).toHaveLength(2);
   setFail(false);
   now += 5_000;
   store.request(key("o/r", 2));
   await vi.advanceTimersByTimeAsync(30);
   expect(calls).toHaveLength(3);
   expect(store.peek(key("o/r", 2))).toEqual({ status: "missing" });
});

it("works against the mock transport", async () => {
   vi.useRealTimers();
   const store = createPrStore(createSessionApi(new MockTransport([], []), "mock-s1"));
   const done = new Promise<void>((r) => store.subscribe(r));
   store.request(key("supabase/spark", 17));
   store.request(key("dswbx/harness", 999));
   await done;
   expect(store.peek(key("supabase/spark", 17))).toMatchObject({
      status: "found",
      pr: { title: "Edge runtime: stream request bodies" },
   });
   expect(store.peek(key("dswbx/harness", 999))).toEqual({ status: "missing" });
});

it("search: cached per repo and query (case-insensitive), failures not cached, results seed the store", async () => {
   const calls: (string | null)[] = [];
   let fail = false;
   const pr = { repo: { owner: "o", name: "r" }, number: 7, state: "merged" } as PrInfo;
   const api = {
      searchPrs: async (_repo: unknown, query: string | null = null) => {
         calls.push(query);
         if (fail) throw new Error("gh missing");
         return [pr];
      },
      lookupPrs: async () => [],
   };
   const store = createPrStore(api, { now: () => now });
   const search = createPrSearch(api, store, { now: () => now });
   const r = { owner: "o", name: "r" };
   expect(search.peek(r, null)).toBeUndefined();
   await Promise.all([search.get(r, null), search.get(r, null)]);
   expect(await search.get({ owner: "O", name: "R" }, null)).toEqual([pr]);
   expect(calls).toEqual([null]);
   expect(search.peek(r, null)).toEqual([pr]);
   expect(store.peek(key("o/r", 7))).toEqual({ status: "found", pr });
   fail = true;
   await expect(search.get(r, " fix ")).rejects.toThrow();
   await expect(search.get(r, "fix")).rejects.toThrow();
   expect(calls).toEqual([null, "fix", "fix"]);
   now += 61_000;
   expect(search.peek(r, null)).toBeUndefined();
});
