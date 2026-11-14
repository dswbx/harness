import type { SessionSummary, WorkspaceInfo } from "../../generated";
import type { MockTransport } from "../mock";
import { mockSubSessionLogs } from "../mockSubSessions";

export function seedSessions(mock: MockTransport): void {
   mock.addSession("mock-1", "Mock session (fixture replay)", "chat");
   // The fixture Shared Artifacts' attachments, logged as the core would.
   if (mock.fixture.length > 0)
      for (const a of mock.shared.values())
         if (a.meta.attached?.includes("mock-1"))
            mock.emit("mock-1", { type: "ArtifactAttached", id: a.meta.id, by: "user" }, null);
   // Sample Sessions covering the sidebar's cases (worktree, PR, plain branch, no git, ages).
   const h = 3600e3;
   const ws = (folder: string, o: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
      repo_root: folder,
      source_folder: folder,
      worktree_branch: null,
      base_branch: null,
      branch: "main",
      pr: null,
      pr_state: null,
      pr_checks: null,
      ...o,
   });
   const samples: [string, string, number, number, WorkspaceInfo, SessionSummary["status"]?][] = [
      [
         "Compact header layout",
         "/Users/me/harness",
         2,
         0.2,
         ws("/Users/me/harness", {
            worktree_branch: "harness/compact-header",
            base_branch: "main",
            branch: "harness/compact-header",
         }),
         "working",
      ],
      [
         "Schema refs",
         "/Users/me/jsonv-ts",
         50,
         26,
         ws("/Users/me/jsonv-ts", {
            worktree_branch: "feat/attachments",
            base_branch: "main",
            branch: "feat/attachments",
            pr: 142,
            pr_state: "open",
            pr_checks: "failing",
         }),
         "needs_attention",
      ],
      [
         "Ping and pong greeting",
         "/Users/me/harness",
         60,
         58,
         ws("/Users/me/harness", {
            branch: "ping-greeting",
            pr: 61,
            pr_state: "draft",
            pr_checks: "pending",
         }),
      ],
      [
         "Hono route types",
         "/Users/me/jsonv-ts",
         200,
         150,
         ws("/Users/me/jsonv-ts", {
            branch: "side-thread-config",
            pr: 139,
            pr_state: "merged",
            pr_checks: "passing",
         }),
      ],
      [
         "Rust lifetimes questions",
         "/Users/me/scratch",
         400,
         380,
         ws("/Users/me/scratch", { repo_root: null, branch: null }),
      ],
      [
         "Detached checkout",
         "/Users/me/supalite",
         600,
         560,
         ws("/Users/me/supalite", { branch: null }),
      ],
      ["Biome config cleanup", "/Users/me/dotfiles", 1500, 1400, ws("/Users/me/dotfiles")],
   ];
   samples.forEach(([title, folder, c, u, workspace, status], i) => {
      mock.addSession(`mock-s${i + 1}`, title, "chat", false, folder, workspace);
      const s = mock.sessions.at(-1)!;
      s.created_ms = Date.now() - c * h;
      s.updated_ms = Date.now() - u * h;
      if (status) s.status = status;
      // A working Session has a Turn that never ends, so the chat shows its "Working" row.
      if (status === "working") {
         const sid = `mock-s${i + 1}`;
         mock.emit(sid, {
            type: "TurnStarted",
            turn_id: "t-working",
            text: "Make the session header compact.",
            attachments: [],
            context: null,
         });
         mock.logs.get(sid)!.at(-1)!.ts_ms -= 95e3;
         mock.emit(sid, { type: "AgentMessageChunk", text: "Looking at `SessionHeader.tsx`…" });
      }
      // An idle Session whose Agent left a shell command running: "1 background job running".
      if (title === "Ping and pong greeting") {
         const sid = `mock-s${i + 1}`;
         mock.emit(sid, {
            type: "ToolCall",
            tool_call_id: "bg-1",
            title: "bun run dev",
            kind: "execute",
            status: "pending",
            content: [],
            locations: [],
            raw_input: { command: "bun run dev", run_in_background: true },
         });
         mock.emit(sid, {
            type: "ToolCallUpdate",
            tool_call_id: "bg-1",
            title: null,
            kind: null,
            status: "completed",
            content: [
               {
                  type: "content",
                  content: {
                     type: "text",
                     text: "Command running in background with ID: b771yrkd7.",
                  },
               },
            ],
            locations: null,
            raw_input: null,
            raw_output: null,
            background_job: { id: "b771yrkd7", output_file: "/tmp/tasks/b771yrkd7.output" },
         });
      }
   });
   // A parent with two Sub Sessions in other repositories: one with a PR, one needing attention.
   const subs: [
      string,
      string,
      string,
      number,
      Partial<WorkspaceInfo>,
      SessionSummary["status"]?,
   ][] = [
      ["mock-p1", "Release prep across repos", "/Users/me/harness", 1, {}],
      [
         "mock-p1-a",
         "Bump jsonv-ts schema exports",
         "/Users/me/jsonv-ts",
         1.5,
         { branch: "bump-exports", pr: 145, pr_state: "open", pr_checks: "passing" },
      ],
      [
         "mock-p1-b",
         "Check supalite RLS cases",
         "/Users/me/supalite",
         0.5,
         { branch: "rls-cases" },
         "needs_attention",
      ],
   ];
   for (const [id, title, folder, age, o, status] of subs) {
      mock.addSession(id, title, "chat", false, folder, ws(folder, o));
      const s = mock.sessions.at(-1)!;
      s.created_ms = Date.now() - 3 * h;
      s.updated_ms = Date.now() - age * h;
      if (status) s.status = status;
      if (id !== "mock-p1")
         s.parent = { session_id: "mock-p1", thread_id: mock.mainThread("mock-p1") };
   }
   for (const [sid, kinds] of Object.entries(mockSubSessionLogs())) {
      for (const k of kinds) mock.emit(sid, k);
      // Spread over the last ~3 hours, oldest first.
      const log = mock.logs.get(sid)!;
      log.forEach((e, i) => {
         e.ts_ms = Date.now() - 3 * h + (i * 3 * h) / log.length;
      });
   }
   const quick: [string, number][] = [
      ["Compare SQLite and libSQL", 3],
      ["Convert seconds to hours", 50],
   ];
   quick.forEach(([title, age], i) => {
      mock.addQuickSession(`mock-q${i + 1}`, title, "chat");
      const s = mock.sessions.at(-1)!;
      s.created_ms = Date.now() - age * h;
      s.updated_ms = s.created_ms;
   });
}
