import { CommandError, toCommandError } from "../errors";
import type {
   AgentInfo,
   AppEvent,
   Command,
   CommandResult,
   Editor,
   Event,
   EventKind,
   FrontendAnswer,
   FrontendToolDecl,
   McpServerDef,
   PermissionRule,
   SessionSummary,
   StartupNotice,
   WorkspaceInfo,
} from "../generated";
import type { TerminalOutput, Transport, Unsubscribe } from "../transport/transport";
import { seedSessions } from "./fixtures/sessions";
import { mockShared } from "./fixtures/shared";
import { mockNotes, mockTasks } from "./fixtures/tasks";
import { handlers } from "./handlers";
import { mockInstructions } from "./handlers/instructions";
import type { MockNote } from "./handlers/note";
import { withSideMode } from "./sideMode";

declare global {
   interface Window {
      /** Manual testing in the browser mock: asks the UI to answer a Frontend Tool that `replies`. */
      __harnessMockFrontendRequest?: (
         sessionId: string,
         tool: string,
         input: unknown,
      ) => Promise<FrontendAnswer>;
      /** Manual testing in the browser mock: writes a panel source file, as the Agent's Edit would. */
      __harnessMockPanelWrite?: (sessionId: string, name: string, content: string) => void;
      /** Manual testing in the browser mock: writes a Shared Artifact's content, as an editor would. */
      __harnessMockSharedWrite?: (id: string, content: string) => void;
   }
}

/**
 * Browser-only Transport for development without Tauri. Sessions start with `fixture`
 * replayed as their log; prompts get a canned streamed answer.
 */
export class MockTransport implements Transport {
   /** @internal */
   logs = new Map<string, Event[]>();
   /** @internal */
   sessions: SessionSummary[] = [];
   private subs = new Map<string, Set<(e: Event) => void>>();
   private lagHandlers = new Map<(e: Event) => void, () => void>();
   /** @internal */
   n = 0;
   /** @internal */
   rules: PermissionRule[] = [];
   /** @internal */
   ruleN = 0;
   /** @internal */
   installed: AgentInfo[] = [];
   /** @internal */
   mcp: McpServerDef[] = [];
   /** Per-session Frontend state files. @internal */
   frontendFiles = new Map<string, Map<string, string>>();
   /** Per-session panel source files written with `__harnessMockPanelWrite` (else `MOCK_PANEL_SOURCES`). @internal */
   panelFiles = new Map<string, Map<string, string>>();
   /** When each of them was written, by `${session}/${name}`. @internal */
   panelMtimes = new Map<string, number>();
   /** @internal */
   cardN = 0;
   /** @internal */
   states = new Map<string, unknown>();
   /** @internal */
   editor: Editor | null = null;
   /** @internal */
   worktreeDir = ".harness";
   /** @internal */
   appSettings: Record<string, unknown> = {};
   /** Custom Instructions by "global" or repository folder. @internal */
   instructions = mockInstructions();
   /** Shared Artifacts by id (ADR 0024). @internal */
   shared = new Map(mockShared().map((a) => [a.meta.id, a]));
   /** Tasks by id (ADR 0028). @internal */
   tasks = new Map(mockTasks().map((t) => [t.id, t]));
   /** The number of the next new Task. @internal */
   taskN = this.tasks.size + 1;
   /** Task asset bytes by `<task id>/<name>`. @internal */
   taskAssets = new Map<string, { mime: string; data: string }>();
   /** Session Notes by Session id (ADR 0028). @internal */
   notes = new Map<string, MockNote>(mockNotes());
   /** What "Open in editor" was asked to open (tests). */
   opened: { path: string | null; line: number | null }[] = [];
   /** Stored attachment path -> pasted bytes (path inputs have no bytes in the browser). @internal */
   attachments = new Map<string, { mime: string; data: string }>();
   /** Registry id -> installed version. @internal */
   installedVersions = new Map<string, string>();
   /** @internal */
   commitN = 0;
   /** @internal */
   ahead = new Map<string, number>();
   /** @internal */
   committed = new Set<string>();
   /** Settings files that "did not load", handed out once by `TakeNotices`. @internal */
   notices: StartupNotice[] = [];
   /** @internal */
   readOnly = new Set<string>();
   /** @internal */
   restoreFailed = new Set<string>();
   /** Turns in flight per Session, over all its Threads (the core's agent slot counts them). @internal */
   turns = new Map<string, number>();
   /** @internal */
   sideN = 0;
   /** @internal */
   sideForked = new Map<string, boolean>();
   /** Side Threads started without the conversation (`source: "fresh"`). @internal */
   sideFresh = new Set<string>();
   private appSubs = new Set<(e: AppEvent) => void>();
   /** @internal */
   frontendRequests = new Map<string, (answer: FrontendAnswer) => void>();
   /** A pretend shell per Terminal tab (key `session:id`): echoes input, `exit` ends it. */
   /** @internal */
   terminals = new Map<string, Set<(o: TerminalOutput) => void>>();
   private terminalLine = new Map<string, string>();
   private terminalTabs = new Map<string, { next: number; ids: number[] }>();

   constructor(
      /** @internal */
      readonly fixture: Event[],
      /** @internal */
      readonly frontends: {
         id: string;
         name: string;
         version: string;
         frontend_tools?: FrontendToolDecl[];
      }[],
   ) {
      if (typeof window !== "undefined") {
         window.__harnessMockFrontendRequest = (sessionId, tool, input) =>
            this.frontendRequest(sessionId, tool, input);
         window.__harnessMockPanelWrite = (sessionId, name, content) => {
            const m = this.panelFiles.get(sessionId) ?? new Map<string, string>();
            m.set(name, content);
            this.panelFiles.set(sessionId, m);
            this.panelMtimes.set(`${sessionId}/${name}`, Date.now());
            this.emitApp({ type: "PanelSourceChanged", session_id: sessionId, name });
         };
         window.__harnessMockSharedWrite = (id, content) => {
            const a = this.shared.get(id);
            if (!a) return;
            a.content = content;
            a.mtime = Date.now();
            a.meta.updated_ms = a.mtime;
            this.emitApp({ type: "SharedArtifactChanged", id });
         };
      }
      seedSessions(this);
   }

   /** @internal */
   addQuickSession(id: string, title: string, frontend_id: string, agent_id = "codex") {
      const workspace: WorkspaceInfo = {
         repo_root: null,
         source_folder: `/Users/me/.harness/quick/${id}`,
         worktree_branch: null,
         base_branch: null,
         branch: null,
         pr: null,
         pr_state: null,
         pr_checks: null,
      };
      this.addSession(id, title, frontend_id, false, `/Users/me/.harness/quick/${id}`, workspace);
      const s = this.sessions.at(-1)!;
      s.quick = true;
      s.agent_id = agent_id;
   }

   /** @internal */
   addSession(
      id: string,
      title: string,
      frontend_id: string,
      replay = true,
      folder = "/tmp/mock",
      workspace?: WorkspaceInfo,
   ) {
      this.sessions.push({
         id,
         title,
         frontend_id,
         agent_id: "codex",
         folder,
         created_ms: Date.now(),
         updated_ms: Date.now(),
         status: "idle",
         archived: false,
         quick: false,
         unused: false,
         unseen: false,
         workspace: workspace ?? {
            repo_root: folder,
            source_folder: folder,
            worktree_branch: null,
            base_branch: null,
            branch: "main",
            pr: null,
            pr_state: null,
            pr_checks: null,
         },
      });
      const mainId = this.fixture.find(
         (e) => e.kind.type === "ThreadStarted" && e.kind.main,
      )?.thread_id;
      this.logs.set(
         id,
         replay
            ? this.fixture.map((e) => ({
                 ...e,
                 session_id: id,
                 kind: e.thread_id === mainId ? withSideMode(e.kind) : e.kind,
              }))
            : [],
      );
      // Like the core, every log starts with SessionCreated and the Main Thread (a fixture has its own).
      if (!replay || !mainId) {
         this.emit(
            id,
            { type: "SessionCreated", title, frontend_id, agent_id: "codex", folder },
            null,
         );
         this.emit(id, { type: "ThreadStarted", agent_id: "codex", main: true }, `${id}-main`);
      }
   }

   /** The Session's Main Thread id: the one its `ThreadStarted` with `main` set opened. @internal */
   mainThread(sid: string): string {
      const main = this.logs.get(sid)?.find((e) => e.kind.type === "ThreadStarted" && e.kind.main);
      if (!main?.thread_id) throw new CommandError("internal", `Session ${sid} has no Main Thread`);
      return main.thread_id;
   }

   /** @internal */
   session(id: string) {
      const s = this.sessions.find((x) => x.id === id);
      if (!s) throw new CommandError("not_found", `unknown session ${id}`);
      return s;
   }

   /** Defaults to the session's Main Thread (fixture logs carry real ids). */
   private frontendRequest(sessionId: string, tool: string, input: unknown) {
      const request_id = `mock-request-${++this.n}`;
      return new Promise<FrontendAnswer>((resolve) => {
         this.frontendRequests.set(request_id, resolve);
         this.emitApp({
            type: "FrontendRequest",
            session_id: sessionId,
            request_id,
            tool,
            input,
            last_seq: this.logs.get(sessionId)?.at(-1)?.seq ?? 0,
         });
      });
   }

   /** @internal */
   emit(sessionId: string, kind: EventKind, thread_id?: string | null) {
      const log = this.logs.get(sessionId)!;
      if (thread_id === undefined) thread_id = this.mainThread(sessionId);
      if (kind.type === "ConfigOptionsChanged" && thread_id === this.mainThread(sessionId))
         kind = withSideMode(kind);
      const e: Event = {
         v: 1,
         seq: log.length,
         session_id: sessionId,
         thread_id,
         ts_ms: Date.now(),
         kind,
      };
      log.push(e);
      this.subs.get(sessionId)?.forEach((f) => f(e));
   }

   async execute(cmd: Command): Promise<CommandResult> {
      try {
         return await this.executeInner(cmd);
      } catch (e) {
         throw toCommandError(e);
      }
   }

   private async executeInner(cmd: Command): Promise<CommandResult> {
      const handle = handlers[cmd.type] as (
         m: MockTransport,
         c: Command,
      ) => Promise<CommandResult> | CommandResult;
      return handle(this, cmd);
   }

   /** @internal */
   emitApp(e: AppEvent) {
      this.appSubs.forEach((f) => f(e));
   }

   async subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe> {
      this.appSubs.add(onEvent);
      return () => this.appSubs.delete(onEvent);
   }

   /** @internal */
   tabs(sessionId: string) {
      let t = this.terminalTabs.get(sessionId);
      if (!t) this.terminalTabs.set(sessionId, (t = { next: 1, ids: [1] }));
      return t;
   }

   /** @internal */
   endTerminal(sessionId: string, terminalId: number, code: number | null) {
      const key = `${sessionId}:${terminalId}`;
      this.terminals.get(key)?.forEach((f) => f({ exit: code }));
      this.terminals.delete(key);
      this.terminalLine.delete(key);
   }

   private terminalOut(key: string, text: string) {
      const bytes = new TextEncoder().encode(text);
      this.terminals.get(key)?.forEach((f) => f(bytes));
   }

   /** @internal */
   terminalInput(sessionId: string, terminalId: number, data: string) {
      const key = `${sessionId}:${terminalId}`;
      let line = this.terminalLine.get(key) ?? "";
      for (const ch of data) {
         if (ch === "\r") {
            if (line.trim() === "exit") {
               this.endTerminal(sessionId, terminalId, 0);
               this.emitApp({ type: "TerminalsChanged", session_id: sessionId });
               return;
            }
            this.terminalOut(key, `\r\n${line ? `mock: ${line}\r\n` : ""}\x1b[32m~\x1b[0m $ `);
            line = "";
         } else if (ch === "\x7f") {
            if (line) this.terminalOut(key, "\b \b");
            line = line.slice(0, -1);
         } else if (ch >= " ") {
            line += ch;
            this.terminalOut(key, ch);
         }
      }
      this.terminalLine.set(key, line);
   }

   async attachTerminal(
      sessionId: string,
      terminalId: number,
      _cols: number,
      _rows: number,
      onOutput: (o: TerminalOutput) => void,
   ): Promise<Unsubscribe> {
      const key = `${sessionId}:${terminalId}`;
      let set = this.terminals.get(key);
      if (!set) {
         this.terminals.set(key, (set = new Set()));
         queueMicrotask(() =>
            this.terminalOut(
               key,
               "Mock terminal (browser). Type `exit` to end.\r\n\x1b[32m~\x1b[0m $ ",
            ),
         );
         this.emitApp({ type: "TerminalsChanged", session_id: sessionId });
      }
      onOutput({ replay: new Uint8Array() });
      set.add(onOutput);
      return () => set.delete(onOutput);
   }

   async subscribe(
      sessionId: string,
      fromSeq: number,
      onEvent: (e: Event) => void,
      onLagged?: () => void,
   ): Promise<Unsubscribe> {
      const log = this.logs.get(sessionId) ?? [];
      log.filter((e) => e.seq >= fromSeq).forEach(onEvent);
      let set = this.subs.get(sessionId);
      if (!set) this.subs.set(sessionId, (set = new Set()));
      set.add(onEvent);
      if (onLagged) this.lagHandlers.set(onEvent, onLagged);
      return () => {
         set.delete(onEvent);
         this.lagHandlers.delete(onEvent);
      };
   }

   /** Test hook: the core drops every subscriber of the Session as lagging (like a slow View). */
   dropSubscribersAsLagged(sessionId: string): void {
      const set = this.subs.get(sessionId);
      if (!set) return;
      for (const f of [...set]) {
         set.delete(f);
         const lagged = this.lagHandlers.get(f);
         this.lagHandlers.delete(f);
         lagged?.();
      }
   }
}
