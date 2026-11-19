import type {
   AgentInfo,
   AppEvent,
   AppSettingKey,
   AttachmentInput,
   Branches,
   Editor,
   FrontendManifest,
   InstructionsEntry,
   InstructionsScope,
   McpServerDef,
   NewPermissionRule,
   PermissionRule,
   PrFilter,
   PullRequest,
   RegistryAgent,
   SessionSummary,
   SharedArtifactEntry,
   SharedArtifactMeta,
   StartupNotice,
   StatePatchOp,
   Task,
   TaskPatch,
   TaskStart,
   TaskSummary,
   TranscriptSize,
} from "../generated";
import type { Transport, Unsubscribe } from "../transport/transport";
import {
   archiveSession,
   deleteSession,
   getEditor,
   markSessionSeen,
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
import { type TaskStore, taskStore } from "./taskStore";
import {
   addTaskAssets,
   createTask,
   deleteTask,
   listTasks,
   moveTask,
   type NewTask,
   readTask,
   readTaskAsset,
   removeTaskAsset,
   tasksChanged,
   updateTask,
} from "./tasks";

/** App-scope operations for the shell (sidebar, Composer). */
export class HarnessClient {
   constructor(private transport: Transport) {}

   async listSessions(): Promise<SessionSummary[]> {
      return (await expectResult(this.transport, { type: "ListSessions" }, "Sessions")).sessions;
   }
   /** Settings files that did not load, reset to defaults, the file kept. Handed out once: call after `subscribeApp` and again on `NoticesChanged`. */
   async takeNotices(): Promise<StartupNotice[]> {
      return (await expectResult(this.transport, { type: "TakeNotices" }, "Notices")).notices;
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
   /** Custom Instructions scopes: Global, then every known repository. */
   async listInstructions(): Promise<InstructionsEntry[]> {
      return (await expectResult(this.transport, { type: "ListInstructions" }, "Instructions"))
         .entries;
   }
   /** A scope's saved text; "" when none. */
   async getInstructions(scope: InstructionsScope): Promise<string> {
      return (
         await expectResult(this.transport, { type: "GetInstructions", scope }, "InstructionsText")
      ).text;
   }
   /** Saves a scope's text; "" deletes it. Applies to new Sessions and Threads. */
   async setInstructions(scope: InstructionsScope, text: string): Promise<void> {
      await this.transport.execute({ type: "SetInstructions", scope, text });
   }
   /** Moves a repository's instructions to another folder (the repository was moved). */
   async moveInstructions(from: string, to: string): Promise<void> {
      await this.transport.execute({ type: "MoveInstructions", from, to });
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
      /** Start from this task: the core links the Session to it and seeds the first prompt (ADR 0028). */
      task?: TaskStart | null;
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
            task: args.task ?? null,
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
   /** The user viewed the Session: clears its `unseen`. */
   async markSessionSeen(sessionId: string): Promise<void> {
      await markSessionSeen(this.transport, sessionId);
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
   /** All Tasks (ADR 0028), oldest first. */
   listTasks(): Promise<TaskSummary[]> {
      return listTasks(this.transport);
   }
   /** How much of a Session's Main Thread a transcript keeps; `chars`: its length. */
   async transcriptSize(sessionId: string): Promise<{ size: TranscriptSize; chars: number }> {
      const r = await expectResult(
         this.transport,
         { type: "ReadTranscriptSize", session_id: sessionId },
         "TranscriptSize",
      );
      return { size: r.size, chars: r.chars };
   }
   readTask(id: string): Promise<Task> {
      return readTask(this.transport, id);
   }
   /** `sessionId`: the Session it is created in (its origin); none for the Tasks view. */
   createTask(t: NewTask): Promise<Task> {
      return createTask(this.transport, t);
   }
   /** `baseUpdatedMs`: the `updated_ms` the editor loaded; a body edit is refused (`conflict`) when the body changed after it. */
   updateTask(id: string, patch: TaskPatch, baseUpdatedMs: number | null = null): Promise<Task> {
      return updateTask(this.transport, id, patch, baseUpdatedMs);
   }
   /** Puts the Task under `parentId` (null: top level), before its sibling `before` (null: last). */
   moveTask(id: string, parentId: string | null, before: string | null = null): Promise<Task> {
      return moveTask(this.transport, id, parentId, before);
   }
   /** Deletes the Task; its children move to its parent. */
   deleteTask(id: string): Promise<void> {
      return deleteTask(this.transport, id);
   }
   addTaskAssets(id: string, files: AttachmentInput[]): Promise<Task> {
      return addTaskAssets(this.transport, id, files);
   }
   removeTaskAsset(id: string, name: string): Promise<Task> {
      return removeTaskAsset(this.transport, id, name);
   }
   readTaskAsset(id: string, name: string): Promise<{ mime: string; data: string }> {
      return readTaskAsset(this.transport, id, name);
   }
   /** Calls back with the ids of the Tasks that changed and the current summaries of those that still exist. */
   tasksChanged(onChange: (ids: string[], tasks: TaskSummary[]) => void): Promise<Unsubscribe> {
      return tasksChanged(this.transport, onChange);
   }
   /** The window's one Task list (`useTasks`). */
   get taskStore(): TaskStore {
      return taskStore(this.transport);
   }
   sessionApi(sessionId: string): SessionApi {
      return createSessionApi(this.transport, sessionId);
   }
}
