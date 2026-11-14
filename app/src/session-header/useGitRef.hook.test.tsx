import { HarnessClient, type SessionSummary } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGitRef } from "./useGitRef";

const client = () => new HarnessClient(new MockTransport([], []));

async function repoSession(c: HarnessClient): Promise<SessionSummary> {
   const s = (await c.listSessions()).find((x) => x.workspace.repo_root);
   if (!s) throw new Error("the mock has no repository Session");
   return s;
}

describe("useGitRef", () => {
   it("a Session without a repository has no git ref and asks nothing", async () => {
      const c = client();
      const api = vi.spyOn(c, "sessionApi");
      const none = { ...(await repoSession(c)), workspace: { repo_root: null } } as SessionSummary;
      const hook = renderHook(() => useGitRef(c, none));
      expect(hook.result.current).toMatchObject({ status: null, repo: null, pr: null, base: null });
      expect(api).not.toHaveBeenCalled();
      expect(hook.result.current.refreshing).toBe(false);
   });

   it("loads status and the PR of a repository Session", async () => {
      const c = client();
      const s = await repoSession(c);
      const hook = renderHook(() => useGitRef(c, s));
      await waitFor(() => expect(hook.result.current.status).not.toBeNull());
      await waitFor(() => expect(hook.result.current.base).not.toBeNull());
      expect(hook.result.current.refreshing).toBe(false);
   });

   it("refresh reloads, bypassing the cache, and shows refreshing until it loaded", async () => {
      const c = client();
      const s = await repoSession(c);
      const hook = renderHook(() => useGitRef(c, s));
      await waitFor(() => expect(hook.result.current.status).not.toBeNull());
      const bypass: unknown[] = [];
      const orig = c.sessionApi.bind(c);
      vi.spyOn(c, "sessionApi").mockImplementation((id) => {
         const api = orig(id);
         const branchPr = api.branchPr.bind(api);
         api.branchPr = ((b?: boolean) => (bypass.push(b), branchPr(b))) as typeof api.branchPr;
         return api;
      });
      act(() => hook.result.current.refresh());
      await waitFor(() => expect(bypass).toContain(true));
      await waitFor(() => expect(hook.result.current.refreshing).toBe(false));
   });

   it("dropping to no Session clears the ref", async () => {
      const c = client();
      const s = await repoSession(c);
      const hook = renderHook((p: { s: SessionSummary | null }) => useGitRef(c, p.s), {
         initialProps: { s: s as SessionSummary | null },
      });
      await waitFor(() => expect(hook.result.current.status).not.toBeNull());
      hook.rerender({ s: null });
      await waitFor(() => expect(hook.result.current.status).toBeNull());
      expect(hook.result.current.pr).toBeNull();
   });
});
