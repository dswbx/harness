import {
   type AgentInfo,
   errText,
   type FrontendManifest,
   type HarnessClient,
   type McpServerDef,
} from "@harness/api";
import { useEffect, useState } from "react";
import { pickStart } from "../quick/startSession";

const start = (
   agents: AgentInfo[],
   frontends: FrontendManifest[],
   agent: string,
   frontend: string,
) => ({
   agents,
   frontends,
   sessions: [],
   preferredAgentId: agent,
   preferredFrontendId: frontend,
   fallback: "first" as const,
});

/** What a new Session can pick from: Agents, Frontends and MCP servers, reloaded while the Composer is open. */
export function useComposerCatalog({
   client,
   isOpen,
   agentsVersion,
   mcpVersion,
   setError,
}: {
   client: HarnessClient;
   isOpen: boolean;
   /** Bump to reload the Agent list (after installs/removals). */
   agentsVersion: number;
   /** Bump to reload the MCP Library. */
   mcpVersion: number;
   setError: (e: string | null) => void;
}) {
   const [agents, setAgents] = useState<AgentInfo[]>([]);
   const [frontends, setFrontends] = useState<FrontendManifest[]>([]);
   const [agentId, setAgentId] = useState("");
   const [frontendId, setFrontendId] = useState("");
   const [mcpServers, setMcpServers] = useState<McpServerDef[]>([]);
   const [mcpIds, setMcpIds] = useState<string[]>([]);

   // biome-ignore lint/correctness/useExhaustiveDependencies: setError is a stable state setter
   useEffect(() => {
      if (!isOpen) return;
      void Promise.all([client.listAgents(), client.listFrontends()])
         .then(([a, f]) => {
            setAgents(a);
            setFrontends(f);
            // The Composer keeps what is picked; else the first Agent, not the newest Session's.
            setAgentId((cur) => pickStart(start(a, f, cur, "")).agent?.id ?? "");
            setFrontendId((cur) => pickStart(start(a, f, "", cur)).frontendId ?? "");
         })
         .catch((e) => setError(errText(e)));
   }, [isOpen, client, agentsVersion]);

   // biome-ignore lint/correctness/useExhaustiveDependencies: setError is a stable state setter
   useEffect(() => {
      if (!isOpen) return;
      void client
         .listMcpServers()
         .then((l) => {
            setMcpServers(l);
            setMcpIds((cur) => cur.filter((id) => l.some((s) => s.id === id)));
         })
         .catch((e) => {
            setMcpServers([]);
            setError(`Could not load MCP servers: ${errText(e)}`);
         });
   }, [isOpen, client, mcpVersion]);

   return {
      agents,
      frontends,
      agentId,
      setAgentId,
      frontendId,
      setFrontendId,
      mcpServers,
      mcpIds,
      setMcpIds,
   };
}
