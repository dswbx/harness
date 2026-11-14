import type { AgentInfo, FrontendManifest, HarnessClient, SessionSummary } from "@harness/api";
import { quickAgent } from "../composer/composer";

/**
 * Which Agent and Frontend a new Session starts with. One policy, three entry points:
 *
 * | entry point                    | Agent                                               | Frontend           |
 * | ------------------------------ | --------------------------------------------------- | ------------------ |
 * | Quick group's + (`startQuick`) | newest Session's Agent, else the first installed    | "chat", else first |
 * | Quick Overlay draft            | last Agent sent from the overlay (localStorage), else as the + | "chat", else first |
 * | Composer dialog                | the one already picked in the dialog, else the first installed | the one already picked, else "chat", else first |
 *
 * A remembered Agent that is no longer installed is ignored. The differences are the `fallback`
 * and `preferredAgentId`/`preferredFrontendId` parameters, not accidents; unify them here later.
 */
export type StartPolicy = {
   agents: AgentInfo[];
   frontends: FrontendManifest[];
   sessions: SessionSummary[];
   /** Used when still installed. */
   preferredAgentId?: string | null;
   /** Used as is (the Composer's pick is not checked against the list). */
   preferredFrontendId?: string | null;
   /** Without a usable preferred Agent: the newest Session's Agent, or just the first installed. */
   fallback: "newest" | "first";
};

export function pickStart(p: StartPolicy): { agent?: AgentInfo; frontendId?: string } {
   const agent =
      p.agents.find((a) => a.id === p.preferredAgentId) ??
      (p.fallback === "newest" ? quickAgent(p.sessions, p.agents) : p.agents[0]);
   const frontendId =
      p.preferredFrontendId || (p.frontends.find((f) => f.id === "chat") ?? p.frontends[0])?.id;
   return { agent, frontendId };
}

/** The Agent of the last Session sent from the overlay; the next draft starts with it. */
const AGENT_KEY = "harness.overlay.agent";

export function savedAgent(): string | null {
   try {
      return localStorage.getItem(AGENT_KEY);
   } catch {
      return null;
   }
}

export function saveAgent(id: string) {
   try {
      localStorage.setItem(AGENT_KEY, id);
   } catch {
      /* the next draft falls back to the newest Session's Agent */
   }
}

export type StartedQuick = {
   id: string;
   agent: AgentInfo;
   frontendId: string;
   agents: AgentInfo[];
};

/**
 * Creates a Quick Session by the policy. `null`: no Agent (or Frontend) is installed, nothing
 * was created. `sessions` are fetched when not given.
 */
export async function startQuickSession(
   client: HarnessClient,
   o: { sessions?: SessionSummary[]; useSavedAgent?: boolean } = {},
): Promise<StartedQuick | null> {
   const [agents, frontends, sessions] = await Promise.all([
      client.listAgents(),
      client.listFrontends(),
      o.sessions ?? client.listSessions(),
   ]);
   const { agent, frontendId } = pickStart({
      agents,
      frontends,
      sessions,
      preferredAgentId: o.useSavedAgent ? savedAgent() : null,
      fallback: "newest",
   });
   if (!agent || !frontendId) return null;
   const id = await client.createQuickSession({ agentId: agent.id, frontendId });
   return { id, agent, frontendId, agents };
}
