import type { EventKind, PromptOrigin, SubSessionReport } from "./generated";

/**
 * Scripted logs for the mock "Release prep across repos" Session and its two Sub Sessions, so every
 * sub session step (start, send, wait, check, list, failed) and every report the Harness sends the
 * parent (reply, no reply, batched, cancelled, error, waits for permission) shows in the browser mock.
 */

const PARENT = { id: "mock-p1", title: "Release prep across repos" };
const A = { id: "mock-p1-a", title: "Bump jsonv-ts schema exports" };
const B = { id: "mock-p1-b", title: "Check supalite RLS cases" };

const fromParent: PromptOrigin = { session_id: PARENT.id, title: PARENT.title, kind: "parent" };
type Sub = { id: string; title: string };

/** A child's Turn ended. */
const ended = (
   s: Sub,
   stop_reason: string,
   asked: string,
   duration_ms: number,
   reply?: string,
): SubSessionReport => ({
   session_id: s.id,
   title: s.title,
   kind: "ended",
   stop_reason,
   duration_ms,
   asked,
   reply: reply ?? null,
});
/** A child waits for the user. */
const waits = (s: Sub, asked: string): SubSessionReport => ({
   session_id: s.id,
   title: s.title,
   kind: "needs_user",
   asked,
});

/** The prompt `sub_sessions.rs` sends the parent, and its origin: text for the Agent, reports for Frontends. */
const news = (...reports: SubSessionReport[]): [string, PromptOrigin] => [
   reports
      .map((r) => {
         const who = `Sub Session "${r.title}" (session_id ${r.session_id})`;
         if (r.kind === "needs_user")
            return `${who} waits for the user to answer a permission request there. It goes on once the user answers.`;
         const head = `${who} ended its Turn (${r.stop_reason})`;
         return r.reply ? `${head}. Its last reply:\n\n${r.reply}` : `${head} without a reply.`;
      })
      .join("\n\n---\n\n"),
   {
      session_id: reports[0]!.session_id,
      title: reports.map((r) => r.title).join(", "),
      kind: "sub_session",
      reports,
   },
];

let turnN = 0;
const turn = (text: string, origin: PromptOrigin | null, body: EventKind[], stop = "end_turn") => {
   const turn_id = `mock-sub-t${++turnN}`;
   return [
      { type: "TurnStarted", turn_id, text, attachments: [], context: null, origin },
      ...body,
      { type: "TurnEnded", turn_id, stop_reason: stop },
   ] as EventKind[];
};
const say = (text: string): EventKind => ({ type: "AgentMessageChunk", text });

let toolN = 0;
const tool = (name: string, input: unknown, out: unknown, failed = false): EventKind[] => {
   const id = `mock-sub-tool-${++toolN}`;
   const body = typeof out === "string" ? out : JSON.stringify(out, null, 2);
   return [
      {
         type: "ToolCall",
         tool_call_id: id,
         title: `mcp__harness__${name}`,
         kind: null,
         status: "in_progress",
         content: [],
         locations: null,
         raw_input: input,
         harness_tool: name,
      },
      {
         type: "ToolCallUpdate",
         tool_call_id: id,
         title: null,
         kind: null,
         status: failed ? "failed" : "completed",
         content: [{ type: "content", content: { type: "text", text: body } }],
         locations: null,
         raw_input: null,
         raw_output: [{ type: "text", text: body }],
      },
   ] as EventKind[];
};

const start: EventKind[] = [
   { type: "ThreadStarted", agent_id: "codex", main: true },
   { type: "AgentProcessState", state: "ready", message: null },
];

const A_TASK = "Export the schema helpers from `jsonv-ts` so Harness can import them. Open a PR.";
const A_BUMP = "Also bump the version in package.json to 0.9.0.";
const PING = 'Ping: are you still there? Reply with just "here". No other actions.';
const B_TASK = "Check the RLS test cases in supalite still pass against the new policies.";
const B_GO = "Go on with the storage policies.";
const B_PARTIAL =
   "Ran 14 of 22 RLS cases, all passing so far. Stopped before the storage policies.";

const LONG_REPLY = [
   "Done. Exports and docs are in, nothing else touched.",
   "",
   "- `src/index.ts`: exports `s`, `Static` and `parse`",
   "- README: new install section, fixed the `parse()` example",
   "- docs/schema.md: documented `strict` mode",
   "- Added a changeset (`minor`)",
   "",
   "Opened **#145**. Tests pass.",
].join("\n");

export function mockSubSessionLogs(): Record<string, EventKind[]> {
   turnN = 0;
   toolN = 0;
   const aWorktree = {
      session_id: A.id,
      title: A.title,
      folder: "/Users/me/jsonv-ts/.harness/worktrees/bump-exports",
      repo: "/Users/me/jsonv-ts",
      branch: "bump-exports",
   };
   const bWorktree = {
      session_id: B.id,
      title: B.title,
      folder: "/Users/me/supalite/.harness/worktrees/rls-cases",
      repo: "/Users/me/supalite",
      branch: "rls-cases",
   };
   const parent: EventKind[] = [
      ...start,
      ...turn(
         "Prep the release: bump the jsonv-ts schema exports and check the supalite RLS cases, each in a sub session. Also run the harness-web e2e.",
         null,
         [
            ...tool(
               "session_start",
               {
                  prompt: A_TASK,
                  folder: "/Users/me/jsonv-ts",
                  title: A.title,
               },
               { ...aWorktree, model: "opus", effort: "high" },
            ),
            ...tool(
               "session_start",
               {
                  prompt: B_TASK,
                  folder: "/Users/me/supalite",
                  title: B.title,
               },
               { ...bWorktree, model: "sonnet", effort: "medium" },
            ),
            ...tool(
               "session_start",
               {
                  prompt: "Run the e2e suite.",
                  folder: "/Users/me/harness-web",
                  title: "Run e2e on harness-web",
               },
               "Error: folder /Users/me/harness-web does not exist",
               true,
            ),
            say(
               "Started two sub sessions: jsonv-ts exports and supalite RLS. harness-web isn't on this machine, so I skipped the e2e run.",
            ),
         ],
      ),
      // A report with a long reply.
      ...turn(...news(ended(A, "end_turn", A_TASK, 154_000, LONG_REPLY)), [
         say("jsonv-ts is done: exports, docs and a changeset, PR #145 is open."),
      ]),
      // The child waits for the user.
      ...turn(...news(waits(B, B_TASK)), [
         say("supalite wants to run `supabase db reset`. Approve it there and it goes on."),
      ]),
      ...turn(
         "ask jsonv-ts to also bump the version in package.json, then wait for it. check on supalite too",
         null,
         [
            ...tool(
               "session_send",
               { id: A.id, text: A_BUMP },
               { session_id: A.id, title: A.title },
            ),
            ...tool(
               "session_wait",
               { id: A.id },
               {
                  session_id: A.id,
                  title: A.title,
                  status: "idle",
                  stop_reason: "end_turn",
                  duration_ms: 41_000,
                  reply: "Bumped to 0.9.0 and pushed to #145.",
               },
            ),
            ...tool(
               "session_wait",
               { id: B.id, timeout_s: 0 },
               { session_id: B.id, title: B.title, status: "needs_attention", reply: "" },
            ),
            ...tool(
               "session_list",
               {},
               {
                  sub_sessions: [
                     { ...aWorktree, status: "idle", archived: false },
                     { ...bWorktree, status: "needs_attention", archived: false },
                  ],
               },
            ),
            say("jsonv-ts is at 0.9.0 on #145. supalite still waits for your approval."),
         ],
      ),
      // Two reports batched into one prompt: no reply, and cancelled with a reply.
      ...turn(
         ...news(
            ended(A, "end_turn", A_BUMP, 41_000),
            ended(B, "cancelled", B_TASK, 512_000, B_PARTIAL),
         ),
         [say("jsonv-ts ended quietly. supalite was stopped after 14 of 22 cases, all passing.")],
      ),
      ...turn("ask the subsession if it's still there, just a ping", null, [
         ...tool(
            "session_send",
            {
               id: A.id,
               text: PING,
            },
            { session_id: A.id, title: A.title },
         ),
         say("Pinged the sub session. The harness should notify me when it replies."),
      ]),
      // A short reply.
      ...turn(...news(ended(A, "end_turn", PING, 8_000, "here")), [
         say('The sub session answered the ping with "here", so it\'s still there.'),
      ]),
      ...turn("resume supalite and wait", null, [
         ...tool("session_send", { id: B.id, text: B_GO }, { session_id: B.id, title: B.title }),
         ...tool(
            "session_wait",
            { id: B.id, timeout_s: 1800 },
            "Error: timed out after 1800 s waiting for the sub session",
            true,
         ),
         say("The wait timed out. I'll get a message when supalite ends its Turn."),
      ]),
      // A report with an error stop.
      ...turn(...news(ended(B, "error", B_GO, 95_000)), [
         say("supalite stopped with an error and no reply. Open it to see what happened."),
      ]),
   ];

   const a: EventKind[] = [
      ...start,
      ...turn(A_TASK, fromParent, [say(LONG_REPLY)]),
      ...turn(A_BUMP, fromParent, [say("Bumped to 0.9.0 and pushed to #145.")]),
      ...turn(PING, fromParent, [say("here")]),
   ];

   const b: EventKind[] = [
      ...start,
      ...turn(B_TASK, fromParent, [say(B_PARTIAL)], "cancelled"),
      ...turn(B_GO, fromParent, [], "error"),
   ];

   return { [PARENT.id]: parent, [A.id]: a, [B.id]: b };
}
