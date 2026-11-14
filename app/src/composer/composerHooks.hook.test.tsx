import { type AgentInfo, type Branches, HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBranches } from "./useBranches";
import { useComposerCatalog } from "./useComposerCatalog";
import { usePullRequests } from "./usePullRequests";
import { useRecentFolders } from "./useRecentFolders";

const agent = (id: string) => ({ id, name: id }) as unknown as AgentInfo;

function mk() {
   const client = new HarnessClient(
      new MockTransport(
         [],
         [
            { id: "inspector", name: "Inspector", version: "1" },
            { id: "chat", name: "Chat", version: "1" },
         ],
      ),
   );
   vi.spyOn(client, "listAgents").mockResolvedValue([agent("a1"), agent("a2")]);
   return client;
}

describe("useComposerCatalog", () => {
   it("loads Agents, Frontends and MCP servers once open, preselecting the first Agent and chat", async () => {
      const client = mk();
      const setError = vi.fn();
      const hook = renderHook(
         (p: { isOpen: boolean }) =>
            useComposerCatalog({
               client,
               isOpen: p.isOpen,
               agentsVersion: 0,
               mcpVersion: 0,
               setError,
            }),
         { initialProps: { isOpen: false } },
      );
      expect(hook.result.current.agents).toEqual([]);
      hook.rerender({ isOpen: true });
      await waitFor(() => expect(hook.result.current.agents.length).toBeGreaterThan(0));
      const c = hook.result.current;
      expect(c.agentId).toBe(c.agents[0]!.id);
      expect(c.frontendId).toBe((c.frontends.find((f) => f.id === "chat") ?? c.frontends[0])!.id);
      expect(setError).not.toHaveBeenCalled();
   });

   it("drops picked MCP servers that no longer exist and reports a failed MCP load", async () => {
      const client = mk();
      const setError = vi.fn();
      const hook = renderHook(
         (p: { v: number }) =>
            useComposerCatalog({
               client,
               isOpen: true,
               agentsVersion: 0,
               mcpVersion: p.v,
               setError,
            }),
         { initialProps: { v: 0 } },
      );
      await waitFor(() => expect(hook.result.current.agents.length).toBeGreaterThan(0));
      act(() => hook.result.current.setMcpIds(["gone"]));
      expect(hook.result.current.mcpIds).toEqual(["gone"]);
      hook.rerender({ v: 1 });
      await waitFor(() => expect(hook.result.current.mcpIds).toEqual([]));

      vi.spyOn(client, "listMcpServers").mockRejectedValue(new Error("down"));
      hook.rerender({ v: 2 });
      await waitFor(() => expect(setError).toHaveBeenCalled());
      expect(String(setError.mock.calls[0]![0])).toContain("Could not load MCP servers");
      expect(hook.result.current.mcpServers).toEqual([]);
   });

   it("reports a failed Agent load", async () => {
      const client = mk();
      vi.spyOn(client, "listAgents").mockRejectedValue(new Error("nope"));
      const setError = vi.fn();
      renderHook(() =>
         useComposerCatalog({ client, isOpen: true, agentsVersion: 0, mcpVersion: 0, setError }),
      );
      await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringContaining("nope")));
   });
});

describe("useRecentFolders", () => {
   it("lists Session folders and preselects the newest, or the preset folder", async () => {
      const client = mk();
      const hook = renderHook(() =>
         useRecentFolders({ client, isOpen: true, presetFolder: null, folderOpen: false }),
      );
      await waitFor(() => expect(hook.result.current.recent.length).toBeGreaterThan(0));
      expect(hook.result.current.folder).toBe(hook.result.current.recent[0]!.path);
      expect(hook.result.current.noFolder).toBe(false);

      const preset = renderHook(() =>
         useRecentFolders({ client, isOpen: true, presetFolder: "/tmp/preset", folderOpen: false }),
      );
      await waitFor(() => expect(preset.result.current.folder).toBe("/tmp/preset"));
   });

   it("asks each folder's branch once per open of the list and drops the answers on close", async () => {
      const client = mk();
      const list = vi.spyOn(client, "listBranches");
      const hook = renderHook(
         (p: { folderOpen: boolean }) =>
            useRecentFolders({
               client,
               isOpen: true,
               presetFolder: null,
               folderOpen: p.folderOpen,
            }),
         { initialProps: { folderOpen: false } },
      );
      await waitFor(() => expect(hook.result.current.recent.length).toBeGreaterThan(0));
      expect(list).not.toHaveBeenCalled();
      hook.rerender({ folderOpen: true });
      await waitFor(() =>
         expect(Object.keys(hook.result.current.recentBranch).length).toBe(list.mock.calls.length),
      );
      expect(list.mock.calls.length).toBeGreaterThan(0);
      const calls = list.mock.calls.length;
      hook.rerender({ folderOpen: true });
      expect(list).toHaveBeenCalledTimes(calls);
      hook.rerender({ folderOpen: false });
      await waitFor(() => expect(hook.result.current.recentBranch).toEqual({}));
   });

   it("a folder that fails to list has no branch (not a repository)", async () => {
      const client = mk();
      vi.spyOn(client, "listBranches").mockRejectedValue(new Error("x"));
      const hook = renderHook(
         (p: { folderOpen: boolean }) =>
            useRecentFolders({
               client,
               isOpen: true,
               presetFolder: null,
               folderOpen: p.folderOpen,
            }),
         { initialProps: { folderOpen: false } },
      );
      await waitFor(() => expect(hook.result.current.recent.length).toBeGreaterThan(0));
      hook.rerender({ folderOpen: true });
      await waitFor(() => expect(Object.values(hook.result.current.recentBranch)).toContain(null));
   });
});

describe("useBranches", () => {
   it("loads the branches of a chosen folder after the debounce, and reports the first load", async () => {
      const client = mk();
      const setError = vi.fn();
      const onLoaded = vi.fn();
      const hook = renderHook(
         (p: { folder: string }) =>
            useBranches({ client, isOpen: true, folder: p.folder, setError, onLoaded }),
         { initialProps: { folder: "" } },
      );
      expect(hook.result.current.branches).toBeNull();
      hook.rerender({ folder: " /tmp/repo " });
      expect(hook.result.current.branches).toBeNull();
      await waitFor(() => expect(hook.result.current.branches?.repo_root).toBe("/tmp/repo"));
      expect(onLoaded).toHaveBeenCalledTimes(1);
      expect(onLoaded.mock.calls[0]![0]).toBe(hook.result.current.branches);
   });

   it("typing quickly asks only for the last folder", async () => {
      const client = mk();
      const list = vi.spyOn(client, "listBranches");
      const hook = renderHook(
         (p: { folder: string }) =>
            useBranches({
               client,
               isOpen: true,
               folder: p.folder,
               setError: vi.fn(),
               onLoaded: vi.fn(),
            }),
         { initialProps: { folder: "/tmp/a" } },
      );
      hook.rerender({ folder: "/tmp/ab" });
      hook.rerender({ folder: "/tmp/abc" });
      await waitFor(() => expect(hook.result.current.branches?.repo_root).toBe("/tmp/abc"));
      expect(list).toHaveBeenCalledTimes(1);
   });

   it("nothing is loaded while the dialog is closed, and an error of the last folder is cleared", async () => {
      const client = mk();
      const list = vi.spyOn(client, "listBranches");
      const setError = vi.fn();
      renderHook(() =>
         useBranches({ client, isOpen: false, folder: "/tmp/a", setError, onLoaded: vi.fn() }),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(list).not.toHaveBeenCalled();
      expect(setError).toHaveBeenCalledWith(null);
   });

   it("a failed load is reported", async () => {
      const client = mk();
      vi.spyOn(client, "listBranches").mockRejectedValue(new Error("boom"));
      const setError = vi.fn();
      renderHook(() =>
         useBranches({ client, isOpen: true, folder: "/tmp/a", setError, onLoaded: vi.fn() }),
      );
      await waitFor(() => expect(setError).toHaveBeenCalledWith(expect.stringContaining("boom")));
   });

   it("Update fast-forwards, then reloads the list without a first-load callback", async () => {
      const client = mk();
      const update = vi.spyOn(client, "updateBranch").mockResolvedValue(undefined as never);
      const onLoaded = vi.fn();
      const hook = renderHook(() =>
         useBranches({ client, isOpen: true, folder: "/tmp/a", setError: vi.fn(), onLoaded }),
      );
      await waitFor(() => expect(hook.result.current.branches).not.toBeNull());
      const list = vi.spyOn(client, "listBranches");
      const fresh = { ...hook.result.current.branches!, current: "fresh" } as Branches;
      list.mockResolvedValue(fresh);
      act(() => hook.result.current.updateBranch({ name: "main" } as never));
      expect(hook.result.current.updating).toBe("main");
      await waitFor(() => expect(hook.result.current.branches?.current).toBe("fresh"));
      expect(update).toHaveBeenCalledWith("/tmp/a", "main");
      await waitFor(() => expect(hook.result.current.updating).toBeNull());
      expect(onLoaded).toHaveBeenCalledTimes(1);
   });

   it("a failed Update is reported and clears the busy flag", async () => {
      const client = mk();
      vi.spyOn(client, "updateBranch").mockRejectedValue(new Error("diverged"));
      const setError = vi.fn();
      const hook = renderHook(() =>
         useBranches({ client, isOpen: true, folder: "/tmp/a", setError, onLoaded: vi.fn() }),
      );
      await waitFor(() => expect(hook.result.current.branches).not.toBeNull());
      act(() => hook.result.current.updateBranch({ name: "main" } as never));
      await waitFor(() =>
         expect(setError).toHaveBeenCalledWith(expect.stringContaining("Could not update main")),
      );
      await waitFor(() => expect(hook.result.current.updating).toBeNull());
   });
});

describe("usePullRequests", () => {
   it("lists the PRs of a repository and makes the tab available", async () => {
      const client = mk();
      const hook = renderHook(() =>
         usePullRequests({ client, isOpen: true, folder: "/tmp/repo", isRepo: true }),
      );
      expect(hook.result.current.prAvailable).toBe(false);
      await waitFor(() => expect(hook.result.current.prAvailable).toBe(true));
      expect(hook.result.current.prs?.length).toBeGreaterThan(0);
   });

   it("lists nothing for a folder that is not a repository", async () => {
      const client = mk();
      const list = vi.spyOn(client, "listPullRequests");
      renderHook(() =>
         usePullRequests({ client, isOpen: true, folder: "/tmp/norepo", isRepo: false }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(list).not.toHaveBeenCalled();
   });

   it("without gh the tab is hidden and the mode falls back to branch", async () => {
      const client = mk();
      const hook = renderHook(() =>
         usePullRequests({ client, isOpen: true, folder: "/tmp/nogh", isRepo: true }),
      );
      act(() => hook.result.current.setMode("pr"));
      await waitFor(() => expect(hook.result.current.mode).toBe("branch"));
      expect(hook.result.current.prAvailable).toBe(false);
      expect(hook.result.current.prs).toBeNull();
   });

   it("changing the filter reloads the list; a new folder clears the pick and the mode", async () => {
      const client = mk();
      const list = vi.spyOn(client, "listPullRequests");
      const hook = renderHook(
         (p: { folder: string }) =>
            usePullRequests({ client, isOpen: true, folder: p.folder, isRepo: true }),
         { initialProps: { folder: "/tmp/a" } },
      );
      await waitFor(() => expect(hook.result.current.prAvailable).toBe(true));
      act(() => {
         hook.result.current.setMode("pr");
         hook.result.current.setPr({ number: 7 });
         hook.result.current.setPrFilter("mine");
      });
      await waitFor(() => expect(list).toHaveBeenLastCalledWith("/tmp/a", "mine"));
      expect(hook.result.current.pr).toEqual({ number: 7 });
      hook.rerender({ folder: "/tmp/b" });
      await waitFor(() => expect(hook.result.current.pr).toBeNull());
      expect(hook.result.current.mode).toBe("branch");
      await waitFor(() => expect(list).toHaveBeenLastCalledWith("/tmp/b", "mine"));
   });
});
