import type { PrInfo, PrSearch, PrStore, RepoId } from "@harness/api";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePrMenu } from "./PromptMenu";
import type { PrRefs } from "./prRefs";

const harness: RepoId = { owner: "dswbx", name: "harness" };
const pr = (number: number, title: string): PrInfo => ({
   repo: harness,
   number,
   title,
   author: "me",
   state: "open",
   checks: "none",
   checks_passed: 0,
   checks_total: 0,
   additions: 0,
   deletions: 0,
   changed_files: 0,
   updated_at: "2026-01-01T00:00:00Z",
   url: `https://github.com/dswbx/harness/pull/${number}`,
});

/** A search whose results the test settles by hand, per query. */
function fakeRefs() {
   const calls = new Map<
      string,
      { resolve: (p: PrInfo[]) => void; reject: (e: unknown) => void }
   >();
   const cache = new Map<string, PrInfo[]>();
   const search: PrSearch = {
      peek: (_repo: RepoId, query?: string | null) => cache.get(query ?? ""),
      get: vi.fn(
         (_repo: RepoId, query?: string | null) =>
            new Promise<PrInfo[]>((resolve, reject) => {
               calls.set(query ?? "", {
                  resolve: (p) => {
                     cache.set(query ?? "", p);
                     resolve(p);
                  },
                  reject,
               });
            }),
      ),
   } as unknown as PrSearch;
   const store: PrStore = {
      peek: () => ({ status: "loading" }),
      request: () => {},
      subscribe: () => () => {},
      seed: () => {},
   };
   const refs: PrRefs = {
      ctx: { sessionRepo: harness, knownRepos: [] },
      store,
      search,
      me: null,
   };
   return { refs, search, calls };
}

const titles = (m: ReturnType<typeof usePrMenu>) =>
   m?.rows.map((r) => (r.kind === "pr" ? r.pr.title : "repo"));
const searched = (calls: Map<string, unknown>, q: string) =>
   waitFor(() => expect(calls.has(q)).toBe(true));

describe("usePrMenu", () => {
   it("is null without a token, without refs, or for a token that is no menu", () => {
      const { refs } = fakeRefs();
      expect(renderHook(() => usePrMenu(null, refs)).result.current).toBeNull();
      expect(renderHook(() => usePrMenu("#fix", null)).result.current).toBeNull();
      expect(renderHook(() => usePrMenu("nope", refs)).result.current).toBeNull();
   });

   it("loads the rows of a title search after the typing pause", async () => {
      const { refs, search, calls } = fakeRefs();
      const { result } = renderHook(() => usePrMenu("#fix", refs));
      expect(result.current).toMatchObject({ rows: [], loading: true });
      await searched(calls, "fix");
      expect(search.get).toHaveBeenCalledTimes(1);
      calls.get("fix")!.resolve([pr(1, "fix a"), pr(2, "fix b")]);
      await waitFor(() => expect(titles(result.current)).toEqual(["fix a", "fix b"]));
      expect(result.current?.loading).toBe(false);
   });

   it("two searches resolving out of order: the newer one is shown", async () => {
      const { refs, calls } = fakeRefs();
      const { result, rerender } = renderHook(({ t }) => usePrMenu(t, refs), {
         initialProps: { t: "#fi" },
      });
      await searched(calls, "fi");
      rerender({ t: "#fix" });
      await searched(calls, "fix");
      // The newer search answers first, the older one after: it must not win.
      calls.get("fix")!.resolve([pr(2, "fix new")]);
      await waitFor(() => expect(titles(result.current)).toEqual(["fix new"]));
      calls.get("fi")!.resolve([pr(1, "fi old")]);
      await new Promise((r) => setTimeout(r, 20));
      expect(titles(result.current)).toEqual(["fix new"]);
   });

   it("while a newer search of the same repo runs, the last rows stay", async () => {
      const { refs, calls } = fakeRefs();
      const { result, rerender } = renderHook(({ t }) => usePrMenu(t, refs), {
         initialProps: { t: "#fi" },
      });
      await searched(calls, "fi");
      calls.get("fi")!.resolve([pr(1, "fi old")]);
      await waitFor(() => expect(titles(result.current)).toEqual(["fi old"]));
      rerender({ t: "#fix" });
      expect(titles(result.current)).toEqual(["fi old"]);
      await searched(calls, "fix");
      expect(result.current?.loading).toBe(true);
      calls.get("fix")!.resolve([pr(2, "fix new")]);
      await waitFor(() => expect(titles(result.current)).toEqual(["fix new"]));
      expect(result.current?.loading).toBe(false);
   });

   it("a failed search gives no popup", async () => {
      const { refs, calls } = fakeRefs();
      const { result } = renderHook(() => usePrMenu("#fix", refs));
      await searched(calls, "fix");
      calls.get("fix")!.reject(new Error("no gh"));
      await waitFor(() => expect(result.current).toBeNull());
   });

   it("a search with nothing found gives no popup", async () => {
      const { refs, calls } = fakeRefs();
      const { result } = renderHook(() => usePrMenu("#zzz", refs));
      await searched(calls, "zzz");
      calls.get("zzz")!.resolve([]);
      await waitFor(() => expect(result.current).toBeNull());
   });

   it("a repo prefix that matches several repos lists repos without searching", () => {
      const { refs, search } = fakeRefs();
      const many: PrRefs = {
         ...refs,
         ctx: {
            sessionRepo: harness,
            knownRepos: [
               { repo: harness, sessions: 9, score: 4.2, last_ms: 0 },
               { repo: { owner: "supabase", name: "spark" }, sessions: 4, score: 2.1, last_ms: 0 },
               {
                  repo: { owner: "supabase", name: "supabase" },
                  sessions: 3,
                  score: 1.1,
                  last_ms: 0,
               },
               { repo: { owner: "supabase", name: "lite" }, sessions: 2, score: 0.6, last_ms: 0 },
               { repo: { owner: "dswbx", name: "spikes" }, sessions: 3, score: 1.8, last_ms: 0 },
            ],
         },
      };
      const { result } = renderHook(() => usePrMenu("sp#", many));
      expect(result.current?.state.mode).toBe("repos");
      expect(titles(result.current)).toEqual(["repo", "repo", "repo"]);
      expect(search.get).not.toHaveBeenCalled();
   });
});
