import { type Event, type EventKind, mockImage, mockRenderUi } from "@harness/api";
import codexLog from "../../../packages/frontend-chat/src/fixtures/codex-basic.jsonl?raw";

/** Recorded Codex log plus a synthetic tail (task list, diff, plan approval) so the whole chat UI is exercisable. */
export function mockEvents(): Event[] {
   const recorded = codexLog
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Event);
   let seq = recorded.length;
   const t0 = recorded.at(-1)!.ts_ms;
   const thread = recorded.find((e) => e.thread_id)?.thread_id ?? "main";
   const ev = (kind: EventKind): Event => ({
      v: 1,
      seq: seq++,
      session_id: "mock",
      thread_id: thread,
      ts_ms: t0 + seq * 100,
      kind,
   });
   return [
      ...recorded,
      ev({
         type: "TurnStarted",
         turn_id: "mock-t2",
         text: "Now rename it and plan a refactor (synthetic).",
         context:
            "<harness_context>\nYou run inside Harness, a desktop app that hosts coding agents. (mock)\n\n## Frontend: Chat\n\nUse `render_ui` for structured results.\n\n## This Session\n- Workspace folder: /mock/project\n- Worktree: no\n</harness_context>",
      }),
      ev({
         type: "AgentNotice",
         severity: "info",
         title: "SessionStart says: [example-hook] Context loaded",
         description: null,
      }),
      ev({
         type: "TaskListUpdated",
         entries: [
            { content: "Rename hello.txt", priority: "medium", status: "completed" },
            { content: "Draft refactor plan", priority: "medium", status: "in_progress" },
            { content: "Implement", priority: "medium", status: "pending" },
         ],
      }),
      ev({
         type: "AgentThoughtChunk",
         text: "The rename is one edit. Then look for TODOs and **plan** the refactor.",
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-edit",
         title: "Editing files",
         kind: "edit",
         status: "completed",
         content: [
            {
               type: "diff",
               path: "hello.txt",
               oldText: "hi\nthere",
               newText: "hello\nthere\nworld",
            },
         ],
         locations: [],
         raw_input: { path: "hello.txt" },
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-read",
         title: "Read src/index.ts",
         kind: "read",
         status: "completed",
         content: [
            {
               type: "content",
               content: {
                  type: "text",
                  text: '```\n1\timport { join } from "node:path";\n2\t\n3\t/** The answer. */\n4\texport const x = 1;\n5\texport const at = (p: string) => join("/mock", p);\n```',
               },
            },
         ],
         locations: [{ path: "src/index.ts" }],
         raw_input: { path: "src/index.ts" },
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-search",
         title: "grep -rn TODO src",
         kind: "search",
         status: "failed",
         content: [],
         locations: [],
         raw_input: { pattern: "TODO" },
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-harness",
         title: "mcp__harness__git_status",
         kind: "other",
         status: "completed",
         content: [],
         locations: [],
         raw_input: {},
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-write",
         title: "Write docs/plan.md",
         kind: "edit",
         status: "completed",
         content: [
            {
               type: "diff",
               path: "docs/plan.md",
               oldText: null,
               newText: "# Plan\n\n1. Split module",
            },
         ],
         locations: [],
         raw_input: {},
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-mcp",
         title: "mcp__claude_ai_Linear__get_document",
         kind: null,
         status: "completed",
         content: [],
         locations: [],
         raw_input: { id: "DOC-1" },
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-long",
         title: 'grep -rnilE "sqlite|rusqlite|sqlx|jsonl|localStorage|sessionStorage|indexedDB|persist|store\\.json|tauri-plugin-store|settings\\.json" -- crates app/src packages',
         kind: "execute",
         status: "completed",
         content: [],
         locations: [],
         raw_input: {},
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-task",
         title: "Find Harness data storage",
         kind: "think",
         status: "in_progress",
         content: [],
         locations: [],
         raw_input: { prompt: "Find where the Harness stores Session data." },
      }),
      ...[
         "ls -la && ls crates app packages docs docs/adr 2>/dev/null | head -100",
         'grep -rnE "data_dir|dirs::|directories::|ProjectDirs|BaseDirs|Library/Application Support" crates',
         "Read GLOSSARY.md",
      ].map((title, i) =>
         ev({
            type: "ToolCall",
            tool_call_id: `mock-sub-${i}`,
            title,
            kind: i === 2 ? "read" : "execute",
            status: i === 2 ? "in_progress" : "completed",
            content: [],
            locations: [],
            raw_input: {},
            parent_tool_call_id: "mock-task",
         }),
      ),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-task2",
         title: "Find biggest repo files",
         kind: "think",
         status: "completed",
         content: [],
         locations: [],
         raw_input: {
            prompt: "List the **10 biggest** files and the biggest source files by line count.",
         },
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-task2-0",
         title: "git ls-files -co --exclude-standard -- '*.ts' '*.tsx' '*.rs' | xargs wc -l | sort -rn",
         kind: "execute",
         status: "completed",
         content: [
            {
               type: "content",
               content: {
                  type: "text",
                  text: "```console\n 1290  crates/harness-core/src/acp.rs\n 1057  crates/harness-core/src/api.rs\n 1022  packages/frontend-chat/src/RenderUi.tsx\n  808  crates/harness-core/tests/fake_agent.rs\n  768  packages/api/src/mock.ts\n  661  crates/harness-core/src/session.rs\n  627  app/src/ComposerDialog.tsx\n  575  packages/frontend-chat/src/tools.ts\n  547  crates/harness-core/src/terminal.rs\n  527  packages/frontend-chat/src/reducer.ts\n  520  packages/api/src/generated.ts\n  497  crates/harness-core/src/host.rs\n  479  packages/frontend-chat/src/reducer.test.ts\n  455  packages/frontend-chat/src/View.tsx\n  421  packages/frontend-chat/src/panelLayout.ts\n  411  crates/harness-core/tests/mcp.rs\n  398  app/src/App.tsx\n  380  packages/frontend-chat/src/PromptBox.tsx\n```",
               },
            },
         ],
         locations: [],
         raw_input: { command: "git ls-files | xargs wc -l" },
         parent_tool_call_id: "mock-task2",
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-task2-r",
         title: "SubagentHandback",
         kind: null,
         status: "completed",
         content: [],
         locations: [],
         raw_input: {},
         parent_tool_call_id: "mock-task2",
         report:
            "Biggest files in the repo (tracked plus untracked, not ignored).\n\n**Top 3 by size (KB)**\n\n| # | File | KB |\n|---|---|---|\n| 1 | `spikes/acp-client/runs/codex-plan.out` | 167.8 |\n| 2 | `bun.lock` | 158.9 |\n| 3 | `Cargo.lock` | 153.6 |",
      }),
      ev({
         type: "FrontendToolOutput",
         tool: "render_ui",
         call_id: "mock-card",
         path: "tools/render_ui/mock-card.json",
         input: mockRenderUi(
            [0, 1, 2].map(
               (i) =>
                  `data:image/svg+xml;base64,${btoa(mockImage(`Screenshot ${i + 1}`, 200 + i * 60))}`,
            ),
         ),
      }),
      ev({
         type: "FrontendToolOutput",
         tool: "render_ui",
         call_id: "mock-source",
         path: "tools/render_ui/mock-source.json",
         input: { id: "progress", placement: "right", title: "Progress", source: "progress.md" },
      }),
      ev({
         type: "FrontendToolOutput",
         tool: "render_ui",
         call_id: "mock-source-html",
         path: "tools/render_ui/mock-source-html.json",
         input: { id: "fade", placement: "left", title: "Build", source: "fade.html" },
      }),
      ev({
         type: "AgentMessageChunk",
         text: "Renamed. `Widget::render` now takes a `Mode`, see `src/server/router.ts:4` and `server/router.ts:44`; `fix_something()` runs after it. Related: dswbx/harness#24, supabase/spark#17, [Using Vite](https://tailwindcss.com/docs/installation/using-vite), https://ui.shadcn.com/docs/components/dropdown-menu and `/opt/spark/src/worker.ts:40`.\n\n```rust\npub enum Mode { Full, Quick }\n\nwidget.render(input, opts, Mode::Full).await // a long comment so the line runs past the frame and the wrap button has something to do\nwidget.render(input, opts, Mode::Quick).await\n```\n\nHere is a **plan** next.\n\n```mermaid\nflowchart LR\n  A[Prompt] --> B{Agent} --> C[Tool calls] --> D[Session Log] --> E[Frontend]\n  B --> F[Messages] --> D\n  E --> G[Reducer] --> H[View]\n```\n\n| Area | Status | Files | Notes |\n| --- | --- | --- | --- |\n| Tool call display | spike | `toolDisplay/*.tsx` | Cards and Trace, in **Settings > Appearance** |\n| Mermaid zoom | done | `Mermaid.tsx`, `ZoomView.tsx` | Expand, pan, pinch, +/-/0 keys |\n",
      }),
      ev({
         type: "ToolCall",
         tool_call_id: "mock-run",
         title: "bun test",
         kind: "execute",
         status: "in_progress",
         content: [
            { type: "content", content: { type: "text", text: "✓ reducer.test.ts (42 tests)" } },
         ],
         locations: [],
         raw_input: { command: "bun test" },
      }),
      ...mockGitSteps(ev),
      ev({
         type: "PermissionRequested",
         request_id: "mock-edit",
         tool_call: {
            toolCallId: "mock-edit-perm",
            kind: "edit",
            title: "Edit src/server/router.ts",
            rawInput: {},
         },
         options: [
            { option_id: "allow", name: "Allow", kind: "allow_once" },
            { option_id: "always", name: "Always allow", kind: "allow_always" },
            { option_id: "reject", name: "Reject", kind: "reject_once" },
         ],
      }),
      ...mockPlans(ev, recorded),
   ];
}

const PLAN_V1 =
   "# Split the router module\n\n## Context\n\n`src/server/router.ts` mixes routing, auth and rendering.\n\n## Steps\n\n1. Move auth checks to `src/server/auth.ts`\n2. Move rendering to `src/server/render.ts`\n3. Keep `router.ts` as the route table\n4. Update imports\n5. Run `bun test`\n\n## Verify\n\n- `bun run typecheck`";
const PLAN_V2 =
   "# Split the router module\n\n## Context\n\n`src/server/router.ts` mixes routing, auth and rendering.\n\n## Steps\n\n1. Move auth checks to `src/server/auth.ts`, with a test per check\n2. Move rendering to `src/server/render.ts`\n3. Keep `router.ts` as the route table\n4. Add `Mode` to `Widget::render` callers\n5. Update imports\n6. Run `bun test`\n\n## Verify\n\n- `bun run typecheck`\n- `bun run lint`";

/**
 * Claude-style Plan Mode: plan v1 (5 options), answered "No, keep planning", a prompt with a plan comment,
 * then plan v2 waiting for approval. The mode option becomes Claude's (auto before Plan) for the mode names.
 */
function mockPlans(ev: (kind: EventKind) => Event, recorded: Event[]): Event[] {
   const config = [...recorded].reverse().find((e) => e.kind.type === "ConfigOptionsChanged")?.kind;
   const others =
      config?.type === "ConfigOptionsChanged" && Array.isArray(config.options)
         ? (config.options as { category?: string }[]).filter((o) => o.category !== "mode")
         : [];
   const modes = (current: string) =>
      ev({
         type: "ConfigOptionsChanged",
         options: [
            {
               id: "mode",
               name: "Mode",
               category: "mode",
               type: "select",
               currentValue: current,
               options: [
                  { value: "default", name: "Default", description: "Ask before edits" },
                  { value: "acceptEdits", name: "Accept Edits" },
                  { value: "plan", name: "Plan Mode" },
                  { value: "auto", name: "Auto" },
                  { value: "bypassPermissions", name: "Bypass Permissions" },
               ],
            },
            ...others,
         ],
      });
   const options = [
      {
         option_id: "clear-auto",
         name: "Yes, clear context and use auto mode",
         kind: "allow_always",
         plan_mode: "auto",
         clears_context: true,
      },
      {
         option_id: "auto",
         name: "Yes, and use auto mode",
         kind: "allow_always",
         plan_mode: "auto",
      },
      {
         option_id: "bypass",
         name: "Yes, and bypass permissions",
         kind: "allow_always",
         plan_mode: "bypassPermissions",
      },
      {
         option_id: "default",
         name: "Yes, manually approve edits",
         kind: "allow_once",
         plan_mode: "default",
      },
      { option_id: "plan", name: "No, keep planning", kind: "reject_once" },
   ];
   const request = (id: string, plan: string) =>
      ev({
         type: "PermissionRequested",
         request_id: id,
         tool_call: { toolCallId: `${id}-call`, kind: "switch_mode", title: "Ready to code?" },
         options,
         plan,
      });
   return [
      modes("auto"),
      modes("plan"),
      request("mock-plan-1", PLAN_V1),
      ev({
         type: "PermissionResolved",
         request_id: "mock-plan-1",
         option_id: "plan",
         by: "view",
      }),
      ev({ type: "TurnEnded", turn_id: "mock-t2", stop_reason: "end_turn" }),
      ev({
         type: "TurnStarted",
         turn_id: "mock-t3",
         text: "Comments on the plan (Plan v1):\n\n> Move auth checks to `src/server/auth.ts`\n\nAdd a test for each check.",
      }),
      ev({ type: "AgentMessageChunk", text: "Updated the plan: a test per auth check." }),
      request("mock-plan-2", PLAN_V2),
   ];
}

const HASH = "3f9c2ab81d4e5f60718293a4b5c6d7e8f9012345";
const text = (t: string) => [{ type: "text", text: t }];
const content = (t: string) => [{ type: "content", content: { type: "text", text: t } }];

/** Harness git tool calls as the core logs them: done, failed, then a push waiting for approval. */
function mockGitSteps(ev: (kind: EventKind) => Event): Event[] {
   const call = (id: string, tool: string) =>
      ev({
         type: "ToolCall",
         tool_call_id: id,
         title: `mcp__harness__${tool}`,
         kind: null,
         status: null,
         content: [],
         locations: null,
         raw_input: {},
         harness_tool: tool,
      });
   const update = (
      id: string,
      u: { status?: string; raw_input?: unknown; raw_output?: unknown; text?: string },
   ) =>
      ev({
         type: "ToolCallUpdate",
         tool_call_id: id,
         title: null,
         kind: null,
         status: u.status ?? null,
         content: u.text !== undefined ? content(u.text) : null,
         locations: null,
         raw_input: u.raw_input ?? null,
         raw_output: u.raw_output ?? null,
      });
   const done = (id: string, out: string, raw_input?: unknown) =>
      update(id, {
         status: "completed",
         raw_input,
         raw_output: text(out),
         text: out,
      });
   const status = JSON.stringify(
      { branch: "feat/rename", upstream: null, ahead: 0, behind: 0, files: [{}, {}, {}] },
      null,
      2,
   );
   const patch =
      "diff --git a/src/hello.ts b/src/hello.ts\n--- a/src/hello.ts\n+++ b/src/hello.ts\n@@ -1,3 +1,4 @@\n-const a = 1\n+const a = 2\n+const b = 3\n context\n";
   const failure = "The operation timed out.";
   return [
      call("mock-git-status", "git_status"),
      done("mock-git-status", status),
      call("mock-git-diff", "git_diff"),
      done("mock-git-diff", patch, {}),
      call("mock-git-commit", "git_commit"),
      update("mock-git-commit", {
         raw_input: {
            message:
               "Rename hello.txt to hello.ts\n\nMove the file and update its imports so the build keeps working.",
         },
      }),
      done("mock-git-commit", `Committed ${HASH}`),
      call("mock-git-push-1", "git_push"),
      update("mock-git-push-1", { status: "in_progress" }),
      update("mock-git-push-1", {
         status: "failed",
         raw_output: failure,
         text: `\`\`\`\n${failure}\n\`\`\``,
      }),
      call("mock-git-push-2", "git_push"),
      update("mock-git-push-2", { status: "in_progress" }),
      ev({
         type: "PermissionRequested",
         request_id: "mock-push",
         tool_call: {
            toolCallId: "harness-mock-push",
            kind: "git_push",
            title: "Push branch to origin",
            rawInput: {},
         },
         harness_tool: "git_push",
         options: [
            { option_id: "allow", name: "Allow", kind: "allow_once" },
            { option_id: "always", name: "Always allow", kind: "allow_always" },
            { option_id: "reject", name: "Reject", kind: "reject_once" },
         ],
      }),
   ];
}
