# Harness MCP approval in Agent auto modes

Date: 2026-11-04. Versions: Harness main @ 2026-11-04, claude-agent-acp and codex-acp as installed.

## Observed

- Mode ids seen in local Session Logs (ACP config option with `category: "mode"`, and `ModeChanged` events per Thread). Claude: `default`, `acceptEdits`, `plan`, `auto` ("Claude handles permission decisions"), `bypassPermissions`. Codex: `read-only`, `workspace-write`, `agent` ("Auto review"), `agent-full-access`.
- Two policies stack. The Agent's own mode decides whether its built-in tools (bash, edits) ask. The Harness Permission Policy (`permissions.rs`) decides Harness MCP tools. `git_commit` is allowed by default, `git_push` falls to Ask.
- Result before the fix: in an Agent mode that approves everything, `git push` in bash runs unasked, but the Harness `git_push` tool showed an approval card.

## Change

- `agent_quirks::auto_mode` lists the modes where the Agent decides itself: `auto`, `bypassPermissions`, `agent`, `agent-full-access`.
- `acp::authorize` skips a default Ask (no explicit rule, not `switch_mode`) when the Thread's current mode is such a mode. Explicit user rules still win. Plan approvals are untouched.

## Assumed / unverified

- Mode ids only come from the logs of the Agent versions installed here. Other Agents or later versions may name modes differently, and unknown modes are treated as asking.
- Claude `auto` and Codex `agent` may still gate risky shell commands with their own classifier or review. Treating them as "Agent decides without asking" is an approximation.
- The current mode is derived from the latest `ModeChanged` or mode `ConfigOptionsChanged` of the Thread. Not checked for Threads resumed after an Agent restart.

## Open questions

- Would Claude `auto` mode's classifier have flagged `git push` (or asked) if run through bash?
- Should `agent` (Codex "Auto review") count as auto, given a reviewer may block some actions?
- Should the Policy be able to express "ask even in auto modes" for users who want push gated everywhere? Today an explicit Ask rule does that.
