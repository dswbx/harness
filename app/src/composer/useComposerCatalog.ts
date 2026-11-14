import {
   type AgentInfo,
   errText,
   type FrontendManifest,
   type HarnessClient,
   type McpServerDef,
} from "@harness/api";
import { useEffect, useState } from "react";

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
            setAgentId((cur) => (a.some((x) => x.id === cur) ? cur : a[0]?.id || ""));
            setFrontendId((cur) => cur || (f.find((x) => x.id === "chat") ?? f[0])?.id || "");
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
