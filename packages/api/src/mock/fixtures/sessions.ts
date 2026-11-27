import type { SessionSummary, TextAnchor, WorkspaceInfo } from "../../generated";
import type { MockTransport } from "../mock";
import { mockSubSessionLogs } from "../mockSubSessions";

export function seedSessions(mock: MockTransport): void {
   mock.addSession("mock-1", "Mock session (fixture replay)", "chat");
   // The fixture Shared Artifacts' attachments, logged as the core would.
   if (mock.fixture.length > 0)
      for (const a of mock.shared.values())
         if (a.meta.attached?.includes("mock-1"))
            mock.emit("mock-1", { type: "ArtifactAttached", id: a.meta.id, by: "user" }, null);
   if (mock.fixture.length > 0) seedComments(mock);
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
         // A running tool group: done steps, then one still running. Long path + command test truncation.
         const tools: [string, string, "read" | "search" | "execute" | "edit", object, boolean][] =
            [
               [
                  "w-1",
                  "Read app/src/session-header/SessionHeader.tsx",
                  "read",
                  { file_path: "/Users/me/harness/app/src/session-header/SessionHeader.tsx" },
                  true,
               ],
               [
                  "w-2",
                  "grep -rn compact app/src",
                  "search",
                  { pattern: "compact", path: "app/src" },
                  true,
               ],
               [
                  "w-3",
                  "cd ~/harness/.claude/worktrees/compact-header && bun run --cwd app typecheck && bunx vitest run --project dom app/src/session-header",
                  "execute",
                  {
                     command:
                        "cd ~/harness/.claude/worktrees/compact-header && bun run --cwd app typecheck && bunx vitest run --project dom app/src/session-header",
                  },
                  true,
               ],
               [
                  "w-4",
                  "Write /Users/me/.harness/sessions/01a1c47c-354f-73be-b754-b9b5ca2a8d82/scratchpad/compact-header-notes.md",
                  "edit",
                  {
                     file_path:
                        "/Users/me/.harness/sessions/01a1c47c-354f-73be-b754-b9b5ca2a8d82/scratchpad/compact-header-notes.md",
                     content: "",
                  },
                  false,
               ],
            ];
         for (const [id, title, kind, raw_input, done] of tools) {
            mock.emit(sid, {
               type: "ToolCall",
               tool_call_id: id,
               title,
               kind,
               status: done ? "completed" : "in_progress",
               content: [],
               locations: [],
               raw_input,
            });
         }
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
   seedInlineThreads(mock, ws("/Users/me/fetchkit"));
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
   // Turns that ended while nobody looked: the sidebar marks them.
   for (const s of mock.sessions)
      if (
         ["Ping and pong greeting", "Hono route types", "Bump jsonv-ts schema exports"].includes(
            s.title,
         )
      )
         s.unseen = true;
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

/** Review Comments (ADR 0027) on the fixture diff: sent, Agent, resolved and pending. */
function seedComments(mock: MockTransport): void {
   const add = (
      id: string,
      path: string,
      line: number,
      side: "old" | "new",
      code: string,
      text: string,
      by: "user" | "agent" = "user",
   ) =>
      mock.emit(
         "mock-1",
         { type: "CommentAdded", comment: { id, path, line, side, code, text, by } },
         null,
      );
   add(
      "c1",
      "src/hello.ts",
      2,
      "new",
      '  const name = "world";',
      "Why hardcode the name? Take it as a parameter.",
   );
   add(
      "c2",
      "src/hello.ts",
      5,
      "new",
      "export const answer = 42;",
      "Unused export. Remove it or document why it exists.",
      "agent",
   );
   add("c3", "src/hello.ts", 2, "old", '  return "hi";', "Keep the greeting configurable.");
   add(
      "c4",
      "src/server/router.ts",
      114,
      "new",
      "  const m = method.toUpperCase();",
      "Normalize once at registration instead.",
   );
   mock.emit("mock-1", { type: "CommentsSent", ids: ["c1", "c3"] }, null);
   mock.emit(
      "mock-1",
      { type: "CommentResolved", id: "c3", by: "agent", note: "Greeting now uses the name." },
      null,
   );
}

/**
 * A Session with Inline Threads (ADR 0030) on one finished agent message: two overlapping open ones
 * with replies, and a resolved one.
 */
function seedInlineThreads(mock: MockTransport, workspace: WorkspaceInfo): void {
   const sid = "mock-inline";
   mock.addSession(sid, "Retry loop questions", "chat", false, "/Users/me/fetchkit", workspace);
   const s = mock.sessions.at(-1)!;
   const start = Date.now() - 2 * 3600e3;
   s.created_ms = start;
   s.updated_ms = Date.now() - 600e3;
   const main = mock.mainThread(sid);
   const lastSeq = () => mock.logs.get(sid)!.at(-1)!.seq;
   mock.emit(sid, {
      type: "TurnStarted",
      turn_id: "t-main-1",
      text: "How does the retry loop in fetchWithRetry work?",
   });
   const chunks = [
      "The retry loop in `fetchWithRetry` tries the request up to three times. After each failure it waits twice as long as the time before, starting at 200 ms, so the delays are 200, 400 and 800 ms.",
      "\n\nA 4xx response is not retried, because the request itself is wrong. Only network errors and 5xx responses start a new try.",
   ];
   mock.emit(sid, { type: "AgentMessageChunk", text: chunks[0]! });
   const message = lastSeq();
   mock.emit(sid, { type: "AgentMessageChunk", text: chunks[1]! });
   mock.emit(sid, { type: "TurnEnded", turn_id: "t-main-1", stop_reason: "end_turn" });
   const forkedFrom = { thread_id: main, turn: 1, seq: lastSeq() };
   // Rendered text: Markdown drops the backticks and turns the paragraph break into one.
   const rendered = chunks.join("").replaceAll("`", "").replace("\n\n", "\n");
   const anchorOf = (quote: string): TextAnchor => {
      const at = rendered.indexOf(quote);
      return {
         thread_id: main,
         seq: message,
         quote,
         prefix: rendered.slice(Math.max(0, at - 32), at),
         suffix: rendered.slice(at + quote.length, at + quote.length + 32),
      };
   };
   const threads: [string, string, string, string, boolean][] = [
      [
         "inline-1",
         "waits twice as long as the time before",
         "Is there a cap on the wait?",
         "No. With three tries the longest wait is 800 ms, so a cap is not needed. If the number of tries grows, add one.",
         false,
      ],
      [
         "inline-2",
         "twice as long as the time before, starting at 200 ms",
         "Why start at 200 ms?",
         "It is short enough that a user does not notice one retry, and long enough for a busy server to recover.",
         false,
      ],
      [
         "inline-3",
         "A 4xx response is not retried",
         "What about 429?",
         "429 is a 4xx code, so it is not retried now. It should be: the server asks the client to wait. I can add that.",
         true,
      ],
   ];
   for (const [id, quote, question, reply, resolved] of threads) {
      const a = anchorOf(quote);
      mock.emit(
         sid,
         {
            type: "ThreadStarted",
            agent_id: "codex",
            main: false,
            forked_from: forkedFrom,
            anchor: a,
         },
         id,
      );
      mock.emit(
         sid,
         { type: "AgentSessionStarted", acp_session_id: `acp-${id}`, boundary: "forked" },
         id,
      );
      mock.emit(
         sid,
         {
            type: "TurnStarted",
            turn_id: `t-${id}`,
            text: `Comments on the conversation:\n\n> ${quote}\n\n---\n\n${question}`,
         },
         id,
      );
      mock.emit(sid, { type: "AgentMessageChunk", text: reply }, id);
      mock.emit(sid, { type: "TurnEnded", turn_id: `t-${id}`, stop_reason: "end_turn" }, id);
      if (resolved) mock.emit(sid, { type: "SideThreadResolved", resolved: true }, id);
   }
   // Spread over the Session's life, oldest first.
   const log = mock.logs.get(sid)!;
   log.forEach((e, i) => {
      e.ts_ms = start + (i * (s.updated_ms - start)) / log.length;
   });
}
