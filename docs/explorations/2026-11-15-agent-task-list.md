# Agent task list (ACP `plan`) never showed

2026-11-15. claude-agent-acp 0.107.0 (bundled `claude` binary, claude-sonnet-5-5), codex-acp 2.6.0 (codex 0.166.0).

**Observed:**
- Harness already handles it end to end: ACP `sessionUpdate: "plan"` becomes `TaskListUpdated` (`acp/normalize.rs`), `plansSlice` sets `taskList`, and `TaskListPanel` shows it above the messages. No local Session Log (`~/.harness`, `~/.harness-dev`) had a `TaskListUpdated` event.
- Claude, asked to use `TaskCreate`: `ToolSearch select:TaskCreate,TaskUpdate` returned "No matching deferred tools found". In the `claude` binary, `TaskCreate` and `TodoWrite` are enabled only if an `EX()` check passes: true for an interactive/background CLI session, a host opt-in, an older or unknown model (3.x, 4.x up to `claude-sonnet-4-6`), or `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. `CLAUDE_CODE_ENABLE_TASKS=false` switches from Task* back to `TodoWrite`.
- claude-agent-acp turns `TodoWrite` and Task* calls into `plan` (and hides them as tool calls).
- codex-acp turns Codex's `update_plan` (`turn/plan/updated`) into `plan` with `entries`. Asked for `TaskCreate` (Claude's tool name), Codex drew a static task list with `render_ui` instead.
- Codex has `update_plan` only with `tools.update_plan.enabled=true` (`codex exec` without it: no such tool; with it: a `todo_list` item). codex-acp passes the `CODEX_CONFIG` env (JSON) into each thread's config; the smoke example with `{"tools.update_plan.enabled":true}` logged `TaskListUpdated` going in_progress to completed.
- Session titles: codex-acp names a Session from the first prompt's text blocks joined (fallback title from the preview, then a title model on the first 4000 chars, run in the Session folder with AGENTS.md loaded). With `<harness_context>` first, the title was `<harness_context> You run inside…`, then made up from the user's AGENTS.md ("Supalite Linear CLI setup"). The context now goes after the user's text and Agent titles are cut at `<harness_context>`.
- codex-acp also has the unstable `plan_update` (markdown Plan Mode plan with `planId`), only when the client advertises the `plan` capability. Harness does not.

**Assumed / unverified:**
- `agent_quirks::extra_env()` sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (task list seen live in the app) and `CODEX_CONFIG` (seen in the smoke example only). A user's own `CODEX_CONFIG` on a Custom Agent replaces ours.
- Does the context after the user's text change how well Agents follow it?

**Open questions:**
- Does the nudge make Agents keep a list for small tasks too (noise)?
- `TaskListPanel` keeps a finished list and is replaced per update; should it follow Turns?
