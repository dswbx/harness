# Side Threads: isolated, with transcript read tools

Date: 2026-10-29. Design idea only; nothing built or tested. Related: [2026-10-29-acp-fork-and-caching.md](2026-10-29-acp-fork-and-caching.md).

Use case: select text in the chat, ask a question about it in a Side Thread, without the question entering the Main Thread's context.

## Idea

- A Side Thread starts as a fresh Agent Session (isolated, `StartSideThread{seed}` exists in core).
- It gets read-only tools on the Harness MCP to read Session transcripts on demand, like files.
- The same tools, with a policy, could let any Thread read other Sessions.
- ACP `session/fork` stays an optional later path (full context, for Agents that support it). One Side Thread design with two ways to start keeps the Frontend the same.

## Why it fits (from code and ADRs, not tested)

- Works with every Agent: no `session/fork` support or warm prompt cache needed.
- Harness MCP runs in core over loopback HTTP; its bearer token identifies Session and Thread (ADR 0011), so core can scope-check each read.
- The Session Log lives in Rust (ADR 0003); a transcript tool is a Shared Primitive (ADR 0002).
- `summary.rs` already renders a Thread as a plain transcript; the tools can reuse that rendering.

## Sketch

- **Seed:** the selected text, its location (Turn, event `seq`), the Turn around it, and a hint: "The Main Thread transcript is available through the harness tools."
- **Tools** (MCP tools, not MCP resources, since Agent support for resources varies):
  - `transcript_outline`: Turns with short user prompt, tool titles, size.
  - `transcript_read`: a range of Turns; option to include tool input and output.
  - `transcript_search`: text search, returns Turn numbers.
  - `sessions_list`: readable Sessions (only when cross-session reading is allowed).

## Policy

Two separate scopes:

1. **Own Session** (all Threads of the same Session): on by default. This is the core Side Thread case.
2. **Other Sessions:** off by default, configurable.

Levels for other Sessions:

| Level | Readable Sessions |
|---|---|
| `off` (default) | none |
| `same_folder` | same project folder |
| `same_agent` | made with the same Agent (provider boundary) |
| `all` | every Session |

`same_folder` and `same_agent` could combine.

"Same credentials" is not used: Harness does not see Agent credentials (each Agent handles its own login). The real boundary is the provider (Anthropic content should not reach OpenAI and the reverse), which `same_agent` covers. If an account boundary is needed later, a user-set label per Agent (e.g. "work", "personal") could work; Harness trusts the label and does not detect the account.

Other settings:

- **Private flag per Session:** never readable from other Sessions, whatever the level.
- **Ask or allow:** with ask, each read shows a permission request. Could reuse the Permission Policy (e.g. rules with tool kind `session_read`).
- **Archived Sessions:** included or not.
- **Read-only always:** no tool changes another Session.

Example: level `same_agent`, mode ask. A Claude Side Thread asks to read a Claude Session in another project: permission card. Codex Sessions and private Sessions are not visible.

## Risks (assumed)

- The Agent may not call the tools and guess from the seed. Mitigation: a clear hint and the surrounding Turn in the seed.
- Prompt injection: transcripts hold tool output from the web, files, etc. Mark read results as data; other Sessions are untrusted content.
- Privacy: other Sessions can hold secrets or other projects; hence off by default and the private flag.
- Cost and speed: each read is a tool round trip and new input tokens. Probably cheaper than a fork that misses the cache, but slower per read.

## Prior art (2026-10-31, from third-party blogs, not official docs)

- **Claude Code `/btw`:** sees the full current conversation (fork-like), answer is not added to history, works while the main turn is still running, no tool use, one question per command.
- **Codex `/side` (alias `/btw`, app has "Open Side Chat"):** in-memory fork that inherits the conversation as read-only reference, file edits blocked, closing returns to parent. Separate `/fork` makes a persistent branch with a new thread id.
- Both fork rather than start fresh. Neither writes back to the main thread.

## Open questions

- Where do the policy settings live: global settings, Permission Policy rules, or both?
- Does `same_agent` mean the same Agent id, or the same provider (e.g. two Claude-based Agents)?
- Include tool output in `transcript_read` by default, or only on request?
- Do Agents actually call the tools reliably with only a seed hint? Test with Claude and Codex.
- UI: how a Side Thread shows next to the Main Thread (panel, popover, separate window).
