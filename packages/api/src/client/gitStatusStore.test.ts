// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitStatus, WorkspaceInfo } from "../generated";
import { createGitStatusStore, GIT_POLL_MS, gitStatusStore } from "./gitStatusStore";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const status = (branch = "main"): GitStatus =>
   ({ branch, ahead: 0, behind: 0, files: [] }) as never;

function fake(sessionId = "s1", repo = true) {
   const o = {
      repo,
      fail: false,
      branch: "main",
      gate: null as Promise<void> | null,
      statusCalls: 0,
      workspaceCalls: 0,
   };
   const api = {
      sessionId,
      workspace: async () => {
         o.workspaceCalls++;
         return (o.repo ? { repo_root: "/r" } : { repo_root: null }) as WorkspaceInfo;
      },
      gitStatus: async () => {
         o.statusCalls++;
         if (o.gate) await o.gate;
         if (o.fail) throw new Error("git failed");
         return status(o.branch);
      },
   };
   return { api, o };
}

it("one poll for N subscribers, none after the last leaves", async () => {
   const { api, o } = fake();
   const store = createGitStatusStore(api);
   const offs = [1, 2, 3].map(() => store.subscribe(() => {}));
   await vi.advanceTimersByTimeAsync(0);
   expect(o.statusCalls).toBe(1);
   await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
   expect(o.statusCalls).toBe(2);
   offs.slice(0, 2).forEach((f) => f());
   await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
   expect(o.statusCalls).toBe(3);
   offs[2]!();
   await vi.advanceTimersByTimeAsync(GIT_POLL_MS * 3);
   expect(o.statusCalls).toBe(3);
   expect(vi.getTimerCount()).toBe(0);
});

it("a focus triggers one refresh for all subscribers", async () => {
   const { api, o } = fake();
   const store = createGitStatusStore(api);
   store.subscribe(() => {});
   store.subscribe(() => {});
   await vi.advanceTimersByTimeAsync(0);
   const before = o.statusCalls;
   window.dispatchEvent(new Event("focus"));
   await vi.advanceTimersByTimeAsync(0);
   expect(o.statusCalls).toBe(before + 1);
});

it("refresh() shares a load in flight", async () => {
   const { api, o } = fake();
   let open!: () => void;
   o.gate = new Promise((r) => (open = r));
   const store = createGitStatusStore(api);
   store.subscribe(() => {});
   const a = store.refresh();
   const b = store.refresh();
   expect(a).toBe(b);
   open();
   await a;
   expect(o.statusCalls).toBe(1);
   expect(store.peek().status?.branch).toBe("main");
});

it("keeps the last status on an error and clears it on the next success", async () => {
   const { api, o } = fake();
   const store = createGitStatusStore(api);
   store.subscribe(() => {});
   await vi.advanceTimersByTimeAsync(0);
   o.fail = true;
   await store.refresh();
   expect(store.peek()).toMatchObject({ error: "git failed", isRepo: true });
   expect(store.peek().status?.branch).toBe("main");
   o.fail = false;
   await store.refresh();
   expect(store.peek().error).toBeNull();
});

it("not a repo: no status calls; becoming one starts them", async () => {
   const { api, o } = fake("s1", false);
   const store = createGitStatusStore(api);
   store.subscribe(() => {});
   await vi.advanceTimersByTimeAsync(0);
   expect(store.peek()).toMatchObject({ isRepo: false, status: null });
   expect(o.statusCalls).toBe(0);
   o.repo = true;
   await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
   expect(store.peek().isRepo).toBe(true);
   expect(o.statusCalls).toBe(1);
});

it("only isRepo subscribers do not load the status", async () => {
   const { api, o } = fake();
   const store = createGitStatusStore(api);
   const off = store.subscribe(() => {}, { status: false });
   await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
   expect(store.peek().isRepo).toBe(true);
   expect(o.statusCalls).toBe(0);
   store.subscribe(() => {});
   await vi.advanceTimersByTimeAsync(0);
   expect(o.statusCalls).toBe(1);
   off();
});

it("counts changes only when the status differs", async () => {
   const { api, o } = fake();
   const store = createGitStatusStore(api);
   store.subscribe(() => {});
   await vi.advanceTimersByTimeAsync(0);
   await store.refresh();
   expect(store.peek().changes).toBe(0);
   o.branch = "dev";
   await store.refresh();
   expect(store.peek().changes).toBe(1);
});

it("Sessions are independent, and the shared store is dropped when idle", async () => {
   const a = fake("a");
   const b = fake("b");
   expect(gitStatusStore(a.api)).toBe(gitStatusStore(a.api));
   expect(gitStatusStore(a.api)).not.toBe(gitStatusStore(b.api));
   const offA = gitStatusStore(a.api).subscribe(() => {});
   const offB = gitStatusStore(b.api).subscribe(() => {});
   await vi.advanceTimersByTimeAsync(0);
   offA();
   await vi.advanceTimersByTimeAsync(GIT_POLL_MS);
   expect(a.o.statusCalls).toBe(1);
   expect(b.o.statusCalls).toBe(2);
   offB();
});
