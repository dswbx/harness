# render_ui: Graph and Lanes (deferred)

Date: 2026-11-02. No code tested. Source: the design canvas for multi-repo orchestration UIs, https://claude.ai/artifact/EWjkX9vLjMY4ZemN4WBpes. Decision context: ADR 0013, addendum 2026-11-02 (generic primitives instead of use-case components).

We deferred two components. The generic primitives (Stack layout props, Text, Repeat, rich Table cells, List status) cover the first cases. Add these only when a real Session needs them.

## Graph

Nodes and edges with automatic layout, e.g. a dependency chain, a pipeline, a service map.

**Assumed / unverified:**

- Library idea: React Flow (`@xyflow/react`) to render, `@dagrejs/dagre` for the layout; `elkjs` only if dagre is not good enough, loaded lazily (it is large).
- Not Mermaid: Mermaid draws a static SVG. Clicks cannot write to the Session State, and nodes cannot hold our own components (badges, icons, tones).
- Props idea: `nodes[{id, title, subtitle?, tone?, icon?, dashed?}]`, `edges[{from, to, label?, tone?, dashed?}]`, `direction` (LR, TB), `selected` (`$bindState`, the picked node id).
- A short chain (A → B → C with labels) already works without Graph: a horizontal Stack with `fill: false`, compact Cards and Text arrows.

## Lanes

Rows over time: each row has items with `start`, `end`, `label`, `tone`, and links between items. Uses: deploy history per environment, incidents, release plans.

**Assumed / unverified:**

- No library: a CSS grid with one row per lane and absolutely positioned items (percent of the time range), like Trace.
- Trace already draws spans on one time axis; Lanes would add several rows with several items each, and links.

## Open questions

- Is Graph worth its bundle size (React Flow + dagre) for the cases Agents produce?
- Can Lanes be a Trace variant instead of a new component?
- Which Session first needs either one?
