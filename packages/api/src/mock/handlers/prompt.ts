import { applyStatePatch } from "../../derive/state";
import { CommandError } from "../../errors";
import type { Attachment, AttachmentInput, CommandResult, SessionSummary } from "../../generated";
import { MOCK_FILES } from "../fixtures/git";
import { mockImage, mockRenderUi } from "../fixtures/renderUi";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

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
   setTimeout(
      () => mock.emit(sid, { type: "TurnEnded", turn_id: turn, stop_reason: "end_turn" }, thread),
      60 * (words.length + 1),
   );
   return { type: "Ok" };
}

export function setStatus(mock: MockTransport, id: string, status: SessionSummary["status"]) {
   const s = mock.session(id);
   s.status = status;
   s.updated_ms = Date.now();
   mock.emitApp({
      type: "SessionStatus",
      session_id: id,
      title: s.title,
      status,
      unused: s.unused,
   });
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
      const sid = cmd.session_id;
      const used = mock.session(sid);
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
            "The Agent could not reopen its earlier session.",
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
      // Typing "/auth" simulates an Agent that needs sign-in.
      if (cmd.text.trim() === "/auth") {
         mock.emit(sid, {
            type: "AuthRequired",
            message: "The Agent needs you to sign in first.",
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
      setStatus(mock, sid, "working");
      const attachments = (cmd.attachments ?? []).map((a) => storeAttachment(mock, a));
      const first = !mock.logs.get(sid)!.some((e) => e.kind.type === "TurnStarted");
      const context = first
         ? "<harness_context>\nYou run inside Harness, a desktop app that hosts coding agents. (mock)\n\n## Frontend: Chat\n\nUse `render_ui` for structured results.\n\n## This Session\n- Workspace folder: /mock/project\n- Worktree: no\n</harness_context>"
         : null;
      mock.emit(sid, {
         type: "TurnStarted",
         turn_id: turn,
         text: cmd.text,
         attachments,
         context,
      });
      const words =
         `You said: **${cmd.text}**. This is a mock reply.\n\n- streamed\n- in chunks`.split(
            /(?<= )/,
         );
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
         mock.emit(sid, { type: "TurnEnded", turn_id: turn, stop_reason: "end_turn" });
         mock.emitApp({
            type: "TurnFinished",
            session_id: sid,
            thread_id: mock.mainThread(sid),
            title: mock.session(sid).title,
            stop_reason: "end_turn",
         });
         // Typing "attention" in a prompt leaves the mock Session needing attention.
         setStatus(mock, sid, cmd.text.includes("attention") ? "needs_attention" : "idle");
      }, end);
      return { type: "Ok" };
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
