# Spike: ACP client in Rust (M0.1)

Code: `spikes/acp-client/` (standalone crate; `run.sh` scrubs inherited `CLAUDE*`/`ANTHROPIC*` env; raw outputs in `runs/`; `summarize.py`/`kinds.py` helpers). Run: `cargo build && ./run.sh --agent codex|claude [--cwd D] [--prompt P] [--set id=val] [--mode id] [--load|--resume ID] [--list] [--close] [--no-prompt]`.

**Status**: Codex fully verified live. Claude: initialize/new/list/load/resume/close/set_mode verified live; **prompts blocked by 401** (see Gotchas), so Claude tool/plan behavior is from adapter source, marked (src).

## 1. Crate API
- `agent-client-protocol = "3.5.0"` (features: `process` for `AcpAgent`; `stdio` only for agent side). Types in `agent_client_protocol::schema::v1::*` (separate crate `agent-client-protocol-schema 1.12.0`). Also `unstable_protocol_v2` / v2 builder exists; ignore, v1 is what adapters speak.
- **Send, multi-thread runtime fine. No LocalSet.** `ConnectTo: Send + 'static`; handler closures bound `AsyncFnMut + Send`; `ConnectionTo`/`Responder` are Send. Plain `#[tokio::main]`. Runtime-agnostic (async-io/async-process internally for `AcpAgent`; works under tokio).
- Handlers run inside the dispatch loop and **block further inbound processing** until they return. Long ops (terminal/wait_for_exit) must `cx.spawn(...)` and respond from the task (`Responder` moves into it). Verified working.
- `AcpAgent::from_str("npx -y pkg")` (shell-words split) or `AcpAgentConfig::new(cmd).args().env()`. Builtins `AcpAgent::claude_agent()` / `codex()` exist (npx `@latest`). Spawns child in own process group, kills tree on drop. **No cwd option** on spawn (inherits ours; session cwd goes in `session/new`). `.with_debug(|line, LineDirection|)` taps stdin/stdout/stderr lines (used to forward agent stderr).
- Skeleton (works):
```rust
Client.builder().name("x")
  .on_receive_notification(async move |n: SessionNotification, _cx| { /* n.update */ Ok(()) },
        agent_client_protocol::on_receive_notification!())
  .on_receive_request(async move |req: RequestPermissionRequest, responder, _cx| {
        responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(opt_id)))) },
        agent_client_protocol::on_receive_request!())
  // ... one on_receive_request per ReadTextFile/WriteTextFile/CreateTerminal/TerminalOutput/WaitForTerminalExit/Kill/Release
  .connect_with(AcpAgent::from_str(cmd)?, |c: ConnectionTo<Agent>| async move {
        let init = c.send_request(InitializeRequest::new(ProtocolVersion::V1)
            .client_capabilities(ClientCapabilities::new()
               .fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true)).terminal(true))
            .client_info(Implementation::new("n","0"))).block_task().await?;
        let s = c.send_request(NewSessionRequest::new(cwd)).block_task().await?;   // .session_id, .modes, .config_options
        c.send_request(PromptRequest::new(s.session_id, vec![ContentBlock::Text(TextContent::new(p))])).block_task().await?;
        Ok(()) }).await?;
```
- Other typed requests used OK: `ListSessionsRequest`, `LoadSessionRequest::new(id, cwd)`, `ResumeSessionRequest::new(id, cwd)`, `CloseSessionRequest`, `SetSessionModeRequest`, `SetSessionConfigOptionRequest::new(sid, cfg_id, "value")`. Cancel = `CancelNotification` via `send_notification`.
- Handler order: multiple `on_receive_request` stack; unhandled methods get method-not-found. Updates serialize to JSON with `sessionUpdate` discriminator (`serde_json::to_value(&n.update)`), handy for the JSONL log.
- Response conventions: errors via `responder.respond_with_error(agent_client_protocol::util::internal_error(msg))`.

## 2. InitializeResponse (protocolVersion 1 both)
| | Claude `claude-agent-acp` 0.96.0 | Codex `codex-acp` 2.2.2 |
|---|---|---|
| loadSession | true | true |
| sessionCapabilities | list, delete, additionalDirectories, resume, close (all `{}`) | same set |
| mcpCapabilities | http **true**, sse true | http **true**, sse false |
| promptCapabilities | image, embeddedContext (audio false) | same |
| auth caps | `logout: {}` | `logout: {}` |
| authMethods | `[]` (relies on local Claude login) | `api-key` (provider openai), `chat-gpt` |
| _meta | `claudeCode.promptQueueing`, `steering.supported` | `steering.supported` |
- `session/list` works on both, is **global across all cwds** (shows user's real sessions; paginated, Codex returns `nextCursor`; Claude returned all 15). Entries: sessionId, cwd, title, updatedAt. Filter by cwd client-side (or pass cwd param).

## 3. Client fs / terminal usage
- **Codex: never called fs/* or terminal/*** (0 calls) even though advertised. Uses its own exec: `tool_call` kind=`execute`/`read`/`edit`, with `content:[{type:terminal,terminalId}]` and output streamed in `tool_call_update._meta.terminal_output_delta {data, terminal_id}` and `_meta.terminal_exit`. Edits are `content:[{type:diff,path,newText}]`, applied by Codex itself. So the "terminal" content type references an agent-owned terminal id, not one we created.
- **Claude: no calls observed (prompt blocked)**; (src) adapter has a client `readTextFile/writeTextFile` wrapper but no call sites; Claude Code uses its builtin Read/Write/Bash. Expect none. Confirm once auth fixed.
- Conclusion: Harness need not implement fs/terminal for these two; advertising them is harmless. Implement lazily for other agents.
- Codex put the file in our `cwd` (temp git project): `hello.txt` created, `ls` result reported.

## 4. session/update kinds, config, commands
- Codex observed: `available_commands_update`, `session_info_update` (title + `_meta.codex.threadStatus` active/idle), `agent_thought_chunk` (reasoning summaries), `agent_message_chunk` (token-ish tiny chunks, 399 for one plan), `tool_call`, `tool_call_update`, `usage_update {used,size}`, `config_option_update`. No `plan` entries update in my runs. `prompt.response` has `_meta.quota` token counts + per-model usage.
- Claude observed (no prompt): `available_commands_update` (sent twice; includes user skills as commands), `config_option_update`, `agent_message_chunk` (error text). (src) also `plan` (TodoWrite -> entries), tool_call*, usage.
- Config options (`configOptions`, each `id/category/type=select/currentValue/options`; also legacy `modes`):
  - Claude: `mode` (default, acceptEdits, plan, auto, bypassPermissions), `model` (default,opus,fable,sonnet,haiku, full ids...), `effort` (default,low..max; category thought_level), `fast` (on/off), `agent` (persona list). `session/set_config_option` returns the full new configOptions list; `set_mode` returns `{}` and emits `config_option_update`.
  - Codex: `mode` (read-only, workspace-write, agent[default, "Auto review"], agent-full-access), `collaboration_mode` (default, plan), `model` (gpt-6.1-sol default, ... gpt-5.6-luna cheap), `reasoning_effort` (low..ultra), `fast-mode`. Used `model=gpt-5.6-luna reasoning_effort=low`.
  - Note: Codex plan mode is a **separate option** (`collaboration_mode=plan`), not a `mode`; Claude's is `mode=plan`. UI must key on `category`, not id.
- Commands: Codex builtins `plan, mcp, skills, status, review, review-branch, review-commit, compact, goal, rename, logout` + ~100 `$skill` entries (names include `$` and `:`). Claude: user skills as plain names.
- Both: config set responses arrive before/around updates; `available_commands_update` can arrive before `session/new` response is processed by us (ordering is async, notification can precede response).

## 5. Plan Mode
- **Codex (verified)**: `collaboration_mode=plan`, prompt "plan how to add a README". Agent explores (read-only exec tool calls), plan text streams as **`agent_message_chunk`** (no special update kind). On finish the agent sends **`session/request_permission`**: toolCall `{toolCallId:"plan-review:<id>-plan", kind:"switch_mode", title:"Implement this plan?", rawInput:{plan:"<markdown>"}}`, options `implement_plan` (allow_once) / `revise_plan` (reject_once, "tell Codex what to do differently"). On allow: `tool_call_update` completed, `config_option_update` (mode back to `agent`, collaboration_mode default presumably) and **implementation proceeds in the same prompt turn** (my auto-allow wrote README.md). On reject the turn ends; revise via next prompt. Plan markdown is in `rawInput.plan`, not in `content`.
- **Claude (src, unverified live)**: `mode=plan` (set_mode verified; emits `config_option_update currentValue=plan`). Model calls ExitPlanMode -> `request_permission`, title "Ready to code?", toolCall `kind:"switch_mode"`, plan markdown in rawInput.plan; options: "Yes, clear context and use auto/bypass/accept-edits mode" (allow_always), "Yes, and use auto mode", "Yes, and bypass permissions", "Yes, manually approve edits" (allow_once), "No, keep planning" (reject). Entering: EnterPlanMode permission "Yes, enter plan mode"/"No, start implementing now". Selection switches mode and may clear context. Our first-allow auto-pick would pick "clear context + auto" = destructive-ish; **Harness must render plan permission specially, never auto-pick**.
- Common shape: `ToolCall.kind == switch_mode` + `rawInput.plan` => Plan approval. Good Frontend hook.

## 6. load / resume / close
- Both `session/load`: **replays history as session/update**, coalesced per message (not per-token): Codex: `user_message_chunk`(1), `agent_thought_chunk`, `agent_message_chunk`(whole), `tool_call` (already `completed`, with content), `tool_call_update` (incl. terminal_output_delta), `session_info_update`, `available_commands_update`; no `usage_update`. Claude (verified on an old session): `user_message_chunk` + `agent_message_chunk`. Replay completes **before** the load response returns. cwd must be provided; session found regardless of cwd (Codex list shows all).
- `session/resume`: no replay, returns state (modes/configOptions). Both OK. `session/close`: `{}` both OK (verified Codex+Claude). Fresh process required each time; session survived across processes (on-disk).
- Replay messageIds are stable (Codex `msg_...`/`rs_...`), usable for dedupe.
- Implication: Harness can rebuild from own JSONL log and use `resume` (cheap) for continuing; `load` only as fallback/import.

## 7. Gotchas
- **Claude auth 401 in this environment**: `Failed to authenticate. API Error: 401 OAuth access token is invalid.` surfaced as an `agent_message_chunk` and prompt returned `Error: Authentication required`-ish (our process printed it as an error); the prompt response was not an error stop reason. `claude -p` itself fails the same way: Keychain `Claude Code-credentials` entry is stale (mdat 2026-06-20); the Claude desktop app authenticates via its own host refresh (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`), not available to a child. Env inherited from the desktop app also redirects (`ANTHROPIC_BASE_URL`); scrub it (`run.sh`). Fix: user runs `claude /login` in a terminal (or `ANTHROPIC_API_KEY`). Harness must (a) detect auth failures that arrive as plain message text, not JSON-RPC errors, (b) when GUI-launched, consider env hygiene for nested Claude Code.
- Startup: `npx` first spawn ~18s (download), later ~3s for Claude session/new (`sdk-initialize` 3s), Codex new ~1s. Pin versions in production instead of `@latest`.
- Agent stderr is chatty (`[session/create] phase=... durationMs`); capture and keep out of the protocol log.
- `session/list` is global and slow-growing; paginate, filter by cwd.
- `agent_message_chunk` for Codex is token-level (400 events/plan); reducer must coalesce by `messageId`.
- Codex `tool_call` titles for exec are the full shell command; `Editing files` for diffs.
- Notifications can arrive before the response that logically precedes them (e.g. `available_commands_update` before `session/new` response is handled); do not assume strict order.
- Process exit: dropping the connection kills the process group; no explicit shutdown needed.
- Codex Auto-review mode (`agent`) did not ask permission for in-cwd write/ls (0 permission requests besides plan); to exercise permission requests use `mode=read-only`.
