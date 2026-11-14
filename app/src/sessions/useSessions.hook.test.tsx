import { type AppEvent, HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessions } from "./useSessions";

/** The mock's app event hook: what the core's `AppEvent` stream does in the real app. */
const emit = (t: MockTransport, e: AppEvent) =>
   act(() => {
      (t as unknown as { emitApp(e: AppEvent): void }).emitApp(e);
   });

function setup(onAgentsChanged?: () => void) {
   const transport = new MockTransport([], []);
   const client = new HarnessClient(transport);
   const list = vi.spyOn(client, "listSessions");
   const hook = renderHook(() => useSessions(client, onAgentsChanged));
   return { transport, client, list, hook };
}

describe("useSessions", () => {
   it("loads the list once, then settles", async () => {
      const { hook, list } = setup();
      expect(hook.result.current.settled).toBe(false);
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      expect(hook.result.current.sessions.map((s) => s.id)).toContain("mock-1");
      expect(list).toHaveBeenCalledTimes(1);
   });

   it("a SessionStatus event patches the row without reloading", async () => {
      const { transport, hook, list } = setup();
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      const before = hook.result.current.sessions[0]!;
      const now = Date.now();
      emit(transport, {
         type: "SessionStatus",
         session_id: "mock-1",
         title: "Renamed",
         status: "needs_attention",
         unused: false,
      });
      const after = hook.result.current.sessions[0]!;
      expect(after).toMatchObject({ id: "mock-1", title: "Renamed", status: "needs_attention" });
      expect(after.updated_ms).toBeGreaterThanOrEqual(now);
      expect(after.folder).toBe(before.folder);
      expect(list).toHaveBeenCalledTimes(1);
   });

   it("a SessionStatus of an unknown Session reloads the list and leaves it as it is meanwhile", async () => {
      const { transport, hook, list } = setup();
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      const same = hook.result.current.sessions;
      emit(transport, {
         type: "SessionStatus",
         session_id: "ghost",
         title: "x",
         status: "working",
         unused: false,
      });
      expect(hook.result.current.sessions).toBe(same);
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
   });

   it("SessionsChanged reloads the list, picking up a new Session", async () => {
      const { client, hook } = setup();
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      // createSession in the mock emits SessionsChanged.
      const id = await client.createSession({
         folder: "/tmp/x",
         agentId: "codex",
         frontendId: "chat",
      });
      await waitFor(() => expect(hook.result.current.sessions.map((s) => s.id)).toContain(id));
   });

   it("AgentsChanged calls the latest callback, no reload", async () => {
      const first = vi.fn();
      const second = vi.fn();
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      const list = vi.spyOn(client, "listSessions");
      const hook = renderHook(({ cb }) => useSessions(client, cb), { initialProps: { cb: first } });
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      hook.rerender({ cb: second });
      emit(transport, { type: "AgentsChanged" });
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
   });

   it("settles even when the first load fails", async () => {
      const transport = new MockTransport([], []);
      const client = new HarnessClient(transport);
      vi.spyOn(client, "listSessions").mockRejectedValue(new Error("down"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const hook = renderHook(() => useSessions(client));
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      expect(hook.result.current.sessions).toEqual([]);
   });

   it("stops listening after unmount", async () => {
      const { transport, hook, list } = setup();
      await waitFor(() => expect(hook.result.current.settled).toBe(true));
      hook.unmount();
      emit(transport, { type: "SessionsChanged" });
      emit(transport, {
         type: "SessionStatus",
         session_id: "ghost",
         title: "x",
         status: "idle",
         unused: false,
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(list).toHaveBeenCalledTimes(1);
   });
});
