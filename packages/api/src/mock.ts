import type { AppEvent, Attachment, AttachmentInput, Commit, McpServerDef, AgentInfo, BranchInfo, PullRequest, RegistryAgent, Command, CommandResult, Event, EventKind, FileChange, FrontendToolDecl, PermissionRule, SessionSummary, WorkspaceInfo } from "./generated";
import type { Transport, Unsubscribe } from "./transport";
import { MOCK_NEW, MOCK_OLD, MOCK_PATCH } from "./mockRepo";

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
        this.emit(cmd.session_id, { type: "ThreadStarted", agent_id: "codex", main: false }, thread_id);
        this.emit(cmd.session_id, { type: "AgentSessionStarted", acp_session_id: `acp-${thread_id}`, boundary: "initial" }, thread_id);
        return { type: "ThreadStarted", thread_id };
      }
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
        this.emit(sid, { type: "TurnStarted", turn_id: turn, text: cmd.text, attachments });
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
