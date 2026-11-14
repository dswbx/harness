import type { AgentInfo, FrontendManifest, SessionSummary } from "@harness/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickStart, saveAgent, savedAgent, startQuickSession } from "./startSession";

const agent = (id: string) => ({ id, name: id }) as AgentInfo;
const fe = (id: string) => ({ id }) as FrontendManifest;
const sess = (agent_id: string, created_ms: number) =>
   ({ id: `s${created_ms}`, agent_id, created_ms }) as SessionSummary;

const agents = [agent("a"), agent("b"), agent("c")];
const frontends = [fe("inspector"), fe("chat")];
const sessions = [sess("b", 1), sess("c", 5), sess("a", 2)];

describe("pickStart", () => {
   it("+ (newest): the newest Session's Agent, the chat Frontend", () => {
      const r = pickStart({ agents, frontends, sessions, fallback: "newest" });
      expect(r.agent?.id).toBe("c");
      expect(r.frontendId).toBe("chat");
   });
   it("newest falls back to the first Agent when that one is gone or there are no Sessions", () => {
      expect(
         pickStart({ agents: [agent("a")], frontends, sessions, fallback: "newest" }).agent?.id,
      ).toBe("a");
      expect(pickStart({ agents, frontends, sessions: [], fallback: "newest" }).agent?.id).toBe(
         "a",
      );
   });
   it("a preferred Agent wins when installed, else the fallback", () => {
      const p = { agents, frontends, sessions, fallback: "newest" as const };
      expect(pickStart({ ...p, preferredAgentId: "b" }).agent?.id).toBe("b");
      expect(pickStart({ ...p, preferredAgentId: "gone" }).agent?.id).toBe("c");
   });
   it("Composer: the picked Agent wins, else the newest Session's, else the first", () => {
      const p = { agents, frontends, sessions, fallback: "newest" as const };
      expect(pickStart(p).agent?.id).toBe("c");
      expect(pickStart({ ...p, preferredAgentId: "b" }).agent?.id).toBe("b");
      expect(pickStart({ ...p, preferredAgentId: "" }).agent?.id).toBe("c");
      expect(pickStart({ ...p, agents: [agent("a"), agent("b")] }).agent?.id).toBe("a");
      expect(pickStart({ ...p, sessions: [] }).agent?.id).toBe("a");
   });
   it("fallback first ignores the newest Session", () => {
      expect(pickStart({ agents, frontends, sessions, fallback: "first" }).agent?.id).toBe("a");
   });
   it("Frontend: the preferred as is, else chat, else the first", () => {
      const p = { agents, sessions, fallback: "first" as const };
      expect(pickStart({ ...p, frontends, preferredFrontendId: "inspector" }).frontendId).toBe(
         "inspector",
      );
      expect(pickStart({ ...p, frontends: [fe("x"), fe("y")] }).frontendId).toBe("x");
   });
   it("nothing installed: no Agent, no Frontend", () => {
      const r = pickStart({ agents: [], frontends: [], sessions, fallback: "newest" });
      expect(r).toEqual({ agent: undefined, frontendId: undefined });
   });
});

describe("startQuickSession", () => {
   let store: Map<string, string>;
   beforeEach(() => {
      store = new Map();
      vi.stubGlobal("localStorage", {
         getItem: (k: string) => store.get(k) ?? null,
         setItem: (k: string, v: string) => void store.set(k, v),
      });
   });
   const client = (o: { agents?: AgentInfo[] } = {}) => {
      const createQuickSession = vi.fn().mockResolvedValue("new");
      const listSessions = vi.fn().mockResolvedValue(sessions);
      return {
         createQuickSession,
         listSessions,
         c: {
            listAgents: async () => o.agents ?? agents,
            listFrontends: async () => frontends,
            listSessions,
            createQuickSession,
         } as never,
      };
   };
   it("creates by the newest-Session policy, using given sessions without fetching", async () => {
      const { c, createQuickSession, listSessions } = client();
      const r = await startQuickSession(c, { sessions: [sess("b", 9)] });
      expect(createQuickSession).toHaveBeenCalledWith({ agentId: "b", frontendId: "chat" });
      expect(listSessions).not.toHaveBeenCalled();
      expect(r?.id).toBe("new");
   });
   it("the overlay uses the saved Agent, else the newest Session's", async () => {
      saveAgent("a");
      expect(savedAgent()).toBe("a");
      const one = client();
      await startQuickSession(one.c, { useSavedAgent: true });
      expect(one.createQuickSession).toHaveBeenCalledWith({ agentId: "a", frontendId: "chat" });
      store.clear();
      const two = client();
      await startQuickSession(two.c, { useSavedAgent: true });
      expect(two.createQuickSession).toHaveBeenCalledWith({ agentId: "c", frontendId: "chat" });
   });
   it("null and nothing created without an Agent", async () => {
      const { c, createQuickSession } = client({ agents: [] });
      expect(await startQuickSession(c)).toBeNull();
      expect(createQuickSession).not.toHaveBeenCalled();
   });
});
