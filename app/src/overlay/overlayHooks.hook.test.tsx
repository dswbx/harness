import { type AgentInfo, type AppEvent, HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUICK_TITLE } from "../composer/composer";

vi.mock("./overlayHost", () => ({
   overlayHost: {
      setMenuRoom: vi.fn(async () => {}),
      setPanels: vi.fn(async () => {}),
      chatWidth: vi.fn(async () => null),
      merge: vi.fn(async () => {}),
      context: vi.fn(async () => null),
      ready: vi.fn(),
      hide: vi.fn(),
      setMode: vi.fn(),
      openPrivacySettings: vi.fn(),
   },
   listenHost: vi.fn(() => () => {}),
}));

import { overlayHost } from "./overlayHost";
import type { OverlayMode } from "./overlayMode";
import { useMenuRoom } from "./useMenuRoom";
import { usePanelRoom } from "./usePanelRoom";
import { useQuickDraft } from "./useQuickDraft";

const emit = (t: MockTransport, e: AppEvent) =>
   act(() => {
      (t as unknown as { emitApp(e: AppEvent): void }).emitApp(e);
   });

afterEach(cleanup);
beforeEach(() => {
   vi.clearAllMocks();
   const mem = new Map<string, string>();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
   });
});

function draftSetup(agents: AgentInfo[] = [{ id: "a1", name: "A1" } as AgentInfo], visible = true) {
   const transport = new MockTransport([], [{ id: "chat", name: "Chat", version: "1" }]);
   const client = new HarnessClient(transport);
   vi.spyOn(client, "listAgents").mockResolvedValue(agents);
   const create = vi.spyOn(client, "createQuickSession").mockResolvedValue("d1");
   const discard = vi.spyOn(client, "discardEmptySession").mockResolvedValue(undefined as never);
   const dispatch = vi.fn();
   const report = vi.fn();
   const onReset = vi.fn();
   const props = { client, report, visible, mode: "prompt" as OverlayMode, dispatch, onReset };
   const hook = renderHook((p: typeof props) => useQuickDraft(p), { initialProps: props });
   return { transport, client, create, discard, dispatch, report, onReset, props, hook };
}

describe("useQuickDraft", () => {
   it("starts a draft once visible, with the first Agent and the chat Frontend", async () => {
      const { create, hook } = draftSetup();
      await waitFor(() =>
         expect(hook.result.current.draft).toEqual({
            id: "d1",
            frontendId: "chat",
            agentId: "a1",
         }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({ agentId: "a1", frontendId: "chat" });
      expect(hook.result.current.title).toBe(QUICK_TITLE);
      expect(hook.result.current.agentSwitch).toMatchObject({ current: "a1", locked: false });
   });

   it("starts nothing while hidden, and prefers the Agent of the last sent Session once shown", async () => {
      const agents = [
         { id: "a1", name: "A1" },
         { id: "a2", name: "A2" },
      ] as AgentInfo[];
      localStorage.setItem("harness.overlay.agent", "a2");
      const { create, hook, props } = draftSetup(agents, false);
      await new Promise((r) => setTimeout(r, 20));
      expect(create).not.toHaveBeenCalled();
      hook.rerender({ ...props, visible: true });
      await waitFor(() =>
         expect(create).toHaveBeenCalledWith({ agentId: "a2", frontendId: "chat" }),
      );
   });

   it("no Agent installed is an error, not a draft", async () => {
      const { create, hook } = draftSetup([]);
      await waitFor(() => expect(hook.result.current.error).toContain("No Agent installed"));
      expect(create).not.toHaveBeenCalled();
      expect(hook.result.current.draft).toBeNull();
   });

   it("a failed start is reported and not retried in a loop", async () => {
      const { create, report, hook } = draftSetup();
      create.mockRejectedValue(new Error("x"));
      await waitFor(() =>
         expect(report).toHaveBeenCalledWith("Could not start a Quick Session", expect.anything()),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(create).toHaveBeenCalledTimes(1);
      expect(hook.result.current.draft).toBeNull();
   });

   it("the first message (title change) sends and keeps the Agent; a finished Turn is forwarded", async () => {
      const { transport, dispatch, hook } = draftSetup();
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      await new Promise((r) => setTimeout(r, 10));
      emit(transport, {
         type: "SessionStatus",
         session_id: "d1",
         title: "Hello",
         status: "working",
         unused: false,
         unseen: false,
      });
      expect(hook.result.current.title).toBe("Hello");
      expect(dispatch).toHaveBeenCalledWith({ type: "sent" });
      expect(localStorage.getItem("harness.overlay.agent")).toBe("a1");
      emit(transport, { type: "TurnFinished", session_id: "d1" } as AppEvent);
      expect(dispatch).toHaveBeenCalledWith({ type: "turnFinished" });
      // another Session's events are ignored
      dispatch.mockClear();
      emit(transport, {
         type: "SessionStatus",
         session_id: "other",
         title: "x",
         status: "idle",
         unused: false,
         unseen: false,
      });
      expect(dispatch).not.toHaveBeenCalled();
   });

   it("a SessionStatus of the draft that is still unused does not open the chat", async () => {
      const { transport, dispatch, hook } = draftSetup();
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      await new Promise((r) => setTimeout(r, 10));
      // Even with a custom title: only the core's flag says a prompt was sent.
      emit(transport, {
         type: "SessionStatus",
         session_id: "d1",
         title: "Mine",
         status: "idle",
         unused: true,
         unseen: false,
      });
      expect(dispatch).not.toHaveBeenCalledWith({ type: "sent" });
      expect(localStorage.getItem("harness.overlay.agent")).toBeNull();
   });

   it("close resets, forgets the rest, and discards the empty Session", async () => {
      const { discard, dispatch, onReset, hook } = draftSetup();
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      act(() => hook.result.current.close());
      expect(dispatch).toHaveBeenCalledWith({ type: "reset" });
      expect(onReset).toHaveBeenCalledTimes(1);
      expect(discard).toHaveBeenCalledWith("d1");
      expect(hook.result.current.title).toBe(QUICK_TITLE);
   });

   it("merge opens the Session in the main window, then resets without discarding", async () => {
      const { discard, dispatch, onReset, hook } = draftSetup();
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      act(() => hook.result.current.merge());
      expect(overlayHost.merge).toHaveBeenCalledWith("d1");
      await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
      expect(dispatch).toHaveBeenCalledWith({ type: "reset" });
      expect(discard).not.toHaveBeenCalled();
   });

   it("a failed merge is reported and nothing is reset", async () => {
      const { report, dispatch, onReset, hook } = draftSetup();
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      vi.mocked(overlayHost.merge).mockRejectedValueOnce(new Error("no"));
      act(() => hook.result.current.merge());
      await waitFor(() =>
         expect(report).toHaveBeenCalledWith("Could not open the main window", expect.anything()),
      );
      expect(onReset).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalledWith({ type: "reset" });
   });

   it("picking another Agent replaces the draft and remembers the pick", async () => {
      const agents = [
         { id: "a1", name: "A1" },
         { id: "a2", name: "A2" },
      ] as AgentInfo[];
      const { create, discard, hook } = draftSetup(agents);
      await waitFor(() => expect(hook.result.current.draft?.agentId).toBe("a1"));
      create.mockResolvedValue("d2");
      act(() => hook.result.current.agentSwitch!.onPick("a2"));
      expect(discard).toHaveBeenCalledWith("d1");
      expect(localStorage.getItem("harness.overlay.agent")).toBe("a2");
      await waitFor(() =>
         expect(hook.result.current.draft).toMatchObject({ id: "d2", agentId: "a2" }),
      );
   });

   it("the Agent is locked outside the prompt", async () => {
      const { hook, props } = draftSetup();
      await waitFor(() => expect(hook.result.current.draft).not.toBeNull());
      hook.rerender({ ...props, mode: "chat" });
      expect(hook.result.current.agentSwitch?.locked).toBe(true);
   });
});

describe("useMenuRoom", () => {
   it("a menu opening pins the card, then asks the host for room; closing gives it back and unpins", async () => {
      const hook = renderHook(() => useMenuRoom({ visible: true, mode: "chat", shown: 0 }));
      expect(hook.result.current.pin).toBeNull();
      const menu = document.createElement("div");
      menu.setAttribute("role", "listbox");
      act(() => {
         document.body.appendChild(menu);
      });
      await waitFor(() => expect(overlayHost.setMenuRoom).toHaveBeenCalledWith(true));
      expect(hook.result.current.pin).toMatchObject({
         w: expect.any(Number),
         h: expect.any(Number),
      });
      act(() => {
         menu.remove();
      });
      await waitFor(() => expect(overlayHost.setMenuRoom).toHaveBeenLastCalledWith(false));
      await waitFor(() => expect(hook.result.current.pin).toBeNull());
   });

   it("asks for nothing while the overlay is not visible", async () => {
      renderHook(() => useMenuRoom({ visible: false, mode: "chat", shown: 0 }));
      const menu = document.createElement("div");
      menu.setAttribute("role", "listbox");
      act(() => {
         document.body.appendChild(menu);
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(overlayHost.setMenuRoom).not.toHaveBeenCalled();
      menu.remove();
   });
});

describe("usePanelRoom", () => {
   it("the View's wanted width moves the row to its edge, then the host resizes the window", async () => {
      const hook = renderHook(() => usePanelRoom());
      expect(hook.result.current.card).toBe(540);
      act(() => hook.result.current.onPanelWidth({ left: 200, right: 0 }));
      await waitFor(() => expect(overlayHost.setPanels).toHaveBeenCalledWith(200, 0));
      expect(hook.result.current.edge).toBe("right");
      await waitFor(() => expect(hook.result.current.panelsHost).toEqual({ left: 200, right: 0 }));
   });

   it("the same width twice asks once; resetPanels drops what the View wanted", async () => {
      const hook = renderHook(() => usePanelRoom());
      act(() => hook.result.current.onPanelWidth({ left: 0, right: 100 }));
      await waitFor(() => expect(hook.result.current.panelsHost).toEqual({ left: 0, right: 100 }));
      act(() => hook.result.current.onPanelWidth({ left: 0, right: 100 }));
      expect(overlayHost.setPanels).toHaveBeenCalledTimes(1);
      act(() => hook.result.current.resetPanels());
      await waitFor(() => expect(overlayHost.setPanels).toHaveBeenLastCalledWith(0, 0));
   });

   it("takes the saved card width from the host", async () => {
      vi.mocked(overlayHost.chatWidth).mockResolvedValueOnce(700 as never);
      const hook = renderHook(() => usePanelRoom());
      await waitFor(() => expect(hook.result.current.card).toBe(700));
   });
});
