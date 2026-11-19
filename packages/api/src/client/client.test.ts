import { describe, expect, it } from "vitest";
import { CommandError } from "../errors";
import type { Command, CommandResult, Note, Task } from "../generated";
import type { Transport } from "../transport/transport";
import { createSessionApi, HarnessClient, type SessionApi } from "./client";

const meta = {
   v: 1,
   id: "a",
   title: "A",
   kind: "md",
   created_ms: 0,
   updated_ms: 0,
   created_by: { session_id: "s1", session_title: "S" },
} as const;

const task: Task = {
   v: 1,
   id: "t1",
   title: "T",
   body: "",
   status: "todo",
   priority: "none",
   due: null,
   upstream: null,
   parent_id: null,
   order: 1,
   origin_session_id: null,
   origin_title: null,
   sessions: [],
   assets: [],
   created_ms: 0,
   updated_ms: 0,
   body_updated_ms: 0,
   activity: [],
};

const note: Note = { content: "", hash: "h", updated_ms: null, images: [] };

/** What each Command gets back, so methods that check the result type succeed. Others get `Ok`. */
const replies: Partial<Record<Command["type"], CommandResult>> = {
   ReadAttachment: { type: "Attachment", mime: "text/plain", data: "eA==" },
   ReadTaskAsset: { type: "Attachment", mime: "text/plain", data: "eA==" },
   ListTasks: { type: "Tasks", tasks: [] },
   ReadTask: { type: "Task", task },
   CreateTask: { type: "Task", task },
   UpdateTask: { type: "Task", task },
   MoveTask: { type: "Task", task },
   AddTaskAssets: { type: "Task", task },
   RemoveTaskAsset: { type: "Task", task },
   ReadNote: { type: "Note", note },
   WriteNote: { type: "Note", note },
   AddNoteImages: { type: "Note", note },
   RemoveNoteImage: { type: "Note", note },
   ReadImageFile: { type: "Attachment", mime: "image/png", data: "eA==" },
   FrontendReadImage: { type: "Attachment", mime: "image/png", data: "eA==" },
   StartSideThread: { type: "ThreadStarted", thread_id: "t2", forked: false },
   ListSessions: { type: "Sessions", sessions: [] },
   GitStatus: { type: "GitStatus", status: { files: [] } as never },
   GitDiff: { type: "Diff", diff: { from: "a", to: "b", files: [], patch: "" } },
   GitLog: { type: "GitLog", commits: [] },
   GitShowFile: { type: "FileContent", content: "x" },
   GitCommit: { type: "Committed", commit: "abc" },
   PrContext: { type: "PrContext", session_repo: null, known_repos: [], me: null },
   LookupPrs: { type: "PrLookup", prs: [] },
   SearchPrs: { type: "PrSearch", prs: [] },
   BranchPr: { type: "BranchPr", repo: null, pr: null, base: null },
   FrontendRead: { type: "FileContent", content: "x" },
   PanelSourceRead: { type: "PanelSource", content: "c", hash: "h", path: "p", mtime_ms: 1 },
   GetEditor: { type: "Editor", editor: null },
   ExportPlan: { type: "PlanFile", path: "/p.md" },
   ListSessionFiles: { type: "SessionFiles", files: [], prefix: "" },
   ReadSessionFile: { type: "FileLines", path: "a", start: 1, lines: [], total: 0 },
   GetState: { type: "State", state: {} },
   FrontendList: { type: "Files", files: [] },
   ListTerminals: { type: "Terminals", terminals: [] },
   TerminalOpen: { type: "TerminalOpened", terminal_id: 2 },
   AddComment: {
      type: "Comment",
      comment: { id: "c1", path: "f", line: 1, side: null, code: "c", text: "t", by: "user" },
   },
   ShareArtifact: { type: "SharedArtifactInfo", meta },
   ShareMarkdown: { type: "SharedArtifactInfo", meta },
   AttachSharedArtifact: { type: "SharedArtifactInfo", meta },
   ListSharedArtifacts: { type: "SharedArtifactList", artifacts: [] },
   SharedArtifactRead: {
      type: "SharedArtifact",
      meta,
      content: "c",
      hash: "h",
      mtime_ms: 1,
      state: {},
      dir: "/d",
   },
};

function recorder(reply?: (cmd: Command) => CommandResult) {
   const sent: Command[] = [];
   const transport: Transport = {
      execute: async (cmd) => {
         sent.push(cmd);
         return reply?.(cmd) ?? replies[cmd.type] ?? { type: "Ok" };
      },
      subscribe: async () => () => {},
      subscribeApp: async () => () => {},
      attachTerminal: async () => () => {},
   };
   return { sent, transport };
}

type Plain = Exclude<
   keyof SessionApi,
   | "sessionId"
   | "subscribe"
   | "panelSourceChanged"
   | "terminalsChanged"
   | "terminalAttach"
   | "sharedChanged"
   | "sharedListChanged"
   | "tasksChanged"
   | "taskStore"
   | "noteChanged"
>;

/** One call per Command-sending method; a new method fails the typecheck until it has a row. */
const calls: Record<Plain, (api: SessionApi) => Promise<unknown>> = {
   prompt: (a) => a.prompt("hi"),
   readAttachment: (a) => a.readAttachment("p"),
   readImageFile: (a) => a.readImageFile("p"),
   cancel: (a) => a.cancel(),
   warmUp: (a) => a.warmUp(),
   continueWithSummary: (a) => a.continueWithSummary("t"),
   startSideThread: (a) => a.startSideThread(),
   resolvePermission: (a) => a.resolvePermission("r", "o"),
   setConfigOption: (a) => a.setConfigOption("c", "v"),
   setMode: (a) => a.setMode("m"),
   workspace: (a) => a.workspace(),
   archive: (a) => a.archive(),
   unarchive: (a) => a.unarchive(),
   delete: (a) => a.delete(),
   gitStatus: (a) => a.gitStatus(),
   gitDiff: (a) => a.gitDiff(),
   gitLog: (a) => a.gitLog(),
   gitShowFile: (a) => a.gitShowFile("HEAD", "f"),
   gitCommit: (a) => a.gitCommit("msg"),
   gitPush: (a) => a.gitPush(),
   prContext: (a) => a.prContext(),
   lookupPrs: (a) => a.lookupPrs([{ repo: { owner: "o", name: "n" }, number: 1 }]),
   searchPrs: (a) => a.searchPrs({ owner: "o", name: "n" }),
   branchPr: (a) => a.branchPr(),
   frontendRead: (a) => a.frontendRead("p"),
   panelSourceRead: (a) => a.panelSourceRead("n"),
   openInEditor: (a) => a.openInEditor(),
   getEditor: (a) => a.getEditor(),
   exportPlan: (a) => a.exportPlan("n", "# m", true),
   listSessionFiles: (a) => a.listSessionFiles(),
   readSessionFile: (a) => a.readSessionFile("p"),
   getState: (a) => a.getState(),
   patchState: (a) => a.patchState([{ op: "remove", path: "/x" }]),
   reportFrontendError: (a) => a.reportFrontendError("t", "i", "m"),
   answerFrontendRequest: (a) => a.answerFrontendRequest("r", { text: "t" }),
   frontendReadImage: (a) => a.frontendReadImage("p"),
   frontendWrite: (a) => a.frontendWrite("p", "c"),
   frontendList: (a) => a.frontendList(),
   authenticate: (a) => a.authenticate("m"),
   openAuthTerminal: (a) => a.openAuthTerminal("m"),
   terminalList: (a) => a.terminalList(),
   terminalOpen: (a) => a.terminalOpen(),
   terminalClose: (a) => a.terminalClose(2),
   terminalInput: (a) => a.terminalInput(2, "ls"),
   terminalResize: (a) => a.terminalResize(2, 80, 24),
   terminalAck: (a) => a.terminalAck(2, 10),
   terminalKill: (a) => a.terminalKill(2),
   shareArtifact: (a) => a.shareArtifact("i"),
   shareMarkdown: (a) => a.shareMarkdown("# m"),
   attachShared: (a) => a.attachShared("a"),
   detachShared: (a) => a.detachShared("a"),
   listShared: (a) => a.listShared(),
   readShared: (a) => a.readShared("a"),
   patchArtifactState: (a) => a.patchArtifactState("a", []),
   addComment: (a) => a.addComment({ path: "f", line: 1, side: null, code: "c", text: "t" }),
   editComment: (a) => a.editComment("c1", "t"),
   deleteComment: (a) => a.deleteComment("c1"),
   resolveComment: (a) => a.resolveComment("c1"),
   listTasks: (a) => a.listTasks(),
   readTask: (a) => a.readTask("t1"),
   createTask: (a) => a.createTask({ title: "T" }),
   updateTask: (a) => a.updateTask("t1", { status: "done" }),
   moveTask: (a) => a.moveTask("t1", null),
   deleteTask: (a) => a.deleteTask("t1"),
   addTaskAssets: (a) => a.addTaskAssets("t1", []),
   removeTaskAsset: (a) => a.removeTaskAsset("t1", "a.txt"),
   readTaskAsset: (a) => a.readTaskAsset("t1", "a.txt"),
   readNote: (a) => a.readNote(),
   writeNote: (a) => a.writeNote("# n", "h"),
   addNoteImages: (a) => a.addNoteImages([]),
   removeNoteImage: (a) => a.removeNoteImage("/s/attachments/note/a.png"),
};

describe("createSessionApi wire shape", () => {
   it("sends these Commands", async () => {
      const wire: Record<string, Command[]> = {};
      for (const [name, call] of Object.entries(calls)) {
         const { sent, transport } = recorder();
         await call(createSessionApi(transport, "s1"));
         wire[name] = sent;
      }
      expect(wire).toMatchSnapshot();
   });

   it("keeps the optional arguments' defaults on the wire", async () => {
      const { sent, transport } = recorder();
      const api = createSessionApi(transport, "s1");
      await api.prompt("x", undefined, "t9");
      await api.delete(true);
      await api.gitDiff("a", "b");
      await api.readSessionFile("p", 2, 5);
      await api.listShared("q");
      expect(sent).toEqual([
         { type: "Prompt", session_id: "s1", thread_id: "t9", text: "x", attachments: [] },
         { type: "DeleteSession", session_id: "s1", force: true },
         { type: "GitDiff", session_id: "s1", from: "a", to: "b" },
         { type: "ReadSessionFile", session_id: "s1", path: "p", start: 2, end: 5 },
         { type: "ListSharedArtifacts", query: "q" },
      ]);
   });
});

describe("HarnessClient wire shape", () => {
   it("sends these Commands", async () => {
      const { sent, transport } = recorder((cmd) => {
         const r = replies[cmd.type];
         if (r) return r;
         const byType: Partial<Record<Command["type"], CommandResult>> = {
            ListAgents: { type: "Agents", agents: [] },
            ListRegistry: { type: "Registry", agents: [] },
            ListFrontends: { type: "Frontends", frontends: [] },
            ListMcpServers: { type: "McpServers", servers: [] },
            ListPermissionRules: { type: "PermissionRules", rules: [] },
            GetAppSetting: { type: "Json", value: null },
            GetEditor: { type: "Editor", editor: null },
            CreateSession: { type: "SessionCreated", session_id: "n1" },
            CreateQuickSession: { type: "SessionCreated", session_id: "n2" },
            RenameSharedArtifact: { type: "SharedArtifactInfo", meta },
         };
         return byType[cmd.type] ?? { type: "Ok" };
      });
      const c = new HarnessClient(transport);
      await c.listSessions();
      await c.listAgents();
      await c.listRegistry();
      await c.listFrontends();
      await c.listMcpServers();
      await c.listPermissionRules();
      await c.getAppSetting("appearance");
      await c.getEditor();
      await c.listSharedArtifacts("q");
      await c.createSession({ folder: "/f", agentId: "a", frontendId: "f" });
      await c.createQuickSession({ agentId: "a", frontendId: "f" });
      await c.renameSharedArtifact("a", "T");
      await c.setAppSetting("appearance", undefined);
      await c.setWorktreeDir(null);
      await c.setEditor(null);
      await c.openInEditor("s1");
      await c.removeAgent("a");
      await c.archiveSession("s1");
      await c.unarchiveSession("s1");
      await c.deleteSession("s1");
      await c.discardEmptySession("s1");
      await c.updateBranch("/f", "main");
      await c.patchArtifactState("a", []);
      await c.openSharedInEditor("a");
      await c.deleteSharedArtifact("a");
      await c.removeMcpServer("m");
      await c.removePermissionRule("r");
      await c.listTasks();
      await c.createTask({ title: "T", parentId: "t1", due: "2026-12-01" });
      await c.updateTask("t1", { body: "b" }, 5);
      await c.moveTask("t2", "t1", "t3");
      await c.deleteTask("t1");
      expect(sent).toMatchSnapshot();
   });
});

/** A result of another type than the Command's is a bug: every method rejects with `internal`, none returns an empty value. */
describe("unexpected results", () => {
   const { transport } = recorder(() => ({ type: "Committed", commit: "x" }));
   const c = new HarnessClient(transport);
   const api = createSessionApi(transport, "s1");
   const calls: [string, () => Promise<unknown>][] = [
      ["listSessions", () => c.listSessions()],
      ["listAgents", () => c.listAgents()],
      ["listRegistry", () => c.listRegistry()],
      ["listFrontends", () => c.listFrontends()],
      ["listMcpServers", () => c.listMcpServers()],
      ["listPermissionRules", () => c.listPermissionRules()],
      ["listSharedArtifacts", () => c.listSharedArtifacts()],
      ["getAppSetting", () => c.getAppSetting("appearance")],
      ["getEditor", () => c.getEditor()],
      ["listBranches", () => c.listBranches("/f")],
      ["getWorktreeDir", () => c.getWorktreeDir()],
      ["transcriptSize", () => c.transcriptSize("s1")],
      ["workspace", () => api.workspace()],
      ["session getEditor", () => api.getEditor()],
      ["listShared", () => api.listShared()],
      ["gitLog", () => api.gitLog()],
   ];
   it.each(calls)("%s", async (_name, call) => {
      const err = await call().then(
         () => null,
         (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CommandError);
      expect(err).toMatchObject({
         code: "internal",
         message: expect.stringContaining("unexpected result"),
      });
   });
});
