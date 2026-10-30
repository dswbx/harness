# Tool call display: reui c-trace-2 / shadcn Trace

`@reui/c-trace-2` is a demo block (mock steps, timers). The real piece is the shadcn `trace` primitive it depends on (`https://ui.shadcn.com/r/styles/base-nova/trace.json`; `new-york-v4` has none, 404).

- `trace.tsx`: ~150 lines of slots (`Trace`, `TraceLine status=running|error|pending`, `TraceIcon`, `TraceTitle`, `TraceDescription`, `TraceCollapsible*`). Pure styling, no logic.
- Deps: Base UI `Collapsible` (we use Radix; swap for `@radix-ui/react-collapsible`, which exposes `--radix-collapsible-content-height` instead of `--collapsible-panel-height`), a `shimmer` Tailwind utility (not in `@harness/ui`), `IconPlaceholder` (replace with lucide).
- c-trace-2 adds `@reui/code-block` (Shiki). Not needed: we have `DiffViewer` and rehype-highlight.
- Pattern worth copying: per-step title by state (running "Editing x" / done "Edited x" / stopped), the live step auto-opens, and `openById[id] ?? isLive` lets a click override that both ways.
- Current tool call display: `packages/frontend-chat/src/ToolCard.tsx` (one card per call), `SubagentCard.tsx`, switched in `View.tsx` `Row`.
