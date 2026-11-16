import {
   type AgentInfo,
   type FrontendManifest,
   type HarnessClient,
   type SessionSummary,
   storedValue,
} from "@harness/api";
import { quickAgent } from "../composer/composer";

/**
 * Which Agent and Frontend a new Session starts with. One policy, three entry points:
 *
 * | entry point                    | Agent                                                  | Frontend                                      |
 * | ------------------------------ | ------------------------------------------------------ | --------------------------------------------- |
 * | Quick group's + (`startQuick`) | newest Session's Agent, else the first installed       | "chat", else the first                        |
 * | its Agent menu (unused draft)  | the one picked (`agentId`), else as the +              | "chat", else the first                        |
 * | Quick Overlay draft            | last Agent sent from the overlay (localStorage), else as the + | "chat", else the first                |
 * | Composer dialog                | the one picked in the dialog, else as the +            | the one picked in the dialog, else "chat", else the first |
 *
 * A preferred Agent that is no longer installed is ignored. "Newest" counts every used Session (Sub
 * Sessions too; never-used drafts are skipped). The entry points differ by the `preferred*` parameters.
 */
export type StartPolicy = {
   agents: AgentInfo[];
   frontends: FrontendManifest[];
   /** For the "newest" fallback. */
   sessions?: SessionSummary[];
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
      (p.fallback === "newest" ? quickAgent(p.sessions ?? [], p.agents) : p.agents[0]);
   const frontendId =
      p.preferredFrontendId || (p.frontends.find((f) => f.id === "chat") ?? p.frontends[0])?.id;
   return { agent, frontendId };
}

/** The Agent of the last Session sent from the overlay; the next draft starts with it. */
const AGENT_KEY = "harness.overlay.agent";

const agentStore = storedValue<string | null>({
   key: AGENT_KEY,
   scope: "app",
   parse: (raw) => raw,
   serialize: (v) => v ?? "",
   sync: false,
});

export const savedAgent = (): string | null => agentStore.get();

/** A failed write: the next draft falls back to the newest Session's Agent. */
export const saveAgent = (id: string) => void agentStore.set(id);

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
   o: { sessions?: SessionSummary[]; useSavedAgent?: boolean; agentId?: string } = {},
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
      preferredAgentId: o.agentId ?? (o.useSavedAgent ? savedAgent() : null),
      fallback: "newest",
   });
   if (!agent || !frontendId) return null;
   const id = await client.createQuickSession({ agentId: agent.id, frontendId });
   return { id, agent, frontendId, agents };
}
