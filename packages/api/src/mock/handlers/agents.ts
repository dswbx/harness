import { CommandError } from "../../errors";
import type { AgentInfo, CommandResult, InstallInfo } from "../../generated";
import { MOCK_REGISTRY } from "../fixtures/registry";
import type { Handlers } from "./types";

const signIn = async (): Promise<CommandResult> => {
   await new Promise((r) => setTimeout(r, 400));
   return { type: "Ok" };
};

/** An Agent installed from the mock ACP Registry, as the core reports it. */
export function registryAgent(entry: (typeof MOCK_REGISTRY)[number]): AgentInfo {
   return {
      id: entry.id,
      name: entry.name,
      command: entry.install_method ?? "",
      args: [entry.id],
      env: {},
      source: { type: "registry", registry_id: entry.id },
      version: entry.version,
      icon: entry.icon,
      install: {
         sha256: null,
         unverified: false,
         previous: null,
         held: false,
         check: {
            version: entry.version,
            passed: true,
            auth_required: false,
            error: null,
            at_ms: Date.now(),
         },
      },
   };
}

export const agentsHandlers = {
   ListAgents: (mock) => {
      return { type: "Agents", agents: [...mock.installed] };
   },
   ListRegistry: (mock) => {
      return {
         type: "Registry",
         agents: MOCK_REGISTRY.map((a) => ({
            ...a,
            installed_version: mock.installedVersions.get(a.id) ?? null,
         })),
      };
   },
   InstallAgent: async (mock, cmd) => {
      const entry = MOCK_REGISTRY.find((a) => a.id === cmd.registry_id);
      if (!entry)
         throw new CommandError("not_found", `${cmd.registry_id} is not in the ACP Registry`);
      if (!entry.install_method)
         throw new CommandError("agent_unavailable", "Agent is not installable on this machine");
      await new Promise((r) => setTimeout(r, 1500));
      const agent = registryAgent(entry);
      mock.installed = [...mock.installed.filter((a) => a.id !== agent.id), agent];
      mock.installedVersions.set(entry.id, entry.version);
      mock.emitApp({ type: "AgentsChanged" });
      return { type: "AgentInstalled", agent };
   },
   AddCustomAgent: (mock, cmd) => {
      const slug = cmd.name
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, "-")
         .replace(/^-|-$/g, "");
      if (!slug) throw new CommandError("invalid", "name required");
      const agent: AgentInfo = {
         id: `custom-${slug}`,
         name: cmd.name,
         command: cmd.command,
         args: cmd.args ?? [],
         env: cmd.env ?? {},
         source: { type: "custom" },
         version: null,
         icon: null,
         install: {
            sha256: null,
            unverified: false,
            previous: null,
            held: false,
            check: null,
         },
      };
      mock.installed = [...mock.installed.filter((a) => a.id !== agent.id), agent];
      mock.emitApp({ type: "AgentsChanged" });
      return { type: "AgentInstalled", agent };
   },
   HoldAgentVersion: (mock, cmd) => {
      const cur = mock.installed.find((a) => a.id === cmd.agent_id);
      if (!cur) throw new CommandError("not_found", `unknown Agent ${cmd.agent_id}`);
      const agent = { ...cur, install: { ...cur.install, held: cmd.hold } as InstallInfo };
      mock.installed = mock.installed.map((a) => (a.id === agent.id ? agent : a));
      mock.emitApp({ type: "AgentsChanged" });
      return { type: "AgentInstalled", agent };
   },
   RollbackAgent: (mock, cmd) => {
      const cur = mock.installed.find((a) => a.id === cmd.agent_id);
      const prev = cur?.install?.previous;
      if (!cur) throw new CommandError("not_found", `unknown Agent ${cmd.agent_id}`);
      if (!prev) throw new CommandError("conflict", `${cur.name} has no previous version`);
      const agent: AgentInfo = {
         ...cur,
         version: prev.version,
         command: prev.command,
         args: prev.args,
         env: prev.env,
         install: { ...cur.install, previous: null, held: true, check: null } as InstallInfo,
      };
      mock.installed = mock.installed.map((a) => (a.id === agent.id ? agent : a));
      mock.installedVersions.set(agent.id, prev.version);
      mock.emitApp({ type: "AgentsChanged" });
      return { type: "AgentInstalled", agent };
   },
   RemoveAgent: (mock, cmd) => {
      mock.installed = mock.installed.filter((a) => a.id !== cmd.agent_id);
      mock.installedVersions.delete(cmd.agent_id);
      mock.emitApp({ type: "AgentsChanged" });
      return { type: "Ok" };
   },
   Authenticate: signIn,
   OpenAuthTerminal: signIn,
   // A pretend login in a new tab: it signs in after a few seconds, unless its tab was closed.
   AuthInTerminal: (mock, cmd) => {
      const sid = cmd.session_id;
      const tabs = mock.tabs(sid);
      const id = ++tabs.next;
      tabs.ids.push(id);
      mock.emitApp({ type: "TerminalsChanged", session_id: sid });
      setTimeout(() => {
         const open = tabs.ids.includes(id);
         if (open) {
            mock.endTerminal(sid, id, 0);
            mock.emitApp({ type: "TerminalsChanged", session_id: sid });
         }
         mock.emit(
            sid,
            {
               type: "AuthFinished",
               method_id: cmd.method_id,
               method_name: "Codex login",
               outcome: open ? "signed_in" : "cancelled",
               exit_code: open ? 0 : null,
            },
            cmd.thread_id ?? null,
         );
      }, 3000);
      return { type: "TerminalOpened", terminal_id: id };
   },
   ListFrontends: (mock) => {
      return {
         type: "Frontends",
         frontends: mock.frontends.map((f) => ({
            ...f,
            frontend_tools: f.frontend_tools ?? [],
         })),
      };
   },
} satisfies Partial<Handlers>;
