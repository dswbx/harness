import type {
  AgentInfo, AppEvent, AppSettingKey, AttachmentInput, Branches, Commit, McpServerDef, RegistryAgent, Command, Diff, Event, FrontendManifest, GitStatus, NewPermissionRule, PermissionRule, PrFilter, PullRequest,
  Editor, SessionSummary, StatePatchOp, TerminalInfo, ThreadStart, WorkspaceInfo,
} from "./generated";
import type { TerminalOutput, Transport, Unsubscribe } from "./transport";

/** Session-scoped facade handed to a Frontend's View. Targets the Main Thread. */
export interface SessionApi {
  sessionId: string;
  /** Replays from `fromSeq`, then live. Returns an unsubscribe function. */
  subscribe(onEvent: (e: Event) => void, fromSeq?: number): Promise<Unsubscribe>;
  /**
   * `attachments`: files by path (picker, drop) or pasted bytes (base64). `threadId`: a Side Thread
   * (default: the Main Thread). Same for `cancel`, `setConfigOption`, `setMode`, `continueWithSummary`.
   */
  prompt(text: string, attachments?: AttachmentInput[], threadId?: string | null): Promise<void>;
  /** A stored attachment (`attachments/` in the Session Directory) as base64. */
  readAttachment(path: string): Promise<{ mime: string; data: string }>;
  /** An image file picked or dropped in the prompt box as base64 (image files only). */
  readImageFile(path: string): Promise<{ mime: string; data: string }>;
  cancel(threadId?: string | null): Promise<void>;
  /** Starts the Agent in the background so its models and modes show before the first prompt. */
  warmUp(): Promise<void>;
  /** Starts a new Agent Session seeded with a summary; prompts `text` right away when given. */
  continueWithSummary(text: string | null, threadId?: string | null): Promise<void>;
  /**
   * Opens a Side Thread (ADR 0018): a fork of the Main Thread when the Agent can, else a text seed.
   * Starts in the Agent's asking mode. Quoted text goes in its prompt box as a quote chip, not here.
   */
  startSideThread(args?: { seed?: string | null; source?: ThreadStart }): Promise<{ thread_id: string; forked: boolean }>;
  /** `null` answers "cancelled". */
  resolvePermission(requestId: string, optionId: string | null): Promise<void>;
  setConfigOption(id: string, value: string, threadId?: string | null): Promise<void>;
  setMode(id: string, threadId?: string | null): Promise<void>;
  /** This Session's Workspace (repo_root null: not a git repository), via a ListSessions lookup. */
  workspace(): Promise<WorkspaceInfo | null>;
  archive(): Promise<void>;
  unarchive(): Promise<void>;
  /** Without `force` the core refuses uncommitted or unmerged Worktree work. */
  delete(force?: boolean): Promise<void>;
  gitStatus(): Promise<GitStatus>;
  /** Null `from`: where the Session's changes start. Null `to`: the working tree now. */
  gitDiff(from?: string | null, to?: string | null): Promise<Diff>;
  /** The Session's own commits (since its changes start), newest first. */
  gitLog(): Promise<Commit[]>;
  /** A file at `rev` (e.g. `Diff.from`/`Diff.to`); empty when absent there. */
  gitShowFile(rev: string, path: string): Promise<string>;
  /** Stages everything; returns the commit id. */
  gitCommit(message: string): Promise<string>;
  gitPush(): Promise<void>;
  /** Reads a file of this Session's Frontend state (`frontend/` in the Session Directory). */
  frontendRead(path: string): Promise<string>;
  /** Opens the Session's folder, or `path` in it at `line`, in the user's editor (Settings). */
  openInEditor(path?: string, line?: number): Promise<void>;
  /** The Session State (ADR 0015); also rebuilt from `StateChanged` events. */
  getState(): Promise<unknown>;
  /** Changes the Session State as the user (all or nothing). */
  patchState(ops: StatePatchOp[]): Promise<void>;
  /** An image in `frontend/` as base64, e.g. a Frontend Tool call's copied image. */
  frontendReadImage(path: string): Promise<{ mime: string; data: string }>;
  frontendWrite(path: string, content: string): Promise<void>;
  /** Files under `dir` (recursive, relative to `frontend/`). */
  frontendList(dir?: string): Promise<string[]>;
  /** For an AuthRequired method of kind "agent": the Agent runs its own sign-in (often a browser). */
  authenticate(methodId: string): Promise<void>;
  /** For an AuthRequired method of kind "terminal": opens Terminal.app running the Agent's login. */
  openAuthTerminal(methodId: string): Promise<void>;
  /** The Session's Terminal tabs (a first one exists implicitly). Titles and `busy` change silently: re-list now and then. */
  terminalList(): Promise<TerminalInfo[]>;
  /** A new Terminal tab; its shell starts on the first attach. Returns its id. */
  terminalOpen(): Promise<number>;
  /** Kills the tab's shell and removes the tab. */
  terminalClose(terminalId: number): Promise<void>;
  /** Calls back when tabs open or close or a shell starts or ends (any Frontend). */
  terminalsChanged(onChange: () => void): Promise<Unsubscribe>;
  /** A Terminal tab: a shell in the Workspace Folder, started if none runs (ADR 0017). */
  terminalAttach(terminalId: number, cols: number, rows: number, onOutput: (o: TerminalOutput) => void): Promise<Unsubscribe>;
  terminalInput(terminalId: number, data: string): Promise<void>;
  terminalResize(terminalId: number, cols: number, rows: number): Promise<void>;
  /** `bytes` of output were drawn; output pauses while too much is unacknowledged. */
  terminalAck(terminalId: number, bytes: number): Promise<void>;
  /** Ends the shell; the tab stays and the next attach starts a new one. */
  terminalKill(terminalId: number): Promise<void>;
}

export function createSessionApi(transport: Transport, sessionId: string): SessionApi {
  const run = async (cmd: Command) => {
    await transport.execute(cmd);
  };
  const expect = async <T extends Awaited<ReturnType<Transport["execute"]>>["type"]>(cmd: Command, type: T) => {
    const r = await transport.execute(cmd);
    if (r.type !== type) throw new Error("unexpected result: " + r.type);
    return r as Extract<typeof r, { type: T }>;
  };
  return {
    sessionId,
    subscribe: (onEvent, fromSeq = 0) => transport.subscribe(sessionId, fromSeq, onEvent),
    prompt: (text, attachments = [], threadId = null) => run({ type: "Prompt", session_id: sessionId, thread_id: threadId, text, attachments }),
    readAttachment: async (path) => {
      const r = await expect({ type: "ReadAttachment", session_id: sessionId, path }, "Attachment");
      return { mime: r.mime, data: r.data };
    },
    readImageFile: async (path) => {
      const r = await expect({ type: "ReadImageFile", path }, "Attachment");
      return { mime: r.mime, data: r.data };
    },
    continueWithSummary: (text, threadId = null) => run({ type: "ContinueWithSummary", session_id: sessionId, thread_id: threadId, text }),
    startSideThread: async ({ seed = null, source } = {}) => {
      const r = await expect({ type: "StartSideThread", session_id: sessionId, seed, source }, "ThreadStarted");
      return { thread_id: r.thread_id, forked: r.forked };
    },
    cancel: (threadId = null) => run({ type: "Cancel", session_id: sessionId, thread_id: threadId }),
    warmUp: () => run({ type: "WarmUp", session_id: sessionId }),
    resolvePermission: (request_id, option_id) =>
      run({ type: "ResolvePermission", session_id: sessionId, request_id, option_id }),
    setConfigOption: (config_id, value, threadId = null) =>
      run({ type: "SetConfigOption", session_id: sessionId, thread_id: threadId, config_id, value }),
    setMode: (mode_id, threadId = null) => run({ type: "SetMode", session_id: sessionId, thread_id: threadId, mode_id }),
    workspace: async () => {
      const r = await transport.execute({ type: "ListSessions" });
      return r.type === "Sessions" ? (r.sessions.find((s) => s.id === sessionId)?.workspace ?? null) : null;
    },
    archive: () => run({ type: "ArchiveSession", session_id: sessionId }),
    unarchive: () => run({ type: "UnarchiveSession", session_id: sessionId }),
    delete: (force = false) => run({ type: "DeleteSession", session_id: sessionId, force }),
    gitStatus: async () => (await expect({ type: "GitStatus", session_id: sessionId }, "GitStatus")).status,
    gitDiff: async (from = null, to = null) =>
      (await expect({ type: "GitDiff", session_id: sessionId, from, to }, "Diff")).diff,
    gitLog: async () => (await expect({ type: "GitLog", session_id: sessionId }, "GitLog")).commits,
    gitShowFile: async (rev, path) =>
      (await expect({ type: "GitShowFile", session_id: sessionId, rev, path }, "FileContent")).content,
    gitCommit: async (message) =>
      (await expect({ type: "GitCommit", session_id: sessionId, message }, "Committed")).commit,
    gitPush: () => run({ type: "GitPush", session_id: sessionId }),
    frontendRead: async (path) =>
      (await expect({ type: "FrontendRead", session_id: sessionId, path }, "FileContent")).content,
    openInEditor: (path, line) => run({ type: "OpenInEditor", session_id: sessionId, path: path ?? null, line: line ?? null }),
    getState: async () => (await expect({ type: "GetState", session_id: sessionId }, "State")).state,
    patchState: (ops) => run({ type: "PatchState", session_id: sessionId, ops }),
    frontendReadImage: async (path) => {
      const r = await expect({ type: "FrontendReadImage", session_id: sessionId, path }, "Attachment");
      return { mime: r.mime, data: r.data };
    },
    frontendWrite: (path, content) => run({ type: "FrontendWrite", session_id: sessionId, path, content }),
    frontendList: async (dir) =>
      (await expect({ type: "FrontendList", session_id: sessionId, dir }, "Files")).files,
    authenticate: (method_id) => run({ type: "Authenticate", session_id: sessionId, method_id }),
    openAuthTerminal: (method_id) => run({ type: "OpenAuthTerminal", session_id: sessionId, method_id }),
    terminalList: async () => (await expect({ type: "ListTerminals", session_id: sessionId }, "Terminals")).terminals,
    terminalOpen: async () => (await expect({ type: "TerminalOpen", session_id: sessionId }, "TerminalOpened")).terminal_id,
    terminalClose: (terminal_id) => run({ type: "TerminalClose", session_id: sessionId, terminal_id }),
    terminalsChanged: (onChange) =>
      transport.subscribeApp((e) => e.type === "TerminalsChanged" && e.session_id === sessionId && onChange()),
    terminalAttach: (terminalId, cols, rows, onOutput) => transport.attachTerminal(sessionId, terminalId, cols, rows, onOutput),
    terminalInput: (terminal_id, data) => run({ type: "TerminalInput", session_id: sessionId, terminal_id, data }),
    terminalResize: (terminal_id, cols, rows) => run({ type: "TerminalResize", session_id: sessionId, terminal_id, cols, rows }),
    terminalAck: (terminal_id, bytes) => run({ type: "TerminalAck", session_id: sessionId, terminal_id, bytes }),
    terminalKill: (terminal_id) => run({ type: "TerminalKill", session_id: sessionId, terminal_id }),
  };
}

/** App-scope operations for the shell (sidebar, Composer). */
export class HarnessClient {
  constructor(private transport: Transport) {}

  async listSessions(): Promise<SessionSummary[]> {
    const r = await this.transport.execute({ type: "ListSessions" });
    return r.type === "Sessions" ? r.sessions : [];
  }
  async listAgents(): Promise<AgentInfo[]> {
    const r = await this.transport.execute({ type: "ListAgents" });
    return r.type === "Agents" ? r.agents : [];
  }
  /** ACP Registry entries; `refresh` re-fetches instead of using the local cache. */
  async listRegistry(refresh = false): Promise<RegistryAgent[]> {
    const r = await this.transport.execute({ type: "ListRegistry", refresh });
    return r.type === "Registry" ? r.agents : [];
  }
  /** Slow on first use (downloads Node/uv + package). Also updates an installed Agent. */
  async installAgent(registryId: string): Promise<AgentInfo> {
    const r = await this.transport.execute({ type: "InstallAgent", registry_id: registryId });
    if (r.type !== "AgentInstalled") throw new Error("unexpected result: " + r.type);
    return r.agent;
  }
  async addCustomAgent(args: { name: string; command: string; args: string[]; env: Record<string, string> }): Promise<AgentInfo> {
    const r = await this.transport.execute({ type: "AddCustomAgent", ...args });
    if (r.type !== "AgentInstalled") throw new Error("unexpected result: " + r.type);
    return r.agent;
  }
  /** An app setting (appearance, imported themes): JSON the app owns; null until saved. */
  async getAppSetting(key: AppSettingKey): Promise<unknown> {
    const r = await this.transport.execute({ type: "GetAppSetting", key });
    return r.type === "Json" ? r.value : null;
  }
  async setAppSetting(key: AppSettingKey, value: unknown): Promise<void> {
    await this.transport.execute({ type: "SetAppSetting", key, value: value ?? null });
  }
  /** The JSON at an https URL (read by the core), e.g. a theme's registry item. */
  async fetchJson(url: string): Promise<unknown> {
    const r = await this.transport.execute({ type: "FetchJson", url });
    if (r.type !== "Json") throw new Error("unexpected result: " + r.type);
    return r.value;
  }
  /** The editor for "Open in editor"; null until chosen. */
  async getEditor(): Promise<Editor | null> {
    const r = await this.transport.execute({ type: "GetEditor" });
    return r.type === "Editor" ? r.editor : null;
  }
  async setEditor(editor: Editor | null): Promise<void> {
    await this.transport.execute({ type: "SetEditor", editor });
  }
  async openInEditor(sessionId: string, path?: string, line?: number): Promise<void> {
    await this.transport.execute({ type: "OpenInEditor", session_id: sessionId, path: path ?? null, line: line ?? null });
  }
  async removeAgent(agentId: string): Promise<void> {
    await this.transport.execute({ type: "RemoveAgent", agent_id: agentId });
  }
  async listFrontends(): Promise<FrontendManifest[]> {
    const r = await this.transport.execute({ type: "ListFrontends" });
    return r.type === "Frontends" ? r.frontends : [];
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
    const r = await this.transport.execute({
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
    });
    if (r.type !== "SessionCreated") throw new Error("unexpected result: " + r.type);
    return r.session_id;
  }
  async listBranches(folder: string): Promise<Branches> {
    const r = await this.transport.execute({ type: "ListBranches", folder });
    if (r.type !== "Branches") throw new Error("unexpected result: " + r.type);
    return r.branches;
  }
  /** Open PRs of the folder's GitHub repository (needs `gh`); throws when unavailable. */
  async listPullRequests(folder: string, filter: PrFilter = "open"): Promise<PullRequest[]> {
    const r = await this.transport.execute({ type: "ListPullRequests", folder, filter });
    if (r.type !== "PullRequests") throw new Error("unexpected result: " + r.type);
    return r.prs;
  }
  async archiveSession(sessionId: string): Promise<void> {
    await this.transport.execute({ type: "ArchiveSession", session_id: sessionId });
  }
  async unarchiveSession(sessionId: string): Promise<void> {
    await this.transport.execute({ type: "UnarchiveSession", session_id: sessionId });
  }
  /** Rejects with the core's reason when work would be lost and `force` is false. */
  async deleteSession(sessionId: string, force = false): Promise<void> {
    await this.transport.execute({ type: "DeleteSession", session_id: sessionId, force });
  }
  async listMcpServers(): Promise<McpServerDef[]> {
    const r = await this.transport.execute({ type: "ListMcpServers" });
    return r.type === "McpServers" ? r.servers : [];
  }
  /** `secrets`: values for `server.secret_keys` (Keychain). Omitted ones keep the stored value. */
  async saveMcpServer(server: McpServerDef, secrets: Record<string, string> = {}): Promise<McpServerDef> {
    const r = await this.transport.execute({ type: "SaveMcpServer", server, secrets });
    if (r.type !== "McpServerSaved") throw new Error("unexpected result: " + r.type);
    return r.server;
  }
  async removeMcpServer(serverId: string): Promise<void> {
    await this.transport.execute({ type: "RemoveMcpServer", server_id: serverId });
  }
  async listPermissionRules(): Promise<PermissionRule[]> {
    const r = await this.transport.execute({ type: "ListPermissionRules" });
    return r.type === "PermissionRules" ? r.rules : [];
  }
  async addPermissionRule(rule: NewPermissionRule): Promise<PermissionRule> {
    const r = await this.transport.execute({ type: "AddPermissionRule", rule });
    if (r.type !== "PermissionRuleAdded") throw new Error("unexpected result: " + r.type);
    return r.rule;
  }
  async removePermissionRule(ruleId: string): Promise<void> {
    await this.transport.execute({ type: "RemovePermissionRule", rule_id: ruleId });
  }
  /** Sessions list / status / Agents changes pushed by the core. Live only. */
  subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe> {
    return this.transport.subscribeApp(onEvent);
  }
  sessionApi(sessionId: string): SessionApi {
    return createSessionApi(this.transport, sessionId);
  }
}
