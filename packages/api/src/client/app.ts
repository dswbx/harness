import type {
   AgentInfo,
   AppEvent,
   AppSettingKey,
   Branches,
   Editor,
   FrontendManifest,
   McpServerDef,
   NewPermissionRule,
   PermissionRule,
   PrFilter,
   PullRequest,
   RegistryAgent,
   SessionSummary,
   SharedArtifactEntry,
   SharedArtifactMeta,
   StatePatchOp,
} from "../generated";
import type { Transport, Unsubscribe } from "../transport/transport";
import {
   archiveSession,
   deleteSession,
   getEditor,
   openInEditor,
   unarchiveSession,
} from "./commands";
import { expectResult } from "./expect";
import { createSessionApi, type SessionApi } from "./session";
import {
   attachSharedArtifact,
   listShared,
   patchArtifactState,
   readShared,
   type SharedArtifactData,
   sharedChanged,
   sharedListChanged,
} from "./shared";

/** App-scope operations for the shell (sidebar, Composer). */
export class HarnessClient {
   constructor(private transport: Transport) {}

   async listSessions(): Promise<SessionSummary[]> {
      return (await expectResult(this.transport, { type: "ListSessions" }, "Sessions")).sessions;
   }
   async listAgents(): Promise<AgentInfo[]> {
      return (await expectResult(this.transport, { type: "ListAgents" }, "Agents")).agents;
   }
   /** ACP Registry entries; `refresh` re-fetches instead of using the local cache. */
   async listRegistry(refresh = false): Promise<RegistryAgent[]> {
      return (await expectResult(this.transport, { type: "ListRegistry", refresh }, "Registry"))
         .agents;
   }
   /**
    * Slow on first use (downloads Node/uv + package). Also updates an installed Agent: the update
    * is installed side by side and kept only if the conformance check passes. A download the
    * registry lists no sha256 for is refused unless `allowUnverified`.
    */
   async installAgent(registryId: string, allowUnverified = false): Promise<AgentInfo> {
      const r = await expectResult(
         this.transport,
         {
            type: "InstallAgent",
            registry_id: registryId,
            allow_unverified: allowUnverified,
         },
         "AgentInstalled",
      );
      return r.agent;
   }
   /** Back to the previous version (and held there). */
   async rollbackAgent(agentId: string): Promise<AgentInfo> {
      const r = await expectResult(
         this.transport,
         { type: "RollbackAgent", agent_id: agentId },
         "AgentInstalled",
      );
      return r.agent;
   }
   /** Held Agents stay at their current version. */
   async holdAgentVersion(agentId: string, hold: boolean): Promise<AgentInfo> {
      const r = await expectResult(
         this.transport,
         { type: "HoldAgentVersion", agent_id: agentId, hold },
         "AgentInstalled",
      );
      return r.agent;
   }
   async addCustomAgent(args: {
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
   }): Promise<AgentInfo> {
      const r = await expectResult(
         this.transport,
         { type: "AddCustomAgent", ...args },
         "AgentInstalled",
      );
      return r.agent;
   }
   /** An app setting (appearance, imported themes): JSON the app owns; null until saved. */
   async getAppSetting(key: AppSettingKey): Promise<unknown> {
      return (await expectResult(this.transport, { type: "GetAppSetting", key }, "Json")).value;
   }
   async setAppSetting(key: AppSettingKey, value: unknown): Promise<void> {
      await this.transport.execute({ type: "SetAppSetting", key, value: value ?? null });
   }
   /** The JSON at an https URL (read by the core), e.g. a theme's registry item. */
   async fetchJson(url: string): Promise<unknown> {
      const r = await expectResult(this.transport, { type: "FetchJson", url }, "Json");
      return r.value;
   }
   /** Where new Worktrees go: relative to the repository folder, or absolute (`~` is home). */
   async getWorktreeDir(): Promise<string> {
      const r = await expectResult(this.transport, { type: "GetWorktreeDir" }, "WorktreeDir");
      return r.dir;
   }
   /** null resets to the default (`.harness` in the repository). */
   async setWorktreeDir(dir: string | null): Promise<void> {
      await this.transport.execute({ type: "SetWorktreeDir", dir });
   }
   /** The editor for "Open in editor"; null until chosen. */
   async getEditor(): Promise<Editor | null> {
      return getEditor(this.transport);
   }
   async setEditor(editor: Editor | null): Promise<void> {
      await this.transport.execute({ type: "SetEditor", editor });
   }
   async openInEditor(sessionId: string, path?: string, line?: number): Promise<void> {
      await openInEditor(this.transport, sessionId, path, line);
   }
   async removeAgent(agentId: string): Promise<void> {
      await this.transport.execute({ type: "RemoveAgent", agent_id: agentId });
   }
   async listFrontends(): Promise<FrontendManifest[]> {
      return (await expectResult(this.transport, { type: "ListFrontends" }, "Frontends")).frontends;
   }
   async createSession(args: {
      folder: string;
      agentId: string;
      frontendId: string;
      title?: string | null;
      /** Base branch (worktree, new branch) or branch to check out; null = current. */
      branch?: string | null;
      worktree?: boolean;
      /** Create this branch from `branch` and work on it. */
      newBranch?: string | null;
      /** Start from this pull request, on its head branch: in a new Worktree with `worktree`, else in the folder. */
      pr?: number | null;
      /** MCP Library server ids to give the Agent. */
      mcpServers?: string[];
   }): Promise<string> {
      const r = await expectResult(
         this.transport,
         {
            type: "CreateSession",
            folder: args.folder,
            agent_id: args.agentId,
            frontend_id: args.frontendId,
            title: args.title || null,
            branch: args.branch ?? null,
            worktree: args.worktree ?? false,
            new_branch: args.newBranch ?? null,
            pr: args.pr ?? null,
            mcp_servers: args.mcpServers ?? [],
         },
         "SessionCreated",
      );
      return r.session_id;
   }
   /** A Session with no folder from the user: the core makes an empty one for it. */
   async createQuickSession(args: {
      agentId: string;
      frontendId: string;
      title?: string | null;
      mcpServers?: string[];
   }): Promise<string> {
      const r = await expectResult(
         this.transport,
         {
            type: "CreateQuickSession",
            agent_id: args.agentId,
            frontend_id: args.frontendId,
            title: args.title || null,
            mcp_servers: args.mcpServers ?? [],
         },
         "SessionCreated",
      );
      return r.session_id;
   }
   async listBranches(folder: string): Promise<Branches> {
      const r = await expectResult(this.transport, { type: "ListBranches", folder }, "Branches");
      return r.branches;
   }
   /** Open PRs of the folder's GitHub repository (needs `gh`); throws when unavailable. */
   async listPullRequests(folder: string, filter: PrFilter = "open"): Promise<PullRequest[]> {
      const r = await expectResult(
         this.transport,
         { type: "ListPullRequests", folder, filter },
         "PullRequests",
      );
      return r.prs;
   }

   /** Fast-forwards a local branch to its `origin` counterpart (a pull when checked out in `folder`). */
   async updateBranch(folder: string, branch: string): Promise<void> {
      await this.transport.execute({ type: "UpdateBranch", folder, branch });
   }
   async archiveSession(sessionId: string): Promise<void> {
      await archiveSession(this.transport, sessionId);
   }
   async unarchiveSession(sessionId: string): Promise<void> {
      await unarchiveSession(this.transport, sessionId);
   }
   /** Rejects with the core's reason when work would be lost and `force` is false. */
   async deleteSession(sessionId: string, force = false): Promise<void> {
      await deleteSession(this.transport, sessionId, force);
   }
   /** Deletes the Session if it is a Quick Session nobody used; the core decides. */
   async discardEmptySession(sessionId: string): Promise<void> {
      await this.transport.execute({ type: "DiscardEmptySession", session_id: sessionId });
   }
   async listMcpServers(): Promise<McpServerDef[]> {
      return (await expectResult(this.transport, { type: "ListMcpServers" }, "McpServers")).servers;
   }
   /** `secrets`: values for `server.secret_keys` (Keychain). Omitted ones keep the stored value. */
   async saveMcpServer(
      server: McpServerDef,
      secrets: Record<string, string> = {},
   ): Promise<McpServerDef> {
      const r = await expectResult(
         this.transport,
         { type: "SaveMcpServer", server, secrets },
         "McpServerSaved",
      );
      return r.server;
   }
   async removeMcpServer(serverId: string): Promise<void> {
      await this.transport.execute({ type: "RemoveMcpServer", server_id: serverId });
   }
   async listPermissionRules(): Promise<PermissionRule[]> {
      return (
         await expectResult(this.transport, { type: "ListPermissionRules" }, "PermissionRules")
      ).rules;
   }
   async addPermissionRule(rule: NewPermissionRule): Promise<PermissionRule> {
      const r = await expectResult(
         this.transport,
         { type: "AddPermissionRule", rule },
         "PermissionRuleAdded",
      );
      return r.rule;
   }
   async removePermissionRule(ruleId: string): Promise<void> {
      await this.transport.execute({ type: "RemovePermissionRule", rule_id: ruleId });
   }
   /** Sessions list / status / Agents changes pushed by the core. Live only. */
   subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe> {
      return this.transport.subscribeApp(onEvent);
   }
   /** Shared Artifacts (ADR 0024), most recently updated first; with `query`, at most 20 matches. */
   listSharedArtifacts(query?: string | null): Promise<SharedArtifactEntry[]> {
      return listShared(this.transport, query);
   }
   readSharedArtifact(id: string): Promise<SharedArtifactData> {
      return readShared(this.transport, id);
   }
   async renameSharedArtifact(id: string, title: string): Promise<SharedArtifactMeta> {
      const r = await expectResult(
         this.transport,
         { type: "RenameSharedArtifact", id, title },
         "SharedArtifactInfo",
      );
      return r.meta;
   }
   /** Opens a Shared Artifact's content file in the user's editor (no Session needed). */
   async openSharedInEditor(id: string): Promise<void> {
      await this.transport.execute({ type: "OpenSharedInEditor", id });
   }
   async deleteSharedArtifact(id: string): Promise<void> {
      await this.transport.execute({ type: "DeleteSharedArtifact", id });
   }
   async attachSharedArtifact(sessionId: string, id: string): Promise<SharedArtifactMeta> {
      return attachSharedArtifact(this.transport, sessionId, id);
   }
   /** Changes a Shared Artifact's state with no Session (nothing is logged). */
   async patchArtifactState(id: string, ops: StatePatchOp[]): Promise<void> {
      await patchArtifactState(this.transport, id, ops, null);
   }
   /** Calls back with the id of each Shared Artifact whose content, state or meta changed. */
   sharedChanged(onChange: (id: string) => void): Promise<Unsubscribe> {
      return sharedChanged(this.transport, onChange);
   }
   /** Calls back when Shared Artifacts were added, removed, renamed, attached or detached. */
   sharedListChanged(onChange: () => void): Promise<Unsubscribe> {
      return sharedListChanged(this.transport, onChange);
   }
   sessionApi(sessionId: string): SessionApi {
      return createSessionApi(this.transport, sessionId);
   }
}
