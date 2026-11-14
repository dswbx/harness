import {
   type AgentInfo,
   errText,
   type FrontendManifest,
   type HarnessClient,
   type McpServerDef,
   type SessionSummary,
} from "@harness/api";
import { useEffect, useRef, useState } from "react";
import { pickStart } from "../quick/startSession";

const start = (
   agents: AgentInfo[],
   frontends: FrontendManifest[],
   sessions: SessionSummary[],
   agent: string,
   frontend: string,
) => ({
   agents,
   frontends,
   sessions,
   preferredAgentId: agent,
   preferredFrontendId: frontend,
   fallback: "newest" as const,
});

/** What a new Session can pick from: Agents, Frontends and MCP servers, reloaded while the Composer is open. */
export function useComposerCatalog({
   client,
   isOpen,
   agentsVersion,
   mcpVersion,
   sessions,
   setError,
}: {
   client: HarnessClient;
   isOpen: boolean;
   /** Bump to reload the Agent list (after installs/removals). */
   agentsVersion: number;
   /** Bump to reload the MCP Library. */
   mcpVersion: number;
   /** For the newest Session's Agent; read when the lists load, not a reload trigger. */
   sessions: SessionSummary[];
   setError: (e: string | null) => void;
}) {
   const sessionsRef = useRef(sessions);
   sessionsRef.current = sessions;
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
            // Keeps what is picked; else the newest Session's Agent, else the first.
            setAgentId(
               (cur) => pickStart(start(a, f, sessionsRef.current, cur, "")).agent?.id ?? "",
            );
            setFrontendId(
               (cur) => pickStart(start(a, f, sessionsRef.current, "", cur)).frontendId ?? "",
            );
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
