# Mediate fs and terminal, but Workspace diff is ground truth for changes

The Harness offers ACP's `fs/*` and `terminal/*` client capabilities so Agents route file edits and processes through it (structured edit records, streamed terminal output, unsaved Frontend content, Workspace confinement). Agents adopt these unevenly and can still change files via terminal commands or built-in tools, so "what changed" is always determined from the Workspace itself (git / file watching), with mediated edits as richer annotations rather than the source of truth.

## Consequences

The M0 spike found that neither claude-agent-acp nor codex-acp calls client `fs/*` or `terminal/*` today; both use their own tools. Mediation is therefore deferred, and the Workspace diff carries "what changed" on its own until Agents adopt the client capabilities.
