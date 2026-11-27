import type {
   AttachmentInput,
   CommentSide,
   Commit,
   Diff,
   Editor,
   Event,
   FileScope,
   FrontendAnswer,
   GitStatus,
   KnownRepo,
   LineComment,
   LogPage,
   Note,
   PrInfo,
   PrRefKey,
   RepoId,
   SharedArtifactEntry,
   SharedArtifactMeta,
   StatePatchOp,
   Task,
   TaskPatch,
   TaskSummary,
   TerminalInfo,
   TextAnchor,
   ThreadStart,
   WorkspaceInfo,
} from "../generated";
import type { TerminalOutput, Transport, Unsubscribe } from "../transport/transport";
import { commentsApi } from "./session/comments";
import { coreApi } from "./session/core";
import { filesApi } from "./session/files";
import { frontendFilesApi } from "./session/frontendFiles";
import { gitApi } from "./session/git";
import { noteApi } from "./session/note";
import { prsApi } from "./session/prs";
import { sharedApi } from "./session/shared";
import { tasksApi } from "./session/tasks";
import { terminalApi } from "./session/terminal";
import type { SharedArtifactData } from "./shared";
import type { TaskStore } from "./taskStore";
import type { NewTask } from "./tasks";

/** Session-scoped facade handed to a Frontend's View. Targets the Main Thread. */
export interface SessionApi {
   sessionId: string;
   /**
    * Replays from `fromSeq`, then live. Returns an unsubscribe function once open; a failed open is
    * tried again a few times. When `signal` aborts first, it stops trying (see `subscribeResilient`).
    */
   subscribe(
      onEvent: (e: Event) => void,
      fromSeq?: number,
      signal?: AbortSignal,
   ): Promise<Unsubscribe>;
   /** One page of the Session Log from `fromSeq`, below `toSeq` if given (`Transport.readLogPage`). */
   readLogPage(fromSeq: number, toSeq?: number | null): Promise<LogPage>;
   /**
    * `attachments`: files by path (picker, drop) or pasted bytes (base64). `threadId`: a Side Thread
    * (default: the Main Thread). Same for `cancel`, `setConfigOption`, `setMode`, `continueWithSummary`.
    */
   prompt(
      text: string,
      attachments?: AttachmentInput[],
      threadId?: string | null,
      /** Pending Review Comments this prompt carries: the core marks them sent (ADR 0027). */
      commentIds?: string[],
   ): Promise<void>;
   /** Adds a line comment as the user (pending until a prompt carrying it is sent). */
   addComment(c: {
      path: string;
      line: number;
      side: CommentSide | null;
      code: string;
      text: string;
   }): Promise<LineComment>;
   /** Edits a pending comment; the core refuses a sent one. */
   editComment(id: string, text: string): Promise<void>;
   /** Deletes a pending comment; the core refuses a sent one. */
   deleteComment(id: string): Promise<void>;
   /** Resolves an open comment (the Agent can too, through the Harness MCP). */
   resolveComment(id: string): Promise<void>;
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
    * Agent's asking mode. Quoted text goes in its prompt box as a quote chip, not here. With `anchor` it is an
    * Inline Thread (ADR 0030): the core refuses it unless it points to a finished Main Thread agent message.
    */
   startSideThread(args?: {
      seed?: string | null;
      source?: ThreadStart;
      mode?: string | null;
      anchor?: TextAnchor | null;
   }): Promise<{ thread_id: string; forked: boolean }>;
   /** Resolves (`true`) or reopens (`false`) a Side Thread. Does nothing when it is already in that state. */
   resolveSideThread(threadId: string, resolved: boolean): Promise<void>;
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
   panelSourceRead(
      name: string,
   ): Promise<{ content: string; hash: string; mtime_ms: number; path: string }>;
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
    * Lines `start..=end` (1-based, clipped; default: all) of a text file: relative to the Session's folder, absolute,
    * or `~/…` (a relative path may also be the end of one, e.g. `src/a.rs` for `crates/x/src/a.rs`). `path`: the file
    * found, relative to the folder when `scope` is `inside`, else `~/…` or absolute. Fails for files missing, too
    * large, binary or not UTF-8; with `needs_approval` (message: the reason) for a file outside the folder that can
    * hold secrets until `approveSessionFile`.
    */
   readSessionFile(
      path: string,
      start?: number,
      end?: number,
   ): Promise<{ path: string; start: number; lines: string[]; total: number; scope: FileScope }>;
   /** Lets this Session read a file outside its folder that can hold secrets (kept with the Session). */
   approveSessionFile(path: string): Promise<void>;
   /** Takes back `approveSessionFile` for that file. */
   revokeSessionFile(path: string): Promise<void>;
   /** The Session State (ADR 0015); also rebuilt from `StateChanged` events. */
   getState(): Promise<unknown>;
   /** Changes the Session State as the user (all or nothing). */
   patchState(ops: StatePatchOp[]): Promise<void>;
   /**
    * A Frontend Tool item failed in the UI (e.g. an Html frame's script error); `item` is the call's `id`, else its
    * `call_id`. The core logs it (`FrontendError`) so the Agent learns about it; repeats are ignored.
    */
   reportFrontendError(tool: string, item: string, message: string): Promise<void>;
   /**
    * Renames a `render_ui` panel and sets its icon as the user (`EditPanel`): a full override that
    * stays when the Agent calls again with that id. Both empty: back to the Agent's. Not for a
    * Shared Artifact (use `HarnessClient.renameSharedArtifact`).
    */
   editPanel(itemId: string, title: string | null, icon: string | null): Promise<void>;
   /** Deletes a `render_ui` panel and its file in `panels/` (`DeletePanel`). Not for a Shared Artifact (use `detachShared`). */
   deletePanel(itemId: string): Promise<void>;
   /** Answers a `FrontendRequest` AppEvent. The first answer wins; later ones do nothing. */
   answerFrontendRequest(requestId: string, answer: FrontendAnswer): Promise<void>;
   /** An image in `frontend/` as base64, e.g. a Frontend Tool call's copied image. */
   frontendReadImage(path: string): Promise<{ mime: string; data: string }>;
   frontendWrite(path: string, content: string): Promise<void>;
   /** Files under `dir` (recursive, relative to `frontend/`). */
   frontendList(dir?: string): Promise<string[]>;
   /** For an AuthRequired method of kind "agent": the Agent runs its own sign-in (often a browser). */
   authenticate(methodId: string): Promise<void>;
   /** For an AuthRequired method of kind "terminal": opens Terminal.app running the Agent's login (the fallback to `authInTerminal`). */
   openAuthTerminal(methodId: string): Promise<void>;
   /**
    * For an AuthRequired method of kind "terminal": runs the Agent's login in a new Terminal tab and
    * returns its id. When it ends, `AuthFinished` is logged in `threadId` (after restarting the
    * Agent on success). Closing or killing the tab cancels it.
    */
   authInTerminal(methodId: string, threadId?: string | null): Promise<number>;
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
   /**
    * Shares a copy of Markdown from a message (a Mermaid fence or a table) and attaches it. `origin`:
    * the block's Artifacts panel key, kept in `created_by.origin` so the panel lists it once.
    */
   shareMarkdown(
      markdown: string,
      title?: string | null,
      origin?: string | null,
   ): Promise<SharedArtifactMeta>;
   attachShared(id: string): Promise<SharedArtifactMeta>;
   detachShared(id: string): Promise<void>;
   /** Sets a Shared Artifact's title and, when given, its icon (`""` clears it): the name everywhere it shows. */
   renameShared(id: string, title: string, icon?: string | null): Promise<SharedArtifactMeta>;
   /** Shared Artifacts, most recently updated first; with `query`, matches by title or text. */
   listShared(query?: string | null): Promise<SharedArtifactEntry[]>;
   readShared(id: string): Promise<SharedArtifactData>;
   /** Changes a Shared Artifact's state as the user; this Session logs `ArtifactStateChanged`. */
   patchArtifactState(id: string, ops: StatePatchOp[]): Promise<void>;
   /** Calls back with the id of each Shared Artifact whose content, state or meta changed. */
   sharedChanged(onChange: (id: string) => void): Promise<Unsubscribe>;
   /** Calls back when Shared Artifacts were added, removed, renamed, attached or detached. */
   sharedListChanged(onChange: () => void): Promise<Unsubscribe>;
   /** All Tasks (ADR 0028), oldest first. */
   listTasks(): Promise<TaskSummary[]>;
   readTask(id: string): Promise<Task>;
   /** A new Task with this Session as its origin. */
   createTask(t: Omit<NewTask, "sessionId">): Promise<Task>;
   /** `baseUpdatedMs`: the `updated_ms` the editor loaded; a body edit is refused (`conflict`) when the body changed after it. */
   updateTask(id: string, patch: TaskPatch, baseUpdatedMs?: number | null): Promise<Task>;
   /** Puts the Task under `parentId` (null: top level), before its sibling `before` (null: last). */
   moveTask(id: string, parentId: string | null, before?: string | null): Promise<Task>;
   /** Deletes the Task; its children move to its parent. */
   deleteTask(id: string): Promise<void>;
   addTaskAssets(id: string, files: AttachmentInput[]): Promise<Task>;
   removeTaskAsset(id: string, name: string): Promise<Task>;
   readTaskAsset(id: string, name: string): Promise<{ mime: string; data: string }>;
   /**
    * Calls back with the ids of the Tasks that changed (any window, any Session) and the current
    * summaries of those that still exist (an id without one was deleted).
    */
   tasksChanged(onChange: (ids: string[], tasks: TaskSummary[]) => void): Promise<Unsubscribe>;
   /** The window's one Task list (`useTasks`), shared by every Session and the app. */
   readonly taskStore: TaskStore;
   /** This Session's Session Note (ADR 0028); empty when never written. */
   readNote(): Promise<Note>;
   /**
    * Replaces the note. `baseHash`: the `hash` the editor loaded; refused (`conflict`) when the note
    * changed since. Without it the write always wins.
    */
   writeNote(content: string, baseHash?: string | null): Promise<Note>;
   /** Copies images into the note's `attachments/note/`; `readAttachment` reads them back. */
   addNoteImages(files: AttachmentInput[]): Promise<Note>;
   /** Deletes one of the note's images: `path` as in `Note.images`. */
   removeNoteImage(path: string): Promise<Note>;
   /** Calls back when this Session's note was written (any window). */
   noteChanged(onChange: () => void): Promise<Unsubscribe>;
}

/** The Session's facade: one object composed of per-domain method groups. */
export function createSessionApi(transport: Transport, sessionId: string): SessionApi {
   return {
      sessionId,
      ...coreApi(transport, sessionId),
      ...filesApi(transport, sessionId),
      ...gitApi(transport, sessionId),
      ...prsApi(transport, sessionId),
      ...frontendFilesApi(transport, sessionId),
      ...terminalApi(transport, sessionId),
      ...sharedApi(transport, sessionId),
      ...tasksApi(transport, sessionId),
      ...noteApi(transport, sessionId),
      ...commentsApi(transport, sessionId),
   };
}
