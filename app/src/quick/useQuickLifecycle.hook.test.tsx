import { type AgentInfo, HarnessClient, type SessionSummary } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useQuickLifecycle } from "./useQuickLifecycle";

const session = (id: string, over: Partial<SessionSummary> = {}) =>
   ({ id, title: "t", quick: false, agent_id: "a1", created_ms: 1, ...over }) as SessionSummary;

function setup(
   sessions: SessionSummary[],
   agents: AgentInfo[] = [{ id: "a1" } as AgentInfo],
   selected: string | null = null,
) {
   const client = new HarnessClient(
      new MockTransport([], [{ id: "chat", name: "Chat", version: "1" }]),
   );
   vi.spyOn(client, "listAgents").mockResolvedValue(agents);
   const create = vi.spyOn(client, "createQuickSession").mockResolvedValue("q1");
   const discard = vi.spyOn(client, "discardEmptySession").mockResolvedValue(undefined as never);
   const props = {
      client,
      sessions,
      selected,
      setSelected: vi.fn(),
      setComposer: vi.fn(),
      refresh: vi.fn(async () => {}),
      report: vi.fn(),
   };
   const hook = renderHook((p: typeof props) => useQuickLifecycle(p), { initialProps: props });
   return { props, hook, create, discard };
}

describe("useQuickLifecycle", () => {
   it("startQuick creates a Quick Session with the newest Session's Agent, selects it and refreshes", async () => {
      const { props, hook, create } = setup([session("s1")]);
      await act(() => hook.result.current());
      expect(create).toHaveBeenCalledWith({ agentId: "a1", frontendId: "chat" });
      expect(props.setSelected).toHaveBeenCalledWith("q1");
      expect(props.refresh).toHaveBeenCalledTimes(1);
   });

   it("startQuick takes the Agent of the newest used Session, not an unused draft", async () => {
      const { hook, create } = setup(
         [
            session("s1", { agent_id: "a1", created_ms: 1 }),
            session("q0", { agent_id: "a2", created_ms: 9, quick: true, unused: true }),
         ],
         [{ id: "a1" } as AgentInfo, { id: "a2" } as AgentInfo],
      );
      await act(() => hook.result.current());
      expect(create).toHaveBeenCalledWith({ agentId: "a1", frontendId: "chat" });
   });

   it("startQuick stays on a Quick Session that is still unused", async () => {
      const { hook, create, props } = setup(
         [session("q0", { quick: true, unused: true })],
         undefined,
         "q0",
      );
      await act(() => hook.result.current());
      expect(create).not.toHaveBeenCalled();
      expect(props.setSelected).not.toHaveBeenCalled();
   });

   it("without an Agent, startQuick opens the Composer instead", async () => {
      const { props, hook, create } = setup([], []);
      await act(() => hook.result.current());
      expect(props.setComposer).toHaveBeenCalledWith(true);
      expect(create).not.toHaveBeenCalled();
   });

   it("a failed start is reported", async () => {
      const { props, hook, create } = setup([session("s1")]);
      create.mockRejectedValue(new Error("no"));
      await act(() => hook.result.current());
      expect(props.report).toHaveBeenCalledWith(
         "Could not start a Quick Session",
         expect.anything(),
      );
      expect(props.setSelected).not.toHaveBeenCalled();
   });

   it("leaving a Quick Session discards it and refreshes; leaving another kind does not", async () => {
      const sessions = [session("q0", { quick: true }), session("s1")];
      const { props, hook, discard } = setup(sessions);
      hook.rerender({ ...props, selected: "q0" });
      expect(discard).not.toHaveBeenCalled(); // nothing was selected before
      hook.rerender({ ...props, selected: "s1" });
      await waitFor(() => expect(discard).toHaveBeenCalledWith("q0"));
      await waitFor(() => expect(props.refresh).toHaveBeenCalledTimes(1));
      hook.rerender({ ...props, selected: null });
      expect(discard).toHaveBeenCalledTimes(1);
   });

   it("a failed discard is reported", async () => {
      const { props, hook, discard } = setup([session("q0", { quick: true })]);
      discard.mockRejectedValue(new Error("busy"));
      hook.rerender({ ...props, selected: "q0" });
      hook.rerender({ ...props, selected: null });
      await waitFor(() =>
         expect(props.report).toHaveBeenCalledWith(
            "Could not remove the empty Quick Session",
            expect.anything(),
         ),
      );
   });
});
