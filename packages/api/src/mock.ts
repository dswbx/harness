import type { AppEvent, Editor, Attachment, AttachmentInput, Commit, McpServerDef, AgentInfo, BranchInfo, PullRequest, RegistryAgent, Command, CommandResult, Event, EventKind, FileChange, FrontendToolDecl, PermissionRule, SessionSummary, WorkspaceInfo } from "./generated";
import type { TerminalOutput, Transport, Unsubscribe } from "./transport";
import { MOCK_NEW, MOCK_OLD, MOCK_PATCH } from "./mockRepo";
import { applyStatePatch } from "./state";

/**
 * Browser-only Transport for development without Tauri. Sessions start with `fixture`
 * replayed as their log; prompts get a canned streamed answer.
 */
const ago = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
const MOCK_BRANCHES: BranchInfo[] = [
  { name: "main", time: ago(0.1), ahead: 0, behind: 0, worktree: false },
  { name: "feature/login", time: ago(4), ahead: 3, behind: 1, worktree: false },
  { name: "feature/compact-header", time: ago(50), ahead: 0, behind: 0, worktree: true },
];
const MOCK_REMOTE: BranchInfo[] = [{ name: "origin/feature/completions", time: ago(170), ahead: 0, behind: 0, worktree: false }];
const MOCK_PRS: PullRequest[] = [
  { number: 142, title: "Prompt attachments: images and files", author: "you", head: "feat/attachments", base: "main", draft: false, fork: false, checks: "passing", updated_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { number: 139, title: "Side threads keep their own config", author: "you", head: "side-thread-config", base: "main", draft: true, fork: false, checks: "pending", updated_at: new Date(Date.now() - 26 * 3600e3).toISOString() },
  { number: 137, title: "Fix diff panel scroll on large files", author: "contributor", head: "fix/diff-scroll", base: "main", draft: false, fork: true, checks: "failing", updated_at: new Date(Date.now() - 72 * 3600e3).toISOString() },
];

/** A placeholder screenshot (SVG source) for the mock. */
export function mockImage(label: string, hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${hue + 40} 70% 35%)"/></linearGradient></defs><rect width="1280" height="800" fill="url(#g)"/><text x="640" y="420" font-family="sans-serif" font-size="56" fill="white" text-anchor="middle">${label}</text></svg>`;
}

/** A `render_ui` input showing most components; `srcs` are the carousel's images. */
export function mockRenderUi(srcs: string[]) {
  return {
    root: {
      type: "Stack",
      children: [
        {
          type: "Card",
          props: { title: "Build finished", tone: "success" },
          children: [
            { type: "Markdown", props: { text: "All **3** checks passed." } },
            { type: "KeyValue", props: { items: [{ label: "Duration", value: "12s" }, { label: "Branch", value: "main" }] } },
            { type: "Stack", props: { direction: "horizontal", gap: "sm" }, children: [
              { type: "Badge", props: { text: "lint", tone: "success" } },
              { type: "Badge", props: { text: "types", tone: "success" } },
              { type: "Badge", props: { text: "1 flaky test", tone: "warning" } },
            ] },
          ],
        },
        { type: "Stack", props: { direction: "horizontal" }, children: [
          { type: "Card", props: { title: "read_to_string", tone: "info" }, children: [
            { type: "Markdown", props: { text: "Reads the whole file into a `String`. Best for small files." } },
            { type: "Code", props: { language: "rust", code: "let s = fs::read_to_string(\"data.txt\")?;" } },
          ] },
          { type: "Card", props: { title: "BufReader", tone: "success" }, children: [
            { type: "Markdown", props: { text: "Reads one line at a time." } },
            { type: "Code", props: { language: "rust", code: "for l in BufReader::new(f).lines() {\n    println!(\"{}\", l?);\n}" } },
          ] },
        ] },
        { type: "Table", props: { columns: ["Page", "Before", "After"], rows: [["Home", "1.8s", "0.9s"], ["Settings", "1.2s", "0.7s"]] } },
        { type: "Carousel", props: { images: srcs.map((src, i) => ({ src, alt: `Screenshot ${i + 1}`, caption: `Screenshot ${i + 1} of ${srcs.length}` })) } },
      ],
    },
  };
}

export class MockTransport implements Transport {
  private logs = new Map<string, Event[]>();
  private sessions: SessionSummary[] = [];
  private subs = new Map<string, Set<(e: Event) => void>>();
  private n = 0;
  private rules: PermissionRule[] = [];
  private ruleN = 0;
  private installed: AgentInfo[] = [];
  private mcp: McpServerDef[] = [];
  /** Per-session Frontend state files. */
  private frontendFiles = new Map<string, Map<string, string>>();
  private cardN = 0;
  private states = new Map<string, unknown>();
  private editor: Editor | null = null;
  private appSettings: Record<string, unknown> = {};
  /** What "Open in editor" was asked to open (tests). */
  opened: { path: string | null; line: number | null }[] = [];
  /** Stored attachment path -> pasted bytes (path inputs have no bytes in the browser). */
  private attachments = new Map<string, { mime: string; data: string }>();

  private storeAttachment(a: AttachmentInput): Attachment {
    if (a.type === "path") {
      const name = a.path.split("/").pop() ?? a.path;
      return { name, mime: "application/octet-stream", path: a.path, kind: "file" };
    }
    const path = `/mock/attachments/${this.attachments.size}-${a.name}`;
    this.attachments.set(path, { mime: a.mime, data: a.data });
    return { name: a.name, mime: a.mime, path, kind: a.mime.startsWith("image/") ? "image" : "file" };
  }
  /** Registry id -> installed version. */
  private installedVersions = new Map<string, string>();

  constructor(
    private fixture: Event[],
    private frontends: { id: string; name: string; version: string; frontend_tools?: FrontendToolDecl[] }[],
  ) {
    this.addSession("mock-1", "Mock session (fixture replay)", "chat");
  }

  private addSession(
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
      status: "idle",
      archived: false,
      workspace: workspace ?? { repo_root: folder, worktree_branch: null, base_branch: null },
    });
    this.logs.set(
      id,
      replay ? this.fixture.map((e) => ({ ...e, session_id: id })) : [],
    );
  }

  private commitN = 0;
  private ahead = new Map<string, number>();
  private committed = new Set<string>();

  private session(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error("no such session");
    return s;
  }

  private readOnly = new Set<string>();
  private sideN = 0;
  private sideForked = new Map<string, boolean>();
  private sideWritable = new Map<string, boolean>();

  /** Defaults to the session's Main Thread (fixture logs carry real ids). */
  private emit(sessionId: string, kind: EventKind, thread_id?: string | null) {
    const log = this.logs.get(sessionId)!;
    if (thread_id === undefined) {
      const main = log.find((e) => e.kind.type === "ThreadStarted" && e.kind.main);
      thread_id = main?.thread_id ?? "main";
    }
    const e: Event = { v: 1, seq: log.length, session_id: sessionId, thread_id, ts_ms: Date.now(), kind };
    log.push(e);
    this.subs.get(sessionId)?.forEach((f) => f(e));
  }

  async execute(cmd: Command): Promise<CommandResult> {
    switch (cmd.type) {
      case "ListAgents":
        return { type: "Agents", agents: [...this.installed] };
      case "ListRegistry":
        return {
          type: "Registry",
          agents: MOCK_REGISTRY.map((a) => ({ ...a, installed_version: this.installedVersions.get(a.id) ?? null })),
        };
      case "InstallAgent": {
        const entry = MOCK_REGISTRY.find((a) => a.id === cmd.registry_id);
        if (!entry || !entry.install_method) throw new Error("Agent is not installable on this machine");
        await new Promise((r) => setTimeout(r, 1500));
        const agent: AgentInfo = {
          id: entry.id, name: entry.name, command: entry.install_method, args: [entry.id], env: {},
          source: { type: "registry", registry_id: entry.id }, version: entry.version, icon: entry.icon,
        };
        this.installed = [...this.installed.filter((a) => a.id !== agent.id), agent];
        this.installedVersions.set(entry.id, entry.version);
        this.emitApp({ type: "AgentsChanged" });
        return { type: "AgentInstalled", agent };
      }
      case "AddCustomAgent": {
        const slug = cmd.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!slug) throw new Error("name required");
        const agent: AgentInfo = {
          id: `custom-${slug}`, name: cmd.name, command: cmd.command, args: cmd.args ?? [], env: cmd.env ?? {},
          source: { type: "custom" }, version: null, icon: null,
        };
        this.installed = [...this.installed.filter((a) => a.id !== agent.id), agent];
        this.emitApp({ type: "AgentsChanged" });
        return { type: "AgentInstalled", agent };
      }
      case "RemoveAgent":
        this.installed = this.installed.filter((a) => a.id !== cmd.agent_id);
        this.installedVersions.delete(cmd.agent_id);
        this.emitApp({ type: "AgentsChanged" });
        return { type: "Ok" };
      case "Authenticate":
      case "OpenAuthTerminal":
        await new Promise((r) => setTimeout(r, 400));
        return { type: "Ok" };
      case "ListFrontends":
        return {
          type: "Frontends",
          frontends: this.frontends.map((f) => ({ ...f, frontend_tools: f.frontend_tools ?? [] })),
        };
      case "ListSessions":
        return { type: "Sessions", sessions: this.sessions };
      case "CreateSession": {
        const id = `mock-${++this.n + 1}`;
        const isRepo = !cmd.folder.includes("norepo");
        if (!isRepo && (cmd.worktree || cmd.branch)) throw new Error("not a git repository: worktree and branch are not available");
        const pr = cmd.pr != null ? MOCK_PRS.find((p) => p.number === cmd.pr) : undefined;
        if (cmd.pr != null && !pr) throw new Error(`no pull request #${cmd.pr}`);
        if (!pr && !cmd.worktree && !cmd.new_branch && cmd.branch && cmd.branch !== "main")
          throw new Error("cannot check out branch: the folder has uncommitted changes");
        const worktree = cmd.worktree;
        const workspace: WorkspaceInfo = {
          repo_root: isRepo ? cmd.folder : null,
          worktree_branch: worktree ? (pr ? pr.head : (cmd.new_branch ?? `harness/${id}`)) : null,
          base_branch: worktree ? (pr ? pr.base : (cmd.branch ?? "main")) : null,
        };
        const title = cmd.title ?? (pr ? `#${pr.number} ${pr.title}` : (cmd.folder.split("/").pop() ?? id));
        this.addSession(id, title, cmd.frontend_id, false, cmd.folder, workspace);
        this.emitApp({ type: "SessionsChanged" });
        return { type: "SessionCreated", session_id: id };
      }
      case "ListBranches":
        return {
          type: "Branches",
          branches: cmd.folder.includes("norepo")
            ? { repo_root: null, current: null, branches: [], remote: [] }
            : { repo_root: cmd.folder, current: "main", branches: MOCK_BRANCHES, remote: MOCK_REMOTE },
        };
      case "ListPullRequests": {
        if (cmd.folder.includes("norepo") || cmd.folder.includes("nogh")) throw new Error("gh: no GitHub remote");
        const prs = cmd.filter === "mine" ? MOCK_PRS.filter((p) => p.author === "you") : cmd.filter === "review_requested" ? MOCK_PRS.slice(1, 2) : MOCK_PRS;
        return { type: "PullRequests", prs };
      }
      case "ArchiveSession":
      case "UnarchiveSession": {
        const archived = cmd.type === "ArchiveSession";
        this.session(cmd.session_id).archived = archived;
        this.emit(cmd.session_id, { type: "SessionArchived", archived });
        this.emitApp({ type: "SessionsChanged" });
        return { type: "Ok" };
      }
      case "DeleteSession": {
        const s = this.session(cmd.session_id);
        if (s.workspace.worktree_branch && !cmd.force)
          throw new Error(`Worktree branch ${s.workspace.worktree_branch} has unmerged commits; delete anyway to discard them`);
        this.sessions = this.sessions.filter((x) => x.id !== cmd.session_id);
        this.emitApp({ type: "SessionsChanged" });
        return { type: "Ok" };
      }
      case "GitStatus": {
        if (!this.session(cmd.session_id).workspace.repo_root) throw new Error("not a git repository");
        return {
          type: "GitStatus",
          status: {
            branch: this.session(cmd.session_id).workspace.worktree_branch ?? "main",
            upstream: null,
            ahead: this.ahead.get(cmd.session_id) ?? 0,
            behind: 0,
            files: this.committed.has(cmd.session_id) ? [] : MOCK_FILES,
          },
        };
      }
      case "GitDiff": {
        if (!this.session(cmd.session_id).workspace.repo_root) throw new Error("not a git repository");
        if (cmd.from !== null || cmd.to !== null) {
          // Revs the UI sends: "HEAD".."" = uncommitted; "<sha>^"..("<sha>" | null) = commits in the span.
          let paths: Set<string>;
          if (cmd.from === "HEAD") paths = new Set(MOCK_UNCOMMITTED);
          else {
            const start = MOCK_COMMITS.findIndex((c) => cmd.from === `${c.sha}^`);
            const end = cmd.to === null ? 0 : MOCK_COMMITS.findIndex((c) => c.sha === cmd.to);
            paths = new Set<string>();
            if (start >= 0 && end >= 0)
              for (const c of MOCK_COMMITS.slice(end, start + 1)) for (const f of MOCK_COMMIT_FILES[c.sha]) paths.add(f);
            if (cmd.to === null) for (const f of MOCK_UNCOMMITTED) paths.add(f);
          }
          const files = MOCK_FILES.filter((f) => paths.has(f.path));
          const patch = MOCK_PATCH.split(/(?=^diff --git )/m).filter((c) => files.some((f) => c.startsWith(`diff --git a/${f.path} `))).join("");
          return { type: "Diff", diff: { from: cmd.from ?? "base", to: cmd.to ?? "worktree", files, patch } };
        }
        const done = this.committed.has(cmd.session_id) && cmd.from === null && cmd.to === null;
        return {
          type: "Diff",
          diff: { from: cmd.from ?? "base", to: cmd.to ?? "worktree", files: done ? [] : MOCK_FILES, patch: done ? "" : MOCK_PATCH },
        };
      }
      case "GitLog":
        if (!this.session(cmd.session_id).workspace.repo_root) throw new Error("not a git repository");
        return { type: "GitLog", commits: [...MOCK_COMMITS] };
      case "TerminalInput":
        this.terminalInput(cmd.session_id, cmd.data);
        return { type: "Ok" };
      case "TerminalResize":
      case "TerminalAck":
        return { type: "Ok" };
      case "TerminalKill":
        this.terminals.get(cmd.session_id)?.forEach((f) => f({ exit: null }));
        this.terminals.delete(cmd.session_id);
        return { type: "Ok" };
      case "GitShowFile":
        // Old side: "base" and any "<sha>^"; everything else falls back to the new contents.
        return { type: "FileContent", content: (cmd.rev === "base" || cmd.rev.endsWith("^") ? MOCK_OLD : MOCK_NEW)[cmd.path] ?? "" };
      case "GitCommit": {
        if (!cmd.message.trim()) throw new Error("empty commit message");
        const commit = `c${++this.commitN}ab12cd`;
        this.committed.add(cmd.session_id);
        this.ahead.set(cmd.session_id, (this.ahead.get(cmd.session_id) ?? 0) + 1);
        this.emit(cmd.session_id, { type: "GitCommitted", commit, message: cmd.message });
        return { type: "Committed", commit };
      }
      case "GitPush": {
        this.ahead.set(cmd.session_id, 0);
        this.emit(cmd.session_id, { type: "GitPushed", branch: this.session(cmd.session_id).workspace.worktree_branch ?? "main" });
        return { type: "Ok" };
      }
      case "ListMcpServers":
        return { type: "McpServers", servers: [...this.mcp] };
      case "SaveMcpServer": {
        const slug = cmd.server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const id = cmd.server.id || slug;
        if (!id) throw new Error("name required");
        // Secret values never come back: keep only the key names.
        const server: McpServerDef = { ...cmd.server, id, secret_keys: cmd.server.secret_keys ?? [] };
        this.mcp = [...this.mcp.filter((s) => s.id !== id), server];
        return { type: "McpServerSaved", server };
      }
      case "RemoveMcpServer":
        this.mcp = this.mcp.filter((s) => s.id !== cmd.server_id);
        return { type: "Ok" };
      case "FrontendRead": {
        const c = this.frontendFiles.get(cmd.session_id)?.get(cmd.path);
        if (c === undefined) throw new Error(`no such file: ${cmd.path}`);
        return { type: "FileContent", content: c };
      }
      case "GetAppSetting":
        return { type: "Json", value: this.appSettings[cmd.key] ?? null };
      case "SetAppSetting":
        this.appSettings[cmd.key] = cmd.value;
        return { type: "Ok" };
      case "FetchJson":
        // No network in the mock: any tweakcn theme URL gets a small sample registry item.
        if (!/tweakcn\.com\/r\/themes\//.test(cmd.url)) throw new Error(`fetch ${cmd.url}: The requested URL returned error: 404`);
        return { type: "Json", value: MOCK_THEME };
      case "GetEditor":
        return { type: "Editor", editor: this.editor };
      case "SetEditor":
        this.editor = cmd.editor;
        return { type: "Ok" };
      case "OpenInEditor":
        if (!this.editor) throw new Error("choose an editor in Settings first");
        this.opened.push({ path: cmd.path ?? null, line: cmd.line ?? null });
        console.info("[mock] open in editor", this.editor.type, cmd.path ?? "(folder)", cmd.line ?? "");
        return { type: "Ok" };
      case "GetState":
        return { type: "State", state: this.states.get(cmd.session_id) ?? {} };
      case "PatchState": {
        const next = applyStatePatch(this.states.get(cmd.session_id) ?? {}, cmd.ops);
        this.states.set(cmd.session_id, next);
        this.emit(cmd.session_id, { type: "StateChanged", ops: cmd.ops, by: "user" });
        return { type: "Ok" };
      }
      case "FrontendReadImage": {
        const c = this.frontendFiles.get(cmd.session_id)?.get(cmd.path);
        if (c === undefined) throw new Error(`no such image: ${cmd.path}`);
        return { type: "Attachment", mime: "image/svg+xml", data: btoa(c) };
      }
      case "FrontendWrite": {
        this.session(cmd.session_id);
        const m = this.frontendFiles.get(cmd.session_id) ?? new Map();
        m.set(cmd.path, cmd.content);
        this.frontendFiles.set(cmd.session_id, m);
        return { type: "Ok" };
      }
      case "FrontendList": {
        const dir = (cmd.dir ?? "").replace(/^\/|\/$/g, "");
        const files = [...(this.frontendFiles.get(cmd.session_id)?.keys() ?? [])].filter((p) => !dir || p.startsWith(dir + "/"));
        return { type: "Files", files };
      }
      case "ListPermissionRules":
        return { type: "PermissionRules", rules: [...this.rules] };
      case "AddPermissionRule": {
        const rule: PermissionRule = { ...cmd.rule, id: `rule-${++this.ruleN}` };
        this.rules.push(rule);
        return { type: "PermissionRuleAdded", rule };
      }
      case "RemovePermissionRule":
        this.rules = this.rules.filter((r) => r.id !== cmd.rule_id);
        return { type: "Ok" };
      case "StartSideThread": {
        const thread_id = `side-${++this.sideN}`;
        const sid = cmd.session_id;
        const log = this.logs.get(sid)!;
        const main = log.find((e) => e.kind.type === "ThreadStarted" && e.kind.main);
        const mainTurns = log.filter((e) => e.thread_id === main?.thread_id && e.kind.type === "TurnEnded").length;
        // Like the core: a fork needs a Main Thread that has run; else a text seed.
        const forked = cmd.source !== "seed" && mainTurns > 0;
        this.sideForked.set(thread_id, forked);
        this.sideWritable.set(thread_id, false);
        this.emit(sid, {
          type: "ThreadStarted", agent_id: "codex", main: false,
          forked_from: forked ? { thread_id: main?.thread_id ?? "main", turn: mainTurns, seq: log.length - 1 } : null,
          excerpt: cmd.excerpt ?? null,
        }, thread_id);
        return { type: "ThreadStarted", thread_id, forked };
      }
      case "ResolvePermission": {
        const req = this.logs.get(cmd.session_id)?.find((e) => e.kind.type === "PermissionRequested" && e.kind.request_id === cmd.request_id);
        if (req) this.emit(cmd.session_id, { type: "PermissionResolved", request_id: cmd.request_id, option_id: cmd.option_id, by: "view" }, req.thread_id);
        return { type: "Ok" };
      }
      case "SetThreadWritable":
        this.sideWritable.set(cmd.thread_id, cmd.writable);
        this.emit(cmd.session_id, { type: "ThreadWritableChanged", writable: cmd.writable }, cmd.thread_id);
        return { type: "Ok" };
      case "ContinueWithSummary": {
        const sid = cmd.session_id;
        this.readOnly.delete(sid);
        this.emit(sid, { type: "AgentSessionStarted", acp_session_id: `acp-cont-${this.logs.get(sid)!.length}`, boundary: "continued_with_summary" });
        if (cmd.text) return this.execute({ type: "Prompt", session_id: sid, thread_id: null, text: cmd.text, attachments: [] });
        return { type: "Ok" };
      }
      case "ReadImageFile":
        throw new Error("no file access in the browser mock");
      case "ReadAttachment": {
        const a = this.attachments.get(cmd.path);
        if (!a) throw new Error("not an attachment of this Session");
        return { type: "Attachment", mime: a.mime, data: a.data };
      }
      case "Prompt": {
        const sid = cmd.session_id;
        if (cmd.thread_id) return this.promptSide(sid, cmd.thread_id, cmd.text);
        if (this.readOnly.has(sid)) throw new Error("Thread is read-only: continue with a summary first");
        // Typing "/readonly" in the mock simulates an Agent that lost its session.
        if (cmd.text.trim() === "/readonly") {
          this.readOnly.add(sid);
          this.emit(sid, { type: "ThreadReadOnly", reason: "agent cannot resume its session" });
          return { type: "Ok" };
        }
        // Typing "/auth" simulates an Agent that needs sign-in.
        if (cmd.text.trim() === "/auth") {
          this.emit(sid, {
            type: "AuthRequired",
            message: "The Agent needs you to sign in first.",
            methods: [
              { id: "browser", name: "Sign in with browser", description: "Opens your browser", kind: "agent" },
              { id: "login", name: "Codex login", description: null, kind: "terminal" },
            ],
          });
          throw new Error("The Agent needs you to sign in first.");
        }
        // Typing "/quiz" simulates an Agent building a practice test with Session State and slots.
        if (cmd.text.trim() === "/quiz") {
          const ops = [{ op: "add" as const, path: "/quiz", value: { step: 0, answers: {}, results: {} } }];
          this.states.set(sid, applyStatePatch(this.states.get(sid) ?? {}, ops));
          this.emit(sid, { type: "StateChanged", ops, by: "agent" });
          const ui = (call: string, input: unknown) =>
            this.emit(sid, { type: "FrontendToolOutput", tool: "render_ui", call_id: call, path: `tools/render_ui/${call}.json`, input });
          ui("quiz-score", { id: "score", placement: "bottom", root: { type: "Stack", props: { direction: "horizontal" }, children: [
            { type: "Stat", props: { label: "Score", value: { $computed: "count", args: { values: { $state: "/quiz/results" }, eq: true } } } },
            { type: "Progress", props: { label: "Answered", value: { $computed: "length", args: { values: { $state: "/quiz/answers" } } }, max: 3 } },
          ] } });
          ui("quiz-test", { id: "test", placement: "right", title: "Rust practice test", root: {
            type: "Stepper",
            props: { steps: ["Ownership", "Option", "Borrowing"], value: { $bindState: "/quiz/step" } },
            on: { finish: { action: "sendMessage", params: { text: "I finished the test." } } },
            children: [
              { type: "Stack", children: [
              { type: "Markdown", props: { text: 'Which feature lets Rust free memory **without** a garbage collector?' } },
              { type: "Choice", props: { value: { $bindState: "/quiz/answers/q1" }, result: { $bindState: "/quiz/results/q1" }, explanation: 'The right answer is A. (mock explanation)', answer: 'a', options: [{ value: 'a', label: 'Ownership' }, { value: 'b', label: 'A garbage collector' }, { value: 'c', label: 'Reference counting only' }] } },
            ] },
              { type: "Stack", children: [
              { type: "Markdown", props: { text: 'Which type shows that a value may be missing?' } },
              { type: "Choice", props: { value: { $bindState: "/quiz/answers/q2" }, result: { $bindState: "/quiz/results/q2" }, explanation: 'The right answer is B. (mock explanation)', answer: 'b', options: [{ value: 'a', label: 'Result<T, E>' }, { value: 'b', label: 'Option<T>' }, { value: 'c', label: 'Vec<T>' }] } },
            ] },
              { type: "Stack", children: [
              { type: "Markdown", props: { text: 'Which rule does the borrow checker enforce?' } },
              { type: "Choice", props: { value: { $bindState: "/quiz/answers/q3" }, result: { $bindState: "/quiz/results/q3" }, explanation: 'The right answer is A. (mock explanation)', answer: 'a', options: [{ value: 'a', label: 'One &mut or many &, not both' }, { value: 'b', label: 'Many &mut at once' }, { value: 'c', label: 'Only one & at a time' }] } },
            ] },
            ],
          } });
          this.emit(sid, { type: "AgentMessageChunk", text: "The practice test has started: the question is on the right, your score is at the bottom." });
          return { type: "Ok" };
        }
        // Typing "/card" simulates an Agent calling the render_ui Frontend Tool with local images.
        if (cmd.text.trim() === "/card") {
          const n = ++this.cardN;
          const input = mockRenderUi(["shots/home.png", "shots/settings.png", "shots/dark.png"]);
          const path = `tools/render_ui/mock-card-${n}.json`;
          const m = this.frontendFiles.get(sid) ?? new Map();
          m.set(path, JSON.stringify(input));
          const files: Record<string, string> = {};
          ["shots/home.png", "shots/settings.png", "shots/dark.png"].forEach((src, i) => {
            files[src] = `files/mock-${n}-${i}.svg`;
            m.set(files[src], mockImage(src, 200 + i * 60));
          });
          this.frontendFiles.set(sid, m);
          this.emit(sid, { type: "FrontendToolOutput", tool: "render_ui", call_id: `mock-card-${n}`, path, input, files });
          return { type: "Ok" };
        }
        const turn = `t${this.logs.get(sid)!.length}`;
        this.setStatus(sid, "working");
        const attachments = (cmd.attachments ?? []).map((a) => this.storeAttachment(a));
        const first = !this.logs.get(sid)!.some((e) => e.kind.type === "TurnStarted");
        const context = first
          ? "<harness_context>\nYou run inside Harness, a desktop app that hosts coding agents. (mock)\n\n## Frontend: Chat\n\nUse `render_ui` for structured results.\n\n## This Session\n- Workspace folder: /mock/project\n- Worktree: no\n</harness_context>"
          : null;
        this.emit(sid, { type: "TurnStarted", turn_id: turn, text: cmd.text, attachments, context });
        const words = `You said: **${cmd.text}**. This is a mock reply.\n\n- streamed\n- in chunks`.split(/(?<= )/);
        words.forEach((w, i) => setTimeout(() => this.emit(sid, { type: "AgentMessageChunk", text: w }), 60 * (i + 1)));
        const end = 60 * (words.length + 1);
        setTimeout(() => {
          this.committed.delete(sid);
          this.emit(sid, { type: "WorkspaceChanged", turn_id: turn, from_tree: "tree-a", to_tree: "tree-b", files: MOCK_FILES });
          this.emit(sid, { type: "TurnEnded", turn_id: turn, stop_reason: "end_turn" });
          // Typing "attention" in a prompt leaves the mock Session needing attention.
          this.setStatus(sid, cmd.text.includes("attention") ? "needs_attention" : "idle");
        }, end);
        return { type: "Ok" };
      }
      default:
        return { type: "Ok" };
    }
  }

  /** A Side Thread's Turn: the Agent Session starts on the first prompt; a reply streams in; "edit" asks to write. */
  private promptSide(sid: string, thread: string, text: string): CommandResult {
    const log = this.logs.get(sid)!;
    const mine = log.filter((e) => e.thread_id === thread);
    if (!mine.some((e) => e.kind.type === "AgentSessionStarted")) {
      this.emit(sid, { type: "AgentSessionStarted", acp_session_id: `acp-${thread}`, boundary: this.sideForked.get(thread) ? "forked" : "initial" }, thread);
    }
    const turn = `${thread}-t${mine.filter((e) => e.kind.type === "TurnStarted").length + 1}`;
    this.emit(sid, { type: "TurnStarted", turn_id: turn, text, attachments: [], context: null }, thread);
    if (/\bedit\b/i.test(text)) {
      const writable = this.sideWritable.get(thread) ?? false;
      const request_id = `${turn}-perm`;
      const tool_call = { toolCallId: `${turn}-edit`, title: "Edit src/hello.ts", kind: "edit" };
      const options = [{ option_id: "allow", name: "Allow", kind: "allow_once" }, { option_id: "reject", name: "Reject", kind: "reject_once" }];
      this.emit(sid, { type: "PermissionRequested", request_id, tool_call, options }, thread);
      if (!writable) this.emit(sid, { type: "PermissionResolved", request_id, option_id: "reject", by: "read_only_thread" }, thread);
    }
    const words = `Side answer to **${text}**. This is a mock reply from a ${this.sideForked.get(thread) ? "forked" : "fresh"} Side Thread.\n\n- read-only unless you allow writes`.split(/(?<= )/);
    words.forEach((w, i) => setTimeout(() => this.emit(sid, { type: "AgentMessageChunk", text: w }, thread), 60 * (i + 1)));
    setTimeout(() => this.emit(sid, { type: "TurnEnded", turn_id: turn, stop_reason: "end_turn" }, thread), 60 * (words.length + 1));
    return { type: "Ok" };
  }

  private setStatus(id: string, status: SessionSummary["status"]) {
    const s = this.session(id);
    s.status = status;
    this.emitApp({ type: "SessionStatus", session_id: id, title: s.title, status });
  }

  private appSubs = new Set<(e: AppEvent) => void>();
  private emitApp(e: AppEvent) {
    this.appSubs.forEach((f) => f(e));
  }

  async subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe> {
    this.appSubs.add(onEvent);
    return () => this.appSubs.delete(onEvent);
  }

  /** A pretend shell: echoes input, `exit` ends it. */
  private terminals = new Map<string, Set<(o: TerminalOutput) => void>>();
  private terminalLine = new Map<string, string>();
  private terminalOut(sessionId: string, text: string) {
    const bytes = new TextEncoder().encode(text);
    this.terminals.get(sessionId)?.forEach((f) => f(bytes));
  }
  private terminalInput(sessionId: string, data: string) {
    let line = this.terminalLine.get(sessionId) ?? "";
    for (const ch of data) {
      if (ch === "\r") {
        if (line.trim() === "exit") {
          this.terminals.get(sessionId)?.forEach((f) => f({ exit: 0 }));
          this.terminals.delete(sessionId);
          this.terminalLine.delete(sessionId);
          return;
        }
        this.terminalOut(sessionId, `\r\n${line ? `mock: ${line}\r\n` : ""}\x1b[32m~\x1b[0m $ `);
        line = "";
      } else if (ch === "\x7f") {
        if (line) this.terminalOut(sessionId, "\b \b");
        line = line.slice(0, -1);
      } else if (ch >= " ") {
        line += ch;
        this.terminalOut(sessionId, ch);
      }
    }
    this.terminalLine.set(sessionId, line);
  }

  async attachTerminal(sessionId: string, _cols: number, _rows: number, onOutput: (o: TerminalOutput) => void): Promise<Unsubscribe> {
    let set = this.terminals.get(sessionId);
    if (!set) {
      this.terminals.set(sessionId, (set = new Set()));
      queueMicrotask(() => this.terminalOut(sessionId, "Mock terminal (browser). Type `exit` to end.\r\n\x1b[32m~\x1b[0m $ "));
    }
    onOutput({ replay: new Uint8Array() });
    set.add(onOutput);
    return () => set.delete(onOutput);
  }

  async subscribe(sessionId: string, fromSeq: number, onEvent: (e: Event) => void): Promise<Unsubscribe> {
    const log = this.logs.get(sessionId) ?? [];
    log.filter((e) => e.seq >= fromSeq).forEach(onEvent);
    let set = this.subs.get(sessionId);
    if (!set) this.subs.set(sessionId, (set = new Set()));
    set.add(onEvent);
    return () => set.delete(onEvent);
  }
}

const MOCK_REGISTRY: Omit<RegistryAgent, "installed_version">[] = [
  { id: "claude-acp", name: "Claude", version: "1.2.0", description: "Anthropic's Claude Code agent", icon: null, website: "https://claude.com", install_method: "npx" },
  { id: "codex-acp", name: "Codex", version: "0.9.1", description: "OpenAI's Codex CLI agent", icon: null, website: "https://openai.com/codex", install_method: "binary" },
  { id: "opencode", name: "OpenCode", version: "0.5.0", description: "Open source coding agent", icon: null, website: "https://opencode.ai", install_method: "npx" },
  { id: "windows-only", name: "Windows Only Agent", version: "1.0.0", description: "No build for this Mac", icon: null, website: null, install_method: null },
];

const NOW_S = Math.floor(Date.now() / 1000);
/** Newest first. */
const MOCK_COMMITS: Commit[] = [
  { sha: "c3f1a9e7d2b84c0a5e6f7a1b9c8d3e2f4a5b6c7d", short: "c3f1a9e", subject: "Document routes, lowercase method match", author: "Dennis", author_email: "dennis@example.com", committer: "Dennis", body: "Router matches methods case-insensitively now; the guide lists every route.\n\nCo-authored-by: Claude <noreply@anthropic.com>", time: NOW_S - 1800 },
  { sha: "b2e8d4a61f903c7b5a2d8e4f6c1a0b9d7e3f5a21", short: "b2e8d4a", subject: "Drop legacy entry point, greet by name", author: "Dennis", author_email: "dennis@example.com", committer: "Dennis", body: "", time: NOW_S - 7200 },
  { sha: "a1d7c3f50e8b2a4d6c9f1e3b5a7d0c2e4f6a8b10", short: "a1d7c3f", subject: "Add README, bump to 0.2.0 with dev script", author: "Sam", author_email: "sam@example.com", committer: "Dennis", body: "Adds a `dev` script that reloads on save.", time: NOW_S - 86400 },
];
const MOCK_COMMIT_FILES: Record<string, string[]> = {
  [MOCK_COMMITS[0].sha]: ["docs/guide.md", "src/server/router.ts"],
  [MOCK_COMMITS[1].sha]: ["src/legacy.ts", "src/hello.ts"],
  [MOCK_COMMITS[2].sha]: ["README.md", "package.json"],
};
const MOCK_UNCOMMITTED = ["src/hello.ts", "src/server/router.ts"];

const MOCK_FILES: FileChange[] = [
  { path: "README.md", status: "A", additions: 2, deletions: 0 },
  { path: "docs/guide.md", status: "M", additions: 3, deletions: 2 },
  { path: "package.json", status: "M", additions: 3, deletions: 2 },
  { path: "src/hello.ts", status: "M", additions: 3, deletions: 1 },
  { path: "src/legacy.ts", status: "D", additions: 0, deletions: 5 },
  { path: "src/server/router.ts", status: "M", additions: 6, deletions: 4 },
];

const MOCK_THEME = {
  $schema: "https://ui.shadcn.com/schema/registry-item.json",
  name: "Zen Inspired Theme",
  cssVars: {
    theme: { "font-sans": "\"Inter\", sans-serif", "font-mono": "\"JetBrains Mono\", monospace", radius: "0.5rem" },
    light: { background: "oklch(0.9195 0.0169 88.0030)", foreground: "oklch(0.2350 0 0)", card: "oklch(0.9530 0.0156 86.4257)", primary: "oklch(0.3012 0 0)", "primary-foreground": "oklch(0.9169 0.0175 99.6160)", secondary: "oklch(0.8647 0.0201 87.5232)", muted: "oklch(0.8340 0.0232 87.1630)", "muted-foreground": "oklch(0.4688 0.0136 84.5932)", accent: "oklch(0.9169 0.0175 99.6160)", border: "oklch(0.8340 0.0232 87.1630)" },
    dark: { background: "oklch(0.2178 0 0)", foreground: "oklch(0.9169 0.0175 99.6160)", card: "oklch(0.2520 0 0)", primary: "oklch(0.9169 0.0175 99.6160)", "primary-foreground": "oklch(0.2350 0 0)", secondary: "oklch(0.3012 0 0)", muted: "oklch(0.2850 0 0)", "muted-foreground": "oklch(0.7200 0.0136 84.5932)", accent: "oklch(0.3200 0 0)", border: "oklch(0.3200 0 0)" },
  },
};
