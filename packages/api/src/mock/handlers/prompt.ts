import { baseName } from "../../derive/paths";
import { applyStatePatch } from "../../derive/state";
import { CommandError } from "../../errors";
import type { Attachment, AttachmentInput, CommandResult, SessionSummary } from "../../generated";
import { MOCK_FILES } from "../fixtures/git";
import { mockImage, mockRenderUi } from "../fixtures/renderUi";
import type { MockTransport } from "../mock";
import { stressLiveTurn } from "../stressLive";
import { markCommentsSent } from "./comments";
import type { Handler, Handlers } from "./types";

export function storeAttachment(mock: MockTransport, a: AttachmentInput): Attachment {
   if (a.type === "path") {
      const name = a.path.split("/").pop() ?? a.path;
      return { name, mime: "application/octet-stream", path: a.path, kind: "file" };
   }
   const path = `/mock/attachments/${mock.attachments.size}-${a.name}`;
   mock.attachments.set(path, { mime: a.mime, data: a.data });
   return {
      name: a.name,
      mime: a.mime,
      path,
      kind: a.mime.startsWith("image/") ? "image" : "file",
   };
}

/** A Side Thread's Turn: the Agent Session starts on the first prompt; a reply streams in; "edit" asks to write. */
export function promptSide(
   mock: MockTransport,
   sid: string,
   thread: string,
   text: string,
): CommandResult {
   const log = mock.logs.get(sid)!;
   const mine = log.filter((e) => e.thread_id === thread);
   if (!mine.some((e) => e.kind.type === "AgentSessionStarted")) {
      mock.emit(
         sid,
         {
            type: "AgentSessionStarted",
            acp_session_id: `acp-${thread}`,
            boundary: mock.sideForked.get(thread) ? "forked" : "initial",
         },
         thread,
      );
   }
   const turn = `${thread}-t${mine.filter((e) => e.kind.type === "TurnStarted").length + 1}`;
   mock.emit(
      sid,
      { type: "TurnStarted", turn_id: turn, text, attachments: [], context: null },
      thread,
   );
   if (/\bedit\b/i.test(text)) {
      const request_id = `${turn}-perm`;
      const tool_call = { toolCallId: `${turn}-edit`, title: "Edit src/hello.ts", kind: "edit" };
      const options = [
         { option_id: "allow", name: "Allow", kind: "allow_once" },
         { option_id: "reject", name: "Reject", kind: "reject_once" },
      ];
      mock.emit(sid, { type: "PermissionRequested", request_id, tool_call, options }, thread);
   }
   const words =
      `Side answer to **${text}**. This is a mock reply from a ${mock.sideForked.get(thread) ? "forked" : mock.sideFresh.has(thread) ? "fresh" : "seeded"} Side Thread.`.split(
         /(?<= )/,
      );
   words.forEach((w, i) =>
      setTimeout(
         () => mock.emit(sid, { type: "AgentMessageChunk", text: w }, thread),
         60 * (i + 1),
      ),
   );
   turnStarted(mock, sid);
   setTimeout(() => turnEnded(mock, sid, thread, turn), 60 * (words.length + 1));
   return { type: "Ok" };
}

/** Like the core: a change is logged (`SessionStatusChanged`) and then announced; no change, nothing. */
function setStatus(mock: MockTransport, id: string, status: SessionSummary["status"]) {
   const s = mock.sessions.find((x) => x.id === id);
   if (!s || s.status === status) return;
   s.status = status;
   s.updated_ms = Date.now();
   mock.emit(id, { type: "SessionStatusChanged", status }, null);
   mock.emitApp({
      type: "SessionStatus",
      session_id: id,
      title: s.title,
      status,
      unused: s.unused,
      unseen: s.unseen,
      title_explicit: s.title_explicit,
   });
}

/** A Turn is logged as started: the Session counts it and is working. */
function turnStarted(mock: MockTransport, sid: string) {
   mock.turns.set(sid, (mock.turns.get(sid) ?? 0) + 1);
   setStatus(mock, sid, "working");
}

/**
 * A Turn ends, in the core's order: the Session stops counting it (and goes idle, or stays
 * `needs_attention`), `TurnEnded` is logged, then `TurnFinished` is announced.
 */
function turnEnded(
   mock: MockTransport,
   sid: string,
   thread: string,
   turn_id: string,
   attention = false,
) {
   const left = Math.max(0, (mock.turns.get(sid) ?? 1) - 1);
   mock.turns.set(sid, left);
   setStatus(mock, sid, attention ? "needs_attention" : left > 0 ? "working" : "idle");
   mock.emit(sid, { type: "TurnEnded", turn_id, stop_reason: "end_turn" }, thread);
   const s = mock.sessions.find((x) => x.id === sid);
   if (s)
      mock.emitApp({
         type: "TurnFinished",
         session_id: sid,
         thread_id: thread,
         title: s.title,
         stop_reason: "end_turn",
         main: thread === mock.mainThread(sid),
      });
   // Like the core, after `TurnFinished`: a Main Thread Turn that ended marks the Session unseen.
   if (s && thread === mock.mainThread(sid) && !s.unseen) {
      s.unseen = true;
      mock.emitApp({
         type: "SessionStatus",
         session_id: sid,
         title: s.title,
         status: s.status,
         unused: s.unused,
         unseen: true,
         title_explicit: s.title_explicit,
      });
   }
}

const promptMain: Handler<"Prompt"> = async (mock, cmd) => {
   const sid = cmd.session_id;
   const used = mock.session(sid);
   if (used.archived)
      throw new CommandError("conflict", "this Session is archived; unarchive it first");
   if (cmd.thread_id && !mock.logs.get(sid)?.some((e) => e.thread_id === cmd.thread_id))
      throw new CommandError("not_found", `unknown thread ${cmd.thread_id}`);
   if (used.unused) {
      // Like the core: a prompt on any Thread uses the Session; only a Main Thread prompt
      // replaces a placeholder title.
      used.unused = false;
      const line = cmd.text.trim().split("\n")[0] ?? "";
      if (!cmd.thread_id && used.title === "New Quick Session" && line)
         used.title = line.length > 40 ? `${line.slice(0, 40).trimEnd()}…` : line;
      mock.emitApp({
         type: "SessionStatus",
         session_id: sid,
         title: used.title,
         status: used.status,
         unused: false,
         unseen: used.unseen,
         title_explicit: used.title_explicit,
      });
   }
   if (cmd.thread_id) return promptSide(mock, sid, cmd.thread_id, cmd.text);
   if (mock.readOnly.has(sid))
      throw new CommandError(
         "agent_unavailable",
         "Thread is read-only: continue with a summary first",
      );
   // Typing "/readonly" in the mock simulates an Agent that lost its session.
   if (cmd.text.trim() === "/readonly") {
      mock.readOnly.add(sid);
      mock.emit(sid, {
         type: "ThreadReadOnly",
         reason: "The Agent could not reopen its earlier session.",
         retryable: false,
         errors: [],
         transcript: { kept_turns: 18, total_turns: 42 },
      });
      throw new CommandError(
         "agent_unavailable",
         "The Agent could not reopen its earlier session.",
      );
   }
   // Typing "/restorefail" simulates a resume that fails; the next try works.
   if (cmd.text.trim() === "/restorefail" && !mock.restoreFailed.has(sid)) {
      mock.restoreFailed.add(sid);
      mock.emit(sid, { type: "AgentProcessState", state: "starting", message: null });
      await new Promise((r) => setTimeout(r, 1200));
      mock.emit(sid, { type: "AgentProcessState", state: "ready", message: null });
      for (const attempt of [1, 2, 3]) {
         mock.emit(sid, { type: "AgentSessionRestoring", attempt, of: 3 });
         await new Promise((r) => setTimeout(r, 1200));
      }
      mock.emit(sid, {
         type: "ThreadReadOnly",
         reason: "The Agent could not reopen its earlier session.",
         retryable: true,
         errors: ["resume: Internal error"],
         transcript: { kept_turns: 18, total_turns: 42 },
      });
      throw new CommandError(
         "agent_unavailable",
         "The Agent could not reopen its earlier session. Try again, or continue from a transcript.",
      );
   }
   if (cmd.text.trim() === "/restorefail")
      mock.emit(sid, {
         type: "AgentSessionStarted",
         acp_session_id: `acp-res-${mock.logs.get(sid)!.length}`,
         boundary: "resumed",
      });
   // Typing "/apprestart" simulates reopening the app: the Agent process is gone.
   if (cmd.text.trim() === "/apprestart") {
      mock.emit(sid, {
         type: "AgentProcessState",
         state: "stopped",
         message: "app_restart",
      });
      return { type: "Ok" };
   }
   // Typing "/unsaved" simulates a Session Log that cannot be written; typing it again, that it can be again.
   if (cmd.text.trim() === "/unsaved") {
      const s = mock.session(sid);
      s.log_error = s.log_error ? null : "No space left on device (os error 28)";
      mock.emitApp({
         type: "SessionLogHealth",
         session_id: sid,
         error: s.log_error,
         dropped: s.log_error ? 0 : 3,
      });
      return { type: "Ok" };
   }
   // Typing "/auth" simulates an Agent that needs sign-in.
   if (cmd.text.trim() === "/auth") {
      mock.emit(sid, {
         type: "AuthRequired",
         message: "The Agent needs you to sign in first.",
         agent_name: "Codex",
         methods: [
            {
               id: "browser",
               name: "Sign in with browser",
               description: "Opens your browser",
               kind: "agent",
            },
            { id: "login", name: "Codex login", description: null, kind: "terminal" },
         ],
      });
      throw new CommandError("auth_required", "The Agent needs you to sign in first.");
   }
   // Typing "/quiz" simulates an Agent building a practice test with Session State and slots.
   if (cmd.text.trim() === "/quiz") {
      const ops = [
         {
            op: "add" as const,
            path: "/quiz",
            value: { step: 0, answers: {}, results: {} },
         },
      ];
      mock.states.set(sid, applyStatePatch(mock.states.get(sid) ?? {}, ops));
      mock.emit(sid, { type: "StateChanged", ops, by: "agent" });
      const ui = (call: string, input: unknown) =>
         mock.emit(sid, {
            type: "FrontendToolOutput",
            tool: "render_ui",
            call_id: call,
            path: `tools/render_ui/${call}.json`,
            input,
         });
      ui("quiz-score", {
         id: "score",
         placement: "bottom",
         root: {
            type: "Stack",
            props: { direction: "horizontal" },
            children: [
               {
                  type: "Stat",
                  props: {
                     label: "Score",
                     value: {
                        $computed: "count",
                        args: { values: { $state: "/quiz/results" }, eq: true },
                     },
                  },
               },
               {
                  type: "Progress",
                  props: {
                     label: "Answered",
                     value: {
                        $computed: "length",
                        args: { values: { $state: "/quiz/answers" } },
                     },
                     max: 3,
                  },
               },
            ],
         },
      });
      ui("quiz-test", {
         id: "test",
         placement: "right",
         title: "Rust practice test",
         root: {
            type: "Stepper",
            props: {
               steps: ["Ownership", "Option", "Borrowing"],
               value: { $bindState: "/quiz/step" },
            },
            on: {
               finish: { action: "sendMessage", params: { text: "I finished the test." } },
            },
            children: [
               {
                  type: "Stack",
                  children: [
                     {
                        type: "Markdown",
                        props: {
                           text: "Which feature lets Rust free memory **without** a garbage collector?",
                        },
                     },
                     {
                        type: "Choice",
                        props: {
                           value: { $bindState: "/quiz/answers/q1" },
                           result: { $bindState: "/quiz/results/q1" },
                           explanation: "The right answer is A. (mock explanation)",
                           answer: "a",
                           options: [
                              { value: "a", label: "Ownership" },
                              { value: "b", label: "A garbage collector" },
                              { value: "c", label: "Reference counting only" },
                           ],
                        },
                     },
                  ],
               },
               {
                  type: "Stack",
                  children: [
                     {
                        type: "Markdown",
                        props: { text: "Which type shows that a value may be missing?" },
                     },
                     {
                        type: "Choice",
                        props: {
                           value: { $bindState: "/quiz/answers/q2" },
                           result: { $bindState: "/quiz/results/q2" },
                           explanation: "The right answer is B. (mock explanation)",
                           answer: "b",
                           options: [
                              { value: "a", label: "Result<T, E>" },
                              { value: "b", label: "Option<T>" },
                              { value: "c", label: "Vec<T>" },
                           ],
                        },
                     },
                  ],
               },
               {
                  type: "Stack",
                  children: [
                     {
                        type: "Markdown",
                        props: { text: "Which rule does the borrow checker enforce?" },
                     },
                     {
                        type: "Choice",
                        props: {
                           value: { $bindState: "/quiz/answers/q3" },
                           result: { $bindState: "/quiz/results/q3" },
                           explanation: "The right answer is A. (mock explanation)",
                           answer: "a",
                           options: [
                              { value: "a", label: "One &mut or many &, not both" },
                              { value: "b", label: "Many &mut at once" },
                              { value: "c", label: "Only one & at a time" },
                           ],
                        },
                     },
                  ],
               },
            ],
         },
      });
      mock.emit(sid, {
         type: "AgentMessageChunk",
         text: "The practice test has started: the question is on the right, your score is at the bottom.",
      });
      return { type: "Ok" };
   }
   // Typing "/artifacts" simulates a reply with a diagram, a table and a pull request (the Artifacts panel).
   if (cmd.text.trim() === "/artifacts") {
      mock.emit(sid, {
         type: "AgentMessageChunk",
         text: "The checkout flow:\n\n```mermaid\nflowchart LR\n  Cart --> Checkout --> Iframe[Payment iframe] --> Confirm\n```\n\nLast 20 CI runs:\n\n| Test | Fails | Median wait |\n| --- | --- | --- |\n| pays | 6 / 20 | 1.8 s |\n| refunds | 1 / 20 | 0.9 s |\n",
      });
      mock.emit(sid, {
         type: "FrontendToolOutput",
         tool: "render_ui",
         call_id: `mock-pr-${++mock.cardN}`,
         path: `tools/render_ui/mock-pr-${mock.cardN}.json`,
         input: {
            root: {
               type: "PullRequest",
               props: {
                  repo: "dswbx/harness",
                  number: 8,
                  title: "Fix flaky checkout test: wait for payment iframe",
                  state: "open",
                  url: "https://github.com/",
                  head: "fix-checkout-flake",
                  base: "main",
                  additions: 42,
                  deletions: 9,
                  files: 3,
                  checks: { passed: 8, pending: 1 },
                  review: "required",
               },
            },
         },
      });
      return { type: "Ok" };
   }
   // Typing "/prs" simulates a reply with PR references in every form (chips; one batched lookup).
   if (cmd.text.trim() === "/prs") {
      mock.emit(sid, {
         type: "AgentMessageChunk",
         text: "PR roundup: harness#23 landed, supabase/spark#17 is open and spark#12 merged. https://github.com/dswbx/harness/pull/21 has failing checks; draft harness#20 and closed dswbx/harness#18 stay as they are, harness#999 does not exist.\n\nText only: C#, step #3, `spark#24` in code, and [the chips PR](https://github.com/dswbx/harness/pull/24).",
      });
      return { type: "Ok" };
   }
   // Typing "/files" simulates a reply naming files in the folder, outside it, and one that can hold secrets.
   if (cmd.text.trim() === "/files") {
      mock.emit(sid, {
         type: "AgentMessageChunk",
         text: "Files: `src/hello.ts:2` in the folder, `~/notes/ideas.md` outside it, and `~/.aws/config` in a hidden folder (locked until allowed). `~/missing.md` does not exist.",
      });
      return { type: "Ok" };
   }
   // Typing "/permission" simulates two pending permission requests: a multi-line command and an edit with a diff.
   if (cmd.text.trim() === "/permission") {
      const turn = `t${mock.logs.get(sid)!.length}`;
      mock.emit(sid, {
         type: "TurnStarted",
         turn_id: turn,
         text: cmd.text,
         attachments: [],
         context: null,
      });
      turnStarted(mock, sid);
      const command =
         'set -e\ncd packages/api\nbun install --frozen-lockfile\nbun run typecheck\nbun run test -- --reporter=dot\necho "all green"';
      const diff = {
         type: "diff",
         path: "src/hello.ts",
         oldText: 'export const hello = () => "hi";\n',
         newText:
            'export const hello = (name: string) => `hi ${name}`;\n\nexport const bye = () => "bye";\n',
      };
      const calls = [
         {
            id: `${turn}-run`,
            title: "Run tests",
            kind: "execute",
            content: [],
            raw: { command },
         },
         {
            id: `${turn}-edit`,
            title: "Edit src/hello.ts",
            kind: "edit",
            content: [diff],
            raw: { file_path: "src/hello.ts" },
         },
      ];
      for (const c of calls) {
         mock.emit(sid, {
            type: "ToolCall",
            tool_call_id: c.id,
            title: c.title,
            kind: c.kind,
            status: "pending",
            content: c.content,
            locations: [],
            raw_input: c.raw,
         });
         mock.emit(sid, {
            type: "PermissionRequested",
            request_id: `${c.id}-perm`,
            tool_call: { toolCallId: c.id, title: c.title, kind: c.kind, content: c.content },
            options: [
               { option_id: "allow", name: "Allow", kind: "allow_once" },
               { option_id: "always", name: "Always allow", kind: "allow_always" },
               { option_id: "reject", name: "Reject", kind: "reject_once" },
            ],
         });
      }
      return { type: "Ok" };
   }
   // Typing "/stress [minutes]" streams a long Turn with 8 background subagents (about 2,500 Events), for profiling.
   const stress = /^\/stress(?:[ \t]+(\d+(?:\.\d+)?))?(?:\s|$)/.exec(cmd.text.trim());
   if (stress) {
      const turn = `t${mock.logs.get(sid)!.length}`;
      mock.emit(sid, {
         type: "TurnStarted",
         turn_id: turn,
         text: cmd.text,
         attachments: [],
         context: null,
      });
      turnStarted(mock, sid);
      const steps = stressLiveTurn(8, Number(stress[1] ?? 3));
      const t0 = performance.now();
      let i = 0;
      // One timer per batch of due steps, like Events arriving from the core.
      const tick = () => {
         const now = performance.now() - t0;
         while (i < steps.length && steps[i]!.at <= now) mock.emit(sid, steps[i++]!.kind);
         if (i < steps.length) setTimeout(tick, Math.max(0, steps[i]!.at - now));
         else turnEnded(mock, sid, mock.mainThread(sid), turn);
      };
      setTimeout(tick, 0);
      return { type: "Ok" };
   }
   // Typing "/card" simulates an Agent calling the render_ui Frontend Tool with local images.
   if (cmd.text.trim() === "/card") {
      const n = ++mock.cardN;
      const input = mockRenderUi(["shots/home.png", "shots/settings.png", "shots/dark.png"]);
      const path = `tools/render_ui/mock-card-${n}.json`;
      const m = mock.frontendFiles.get(sid) ?? new Map();
      m.set(path, JSON.stringify(input));
      const files: Record<string, string> = {};
      ["shots/home.png", "shots/settings.png", "shots/dark.png"].forEach((src, i) => {
         files[src] = `files/mock-${n}-${i}.svg`;
         m.set(files[src], mockImage(src, 200 + i * 60));
      });
      mock.frontendFiles.set(sid, m);
      mock.emit(sid, {
         type: "FrontendToolOutput",
         tool: "render_ui",
         call_id: `mock-card-${n}`,
         path,
         input,
         files,
      });
      return { type: "Ok" };
   }
   const turn = `t${mock.logs.get(sid)!.length}`;
   const attachments = (cmd.attachments ?? []).map((a) => storeAttachment(mock, a));
   const first = !mock.logs.get(sid)!.some((e) => e.kind.type === "TurnStarted");
   const context = first ? mockContext(mock, sid) : null;
   mock.emit(sid, {
      type: "TurnStarted",
      turn_id: turn,
      text: cmd.text,
      attachments,
      context,
   });
   turnStarted(mock, sid);
   const words =
      `You said: **${cmd.text}**. This is a mock reply.\n\n- streamed\n- in chunks`.split(/(?<= )/);
   words.forEach((w, i) =>
      setTimeout(() => mock.emit(sid, { type: "AgentMessageChunk", text: w }), 60 * (i + 1)),
   );
   const end = 60 * (words.length + 1);
   setTimeout(() => {
      mock.committed.delete(sid);
      mock.emit(sid, {
         type: "WorkspaceChanged",
         turn_id: turn,
         from_tree: "tree-a",
         to_tree: "tree-b",
         files: MOCK_FILES,
      });
      // Typing "attention" in a prompt leaves the mock Session needing attention.
      turnEnded(mock, sid, mock.mainThread(sid), turn, cmd.text.includes("attention"));
   }, end);
   return { type: "Ok" };
};

/** The first prompt's `<harness_context>`, as the core builds it (`harness_context.rs`), with the mock's Custom Instructions. */
function mockContext(mock: MockTransport, sid: string): string {
   const s = mock.sessions.find((x) => x.id === sid);
   const folder = s?.folder ?? "/mock/project";
   const repo = s?.workspace.repo_root ?? null;
   const parts = [
      "You run inside Harness, a desktop app that hosts coding agents. (mock)",
      "## Frontend: Chat\n\nUse `render_ui` for structured results.",
   ];
   const global = mock.instructions.get("global")?.trim();
   if (global) parts.push(`## Your instructions for all Sessions\n\n${global}`);
   const key = repo ?? folder;
   const own = s?.quick ? undefined : mock.instructions.get(key)?.trim();
   if (own) parts.push(`## Your instructions (${baseName(key)})\n\n${own}`);
   const facts = [`## This Session`, `- Workspace folder: ${folder}`];
   if (repo) facts.push(`- Repository: ${repo}`, "- Worktree: no");
   else facts.push("- Not a git repository");
   if (own) facts.push(`- Instructions folder: ${key}`);
   parts.push(facts.join("\n"));
   return `<harness_context>\n${parts.join("\n\n")}\n</harness_context>`;
}

export const promptHandlers = {
   ReadImageFile: () => {
      throw new CommandError("internal", "no file access in the browser mock");
   },
   ReadAttachment: (mock, cmd) => {
      const a = mock.attachments.get(cmd.path);
      if (!a) throw new CommandError("not_found", "not an attachment of this Session");
      return { type: "Attachment", mime: a.mime, data: a.data };
   },
   Prompt: async (mock, cmd) => {
      const r = await promptMain(mock, cmd);
      // Like the core: once the Turn started, the pending comments it carries are sent (ADR 0027).
      markCommentsSent(mock, cmd.session_id, cmd.comment_ids);
      return r;
   },
   Cancel: () => {
      // The mock does not model cancel: its canned replies run on untracked timers, so a
      // Turn always ends on its own with `end_turn`.
      return { type: "Ok" };
   },
   WarmUp: () => {
      // The core starts the Agent early; the mock has no Agent to start.
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
