import type {
   AgentInfo,
   AppEvent,
   AppSettingKey,
   AttachmentInput,
   Branches,
   Command,
   CommandResult,
   Commit,
   Diff,
   Editor,
   Event,
   FrontendAnswer,
   FrontendManifest,
   GitStatus,
   KnownRepo,
   McpServerDef,
   NewPermissionRule,
   PermissionRule,
   PrFilter,
   PrInfo,
   PrRefKey,
   PullRequest,
   RegistryAgent,
   RepoId,
   SessionSummary,
   SharedArtifactEntry,
   SharedArtifactMeta,
   StatePatchOp,
   TerminalInfo,
   ThreadStart,
   WorkspaceInfo,
} from "./generated";
import {
   subscribeResilient,
   type TerminalOutput,
   type Transport,
   type Unsubscribe,
} from "./transport";

/** A Shared Artifact as read (ADR 0024): meta, content (`ui.json` text for kind `ui`), hash, state and folder. */
export type SharedArtifactData = Omit<Extract<CommandResult, { type: "SharedArtifact" }>, "type">;

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
   /** Starts a new Agent Session seeded with a transcript; prompts `text` right away when given. */
   continueWithSummary(
      text: string | null,
      threadId?: string | null,
      attachments?: AttachmentInput[],
   ): Promise<void>;
   /**
    * Opens a Side Thread (ADR 0018): a fork of the Main Thread when the Agent can, else a text seed.
    * `source: "fresh"` starts a new Agent Session without the conversation. Starts in `mode` when given, else in the
    * Agent's asking mode. Quoted text goes in its prompt box as a quote chip, not here.
    */
   startSideThread(args?: {
      seed?: string | null;
      source?: ThreadStart;
      mode?: string | null;
   }): Promise<{ thread_id: string; forked: boolean }>;
   /** `null` answers "cancelled". With an `*_always` option, `global` makes the rule apply to every Session. */
   resolvePermission(requestId: string, optionId: string | null, global?: boolean): Promise<void>;
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
   /**
    * What PR references resolve against: this Session's GitHub repo, the repos of all Sessions (best first) and the
    * `gh` user (null when `gh` is not signed in).
    */
   prContext(): Promise<{
      session_repo: RepoId | null;
      known_repos: KnownRepo[];
      me: string | null;
   }>;
   /** PRs in the order of `refs`; null for one that does not exist. Cached in the core. Fails when `gh` does. */
   lookupPrs(refs: PrRefKey[]): Promise<(PrInfo | null)[]>;
   /** Up to 30 PRs of `repo` in any state, the user's own first; `query` matches titles. */
   searchPrs(repo: RepoId, query?: string | null): Promise<PrInfo[]>;
   /** The Session's GitHub repo, the PR it works on (started from, else by head branch) and the branch it merges to. */
   branchPr(
      refresh?: boolean,
   ): Promise<{ repo: RepoId | null; pr: PrInfo | null; base: string | null }>;
   /** Reads a file of this Session's Frontend state (`frontend/` in the Session Directory). */
   frontendRead(path: string): Promise<string>;
   /**
    * A file-backed panel's source (ADR 0023): `name` relative to the Session's `panels/` folder.
    * `hash` (sha256 of `content`) changes only when the content does; `mtime_ms`: when the file was
    * last written (ms epoch, 0 when unknown). Fails when it is missing.
    */
   panelSourceRead(name: string): Promise<{ content: string; hash: string; mtime_ms: number }>;
   /** Calls back with the name of each panel source file that changed (once per burst of writes). */
   panelSourceChanged(onChange: (name: string) => void): Promise<Unsubscribe>;
   /** Opens the Session's folder, or `path` in it at `line`, in the user's editor (Settings). */
   openInEditor(path?: string, line?: number): Promise<void>;
   /** Writes a plan's Markdown to a file Harness owns; returns its absolute path. Optionally opens it in the editor. */
   exportPlan(name: string, markdown: string, openInEditor: boolean): Promise<string>;
   /** The editor "Open in editor" uses (Settings); null until chosen. */
   getEditor(): Promise<Editor | null>;
   /**
    * Files in the Session's folder: relative paths, `/` separators, sorted. In a git repository, those `.gitignore`
    * does not exclude. Capped. `prefix`: the folder's path in its repository (`crates/`, else empty), to match
    * repo-relative paths (git status) to `files`.
    */
   listSessionFiles(): Promise<{ files: string[]; prefix: string }>;
   /**
    * Lines `start..=end` (1-based, clipped; default: all) of a text file in the Session's folder (relative or absolute
    * inside it; a relative path may also be the end of one, e.g. `src/a.rs` for `crates/x/src/a.rs`). `path`: the
    * file found, relative to the folder. Fails for files outside it, missing, too large, binary or not UTF-8.
    */
   readSessionFile(
      path: string,
      start?: number,
      end?: number,
   ): Promise<{ path: string; start: number; lines: string[]; total: number }>;
   /** The Session State (ADR 0015); also rebuilt from `StateChanged` events. */
   getState(): Promise<unknown>;
   /** Changes the Session State as the user (all or nothing). */
   patchState(ops: StatePatchOp[]): Promise<void>;
   /**
    * A Frontend Tool item failed in the UI (e.g. an Html frame's script error); `item` is the call's `id`, else its
    * `call_id`. The core logs it (`FrontendError`) so the Agent learns about it; repeats are ignored.
    */
   reportFrontendError(tool: string, item: string, message: string): Promise<void>;
   /** Answers a `FrontendRequest` AppEvent. The first answer wins; later ones do nothing. */
   answerFrontendRequest(requestId: string, answer: FrontendAnswer): Promise<void>;
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
   terminalAttach(
      terminalId: number,
      cols: number,
      rows: number,
      onOutput: (o: TerminalOutput) => void,
   ): Promise<Unsubscribe>;
   terminalInput(terminalId: number, data: string): Promise<void>;
   terminalResize(terminalId: number, cols: number, rows: number): Promise<void>;
   /** `bytes` of output were drawn; output pauses while too much is unacknowledged. */
   terminalAck(terminalId: number, bytes: number): Promise<void>;
   /** Ends the shell; the tab stays and the next attach starts a new one. */
   terminalKill(terminalId: number): Promise<void>;
   /** Makes a `render_ui` item (by its `id`) a Shared Artifact (ADR 0024); the Session is attached. */
   shareArtifact(itemId: string): Promise<SharedArtifactMeta>;
   /** Shares a copy of Markdown from a message (a Mermaid fence or a table) and attaches it. */
   shareMarkdown(markdown: string, title?: string | null): Promise<SharedArtifactMeta>;
   attachShared(id: string): Promise<SharedArtifactMeta>;
   detachShared(id: string): Promise<void>;
   /** Shared Artifacts, most recently updated first; with `query`, matches by title or text. */
   listShared(query?: string | null): Promise<SharedArtifactEntry[]>;
   readShared(id: string): Promise<SharedArtifactData>;
   /** Changes a Shared Artifact's state as the user; this Session logs `ArtifactStateChanged`. */
   patchArtifactState(id: string, ops: StatePatchOp[]): Promise<void>;
   /** Calls back with the id of each Shared Artifact whose content, state or meta changed. */
   sharedChanged(onChange: (id: string) => void): Promise<Unsubscribe>;
   /** Calls back when Shared Artifacts were added, removed, renamed, attached or detached. */
   sharedListChanged(onChange: () => void): Promise<Unsubscribe>;
}

export function createSessionApi(transport: Transport, sessionId: string): SessionApi {
   const run = async (cmd: Command) => {
      await transport.execute(cmd);
   };
   const expect = async <T extends Awaited<ReturnType<Transport["execute"]>>["type"]>(
      cmd: Command,
      type: T,
   ) => {
      const r = await transport.execute(cmd);
      if (r.type !== type) throw new Error("unexpected result: " + r.type);
      return r as Extract<typeof r, { type: T }>;
   };
   return {
      sessionId,
      subscribe: (onEvent, fromSeq = 0) =>
         subscribeResilient(transport, sessionId, fromSeq, onEvent),
      prompt: (text, attachments = [], threadId = null) =>
         run({ type: "Prompt", session_id: sessionId, thread_id: threadId, text, attachments }),
      readAttachment: async (path) => {
         const r = await expect(
            { type: "ReadAttachment", session_id: sessionId, path },
            "Attachment",
         );
         return { mime: r.mime, data: r.data };
      },
      readImageFile: async (path) => {
         const r = await expect({ type: "ReadImageFile", path }, "Attachment");
         return { mime: r.mime, data: r.data };
      },
      continueWithSummary: (text, threadId = null, attachments = []) =>
         run({
            type: "ContinueWithSummary",
            session_id: sessionId,
            thread_id: threadId,
            text,
            attachments,
         }),
      startSideThread: async ({ seed = null, source, mode = null } = {}) => {
         const r = await expect(
            { type: "StartSideThread", session_id: sessionId, seed, source, mode },
            "ThreadStarted",
         );
         return { thread_id: r.thread_id, forked: r.forked };
      },
      cancel: (threadId = null) =>
         run({ type: "Cancel", session_id: sessionId, thread_id: threadId }),
      warmUp: () => run({ type: "WarmUp", session_id: sessionId }),
      resolvePermission: (request_id, option_id, global = false) =>
         run({ type: "ResolvePermission", session_id: sessionId, request_id, option_id, global }),
      setConfigOption: (config_id, value, threadId = null) =>
         run({
            type: "SetConfigOption",
            session_id: sessionId,
            thread_id: threadId,
            config_id,
            value,
         }),
      setMode: (mode_id, threadId = null) =>
         run({ type: "SetMode", session_id: sessionId, thread_id: threadId, mode_id }),
      workspace: async () => {
         const r = await transport.execute({ type: "ListSessions" });
         return r.type === "Sessions"
            ? (r.sessions.find((s) => s.id === sessionId)?.workspace ?? null)
            : null;
      },
      archive: () => run({ type: "ArchiveSession", session_id: sessionId }),
      unarchive: () => run({ type: "UnarchiveSession", session_id: sessionId }),
      delete: (force = false) => run({ type: "DeleteSession", session_id: sessionId, force }),
      gitStatus: async () =>
         (await expect({ type: "GitStatus", session_id: sessionId }, "GitStatus")).status,
      gitDiff: async (from = null, to = null) =>
         (await expect({ type: "GitDiff", session_id: sessionId, from, to }, "Diff")).diff,
      gitLog: async () =>
         (await expect({ type: "GitLog", session_id: sessionId }, "GitLog")).commits,
      gitShowFile: async (rev, path) =>
         (await expect({ type: "GitShowFile", session_id: sessionId, rev, path }, "FileContent"))
            .content,
      gitCommit: async (message) =>
         (await expect({ type: "GitCommit", session_id: sessionId, message }, "Committed")).commit,
      gitPush: () => run({ type: "GitPush", session_id: sessionId }),
      prContext: async () => {
         const r = await expect({ type: "PrContext", session_id: sessionId }, "PrContext");
         return { session_repo: r.session_repo, known_repos: r.known_repos, me: r.me };
      },
      lookupPrs: async (refs) =>
         (await expect({ type: "LookupPrs", session_id: sessionId, refs }, "PrLookup")).prs,
      searchPrs: async (repo, query = null) =>
         (await expect({ type: "SearchPrs", session_id: sessionId, repo, query }, "PrSearch")).prs,
      branchPr: async (refresh = false) => {
         const r = await expect({ type: "BranchPr", session_id: sessionId, refresh }, "BranchPr");
         return { repo: r.repo, pr: r.pr, base: r.base };
      },
      frontendRead: async (path) =>
         (await expect({ type: "FrontendRead", session_id: sessionId, path }, "FileContent"))
            .content,
      panelSourceRead: async (name) => {
         const r = await expect(
            { type: "PanelSourceRead", session_id: sessionId, name },
            "PanelSource",
         );
         return { content: r.content, hash: r.hash, mtime_ms: r.mtime_ms };
      },
      panelSourceChanged: (onChange) =>
         transport.subscribeApp(
            (e) =>
               e.type === "PanelSourceChanged" && e.session_id === sessionId && onChange(e.name),
         ),
      openInEditor: (path, line) =>
         run({
            type: "OpenInEditor",
            session_id: sessionId,
            path: path ?? null,
            line: line ?? null,
         }),
      getEditor: async () => {
         const r = await transport.execute({ type: "GetEditor" });
         return r.type === "Editor" ? r.editor : null;
      },
      exportPlan: async (name, markdown, openInEditor) =>
         (
            await expect(
               {
                  type: "ExportPlan",
                  session_id: sessionId,
                  name,
                  markdown,
                  open_in_editor: openInEditor,
               },
               "PlanFile",
            )
         ).path,
      listSessionFiles: async () => {
         const r = await expect(
            { type: "ListSessionFiles", session_id: sessionId },
            "SessionFiles",
         );
         return { files: r.files, prefix: r.prefix };
      },
      readSessionFile: async (path, start, end) => {
         const r = await expect(
            {
               type: "ReadSessionFile",
               session_id: sessionId,
               path,
               start: start ?? null,
               end: end ?? null,
            },
            "FileLines",
         );
         return { path: r.path, start: r.start, lines: r.lines, total: r.total };
      },
      getState: async () =>
         (await expect({ type: "GetState", session_id: sessionId }, "State")).state,
      patchState: (ops) => run({ type: "PatchState", session_id: sessionId, ops }),
      reportFrontendError: (tool, item, message) =>
         run({ type: "ReportFrontendError", session_id: sessionId, tool, item, message }),
      answerFrontendRequest: (request_id, answer) =>
         run({ type: "AnswerFrontendRequest", session_id: sessionId, request_id, answer }),
      frontendReadImage: async (path) => {
         const r = await expect(
            { type: "FrontendReadImage", session_id: sessionId, path },
            "Attachment",
         );
         return { mime: r.mime, data: r.data };
      },
      frontendWrite: (path, content) =>
         run({ type: "FrontendWrite", session_id: sessionId, path, content }),
      frontendList: async (dir) =>
         (await expect({ type: "FrontendList", session_id: sessionId, dir }, "Files")).files,
      authenticate: (method_id) => run({ type: "Authenticate", session_id: sessionId, method_id }),
      openAuthTerminal: (method_id) =>
         run({ type: "OpenAuthTerminal", session_id: sessionId, method_id }),
      terminalList: async () =>
         (await expect({ type: "ListTerminals", session_id: sessionId }, "Terminals")).terminals,
      terminalOpen: async () =>
         (await expect({ type: "TerminalOpen", session_id: sessionId }, "TerminalOpened"))
            .terminal_id,
      terminalClose: (terminal_id) =>
         run({ type: "TerminalClose", session_id: sessionId, terminal_id }),
      terminalsChanged: (onChange) =>
         transport.subscribeApp(
            (e) => e.type === "TerminalsChanged" && e.session_id === sessionId && onChange(),
         ),
      terminalAttach: (terminalId, cols, rows, onOutput) =>
         transport.attachTerminal(sessionId, terminalId, cols, rows, onOutput),
      terminalInput: (terminal_id, data) =>
         run({ type: "TerminalInput", session_id: sessionId, terminal_id, data }),
      terminalResize: (terminal_id, cols, rows) =>
         run({ type: "TerminalResize", session_id: sessionId, terminal_id, cols, rows }),
      terminalAck: (terminal_id, bytes) =>
         run({ type: "TerminalAck", session_id: sessionId, terminal_id, bytes }),
      terminalKill: (terminal_id) =>
         run({ type: "TerminalKill", session_id: sessionId, terminal_id }),
      shareArtifact: async (item_id) =>
         (
            await expect(
               { type: "ShareArtifact", session_id: sessionId, item_id },
               "SharedArtifactInfo",
            )
         ).meta,
      shareMarkdown: async (markdown, title = null) =>
         (
            await expect(
               { type: "ShareMarkdown", session_id: sessionId, markdown, title },
               "SharedArtifactInfo",
            )
         ).meta,
      attachShared: async (id) =>
         (
            await expect(
               { type: "AttachSharedArtifact", session_id: sessionId, id },
               "SharedArtifactInfo",
            )
         ).meta,
      detachShared: (id) => run({ type: "DetachSharedArtifact", session_id: sessionId, id }),
      listShared: (query) => listShared(transport, query),
      readShared: (id) => readShared(transport, id),
      patchArtifactState: (id, ops) =>
         run({ type: "PatchArtifactState", id, ops, session_id: sessionId }),
      sharedChanged: (onChange) => sharedChanged(transport, onChange),
      sharedListChanged: (onChange) => sharedListChanged(transport, onChange),
   };
}

const listShared = async (transport: Transport, query?: string | null) => {
   const r = await transport.execute({ type: "ListSharedArtifacts", query: query || null });
   return r.type === "SharedArtifactList" ? r.artifacts : [];
};
const readShared = async (transport: Transport, id: string): Promise<SharedArtifactData> => {
   const r = await transport.execute({ type: "SharedArtifactRead", id });
   if (r.type !== "SharedArtifact") throw new Error(`unexpected result: ${r.type}`);
   const { type: _, ...data } = r;
   return data;
};
const sharedChanged = (transport: Transport, onChange: (id: string) => void) =>
   transport.subscribeApp((e) => e.type === "SharedArtifactChanged" && onChange(e.id));
const sharedListChanged = (transport: Transport, onChange: () => void) =>
   transport.subscribeApp((e) => e.type === "SharedArtifactsChanged" && onChange());

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
   /**
    * Slow on first use (downloads Node/uv + package). Also updates an installed Agent: the update
    * is installed side by side and kept only if the conformance check passes. A download the
    * registry lists no sha256 for is refused unless `allowUnverified`.
    */
   async installAgent(registryId: string, allowUnverified = false): Promise<AgentInfo> {
      const r = await this.transport.execute({
         type: "InstallAgent",
         registry_id: registryId,
         allow_unverified: allowUnverified,
      });
      if (r.type !== "AgentInstalled") throw new Error("unexpected result: " + r.type);
      return r.agent;
   }
   /** Back to the previous version (and held there). */
   async rollbackAgent(agentId: string): Promise<AgentInfo> {
      const r = await this.transport.execute({ type: "RollbackAgent", agent_id: agentId });
      if (r.type !== "AgentInstalled") throw new Error("unexpected result: " + r.type);
      return r.agent;
   }
   /** Held Agents stay at their current version. */
   async holdAgentVersion(agentId: string, hold: boolean): Promise<AgentInfo> {
      const r = await this.transport.execute({ type: "HoldAgentVersion", agent_id: agentId, hold });
      if (r.type !== "AgentInstalled") throw new Error("unexpected result: " + r.type);
      return r.agent;
   }
   async addCustomAgent(args: {
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
   }): Promise<AgentInfo> {
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
   /** Where new Worktrees go: relative to the repository folder, or absolute (`~` is home). */
   async getWorktreeDir(): Promise<string> {
      const r = await this.transport.execute({ type: "GetWorktreeDir" });
      if (r.type !== "WorktreeDir") throw new Error("unexpected result: " + r.type);
      return r.dir;
   }
   /** null resets to the default (`.harness` in the repository). */
   async setWorktreeDir(dir: string | null): Promise<void> {
      await this.transport.execute({ type: "SetWorktreeDir", dir });
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
      await this.transport.execute({
         type: "OpenInEditor",
         session_id: sessionId,
         path: path ?? null,
         line: line ?? null,
      });
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
   /** A Session with no folder from the user: the core makes an empty one for it. */
   async createQuickSession(args: {
      agentId: string;
      frontendId: string;
      title?: string | null;
      mcpServers?: string[];
   }): Promise<string> {
      const r = await this.transport.execute({
         type: "CreateQuickSession",
         agent_id: args.agentId,
         frontend_id: args.frontendId,
         title: args.title || null,
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

   /** Fast-forwards a local branch to its `origin` counterpart (a pull when checked out in `folder`). */
   async updateBranch(folder: string, branch: string): Promise<void> {
      await this.transport.execute({ type: "UpdateBranch", folder, branch });
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
   /** Deletes the Session if it is a Quick Session nobody used; the core decides. */
   async discardEmptySession(sessionId: string): Promise<void> {
      await this.transport.execute({ type: "DiscardEmptySession", session_id: sessionId });
   }
   async listMcpServers(): Promise<McpServerDef[]> {
      const r = await this.transport.execute({ type: "ListMcpServers" });
      return r.type === "McpServers" ? r.servers : [];
   }
   /** `secrets`: values for `server.secret_keys` (Keychain). Omitted ones keep the stored value. */
   async saveMcpServer(
      server: McpServerDef,
      secrets: Record<string, string> = {},
   ): Promise<McpServerDef> {
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
   /** Shared Artifacts (ADR 0024), most recently updated first; with `query`, at most 20 matches. */
   listSharedArtifacts(query?: string | null): Promise<SharedArtifactEntry[]> {
      return listShared(this.transport, query);
   }
   readSharedArtifact(id: string): Promise<SharedArtifactData> {
      return readShared(this.transport, id);
   }
   async renameSharedArtifact(id: string, title: string): Promise<SharedArtifactMeta> {
      const r = await this.transport.execute({ type: "RenameSharedArtifact", id, title });
      if (r.type !== "SharedArtifactInfo") throw new Error(`unexpected result: ${r.type}`);
      return r.meta;
   }
   async deleteSharedArtifact(id: string): Promise<void> {
      await this.transport.execute({ type: "DeleteSharedArtifact", id });
   }
   async attachSharedArtifact(sessionId: string, id: string): Promise<SharedArtifactMeta> {
      const r = await this.transport.execute({
         type: "AttachSharedArtifact",
         session_id: sessionId,
         id,
      });
      if (r.type !== "SharedArtifactInfo") throw new Error(`unexpected result: ${r.type}`);
      return r.meta;
   }
   /** Changes a Shared Artifact's state with no Session (nothing is logged). */
   async patchArtifactState(id: string, ops: StatePatchOp[]): Promise<void> {
      await this.transport.execute({ type: "PatchArtifactState", id, ops, session_id: null });
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
