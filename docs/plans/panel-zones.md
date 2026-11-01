# Panel zones plan

**Directories:** `packages/frontend-chat` (main work), `packages/ui` (resize handle), `app/src` (SessionHeader gear, sidebar Settings), `docs/` (ADR, plan, glossary). No Rust changes.

Design: canvas https://claude.ai/artifact/JAxejAJL5WUvggd1R5B3eh (Main = prototype, Zones = rules, BottomModes = under vs between).

## Context

The chat has one right panel showing one view at a time (Side chats, Changes, Terminal, Events, Artifacts, right `render_ui` slots), toggled from buttons the Frontend portals into the host Session header (`View.tsx:296`). More panels are coming. Goal: JetBrains-style zones (left top/bottom, bottom left/right, right top/bottom), one open panel per zone, stripes with icons, resizable, drag and drop between zones. Settled: layout kept per Session ("save as default" later); render_ui Agent picks a side, default right top; empty left stripe hides except while dragging; bottom spans under the sides (between: not v1); gear menu at the right of the Session header holds Reset layout + Settings; panels share the chat background.

## 1. Pure model: `panelLayout.ts` (replaces `panelTabs.ts`)

- `Zone = "leftTop" | "leftBottom" | "bottomLeft" | "bottomRight" | "rightBottom" | "rightTop"`.
- `PanelId = "side" | "changes" | "terminal" | "events" | "artifacts" | \`slot:${string}\``.
- `Layout = { zones: Record<Zone, PanelId[]>; open: Record<Zone, PanelId | null>; sizes: { left, right, bottom, leftSplit, rightSplit, bottomSplit }; expanded: PanelId | null; threads: string[]; thread: string | null }` (Side Thread tabs move over unchanged).
- Ops (pure, tested): `toggle`, `show` (opens in its own zone), `hide`, `move(id, zone, index?)` (open stays open in new zone), `expand`, `resize`, plus `openThread/selectThread/closeThread` ported from `panelTabs.ts`.
- `reconcile(layout, available)`: known panels missing from `zones` go to their default zone, unknown ids dropped; new slots go to `rightTop` (placement `right`) or `leftTop` (placement `left`). Unavailable panels (Changes without git, Artifacts with none) keep their spot but get no icon.
- Defaults (as prototype): leftTop Changes, leftBottom Artifacts, bottomLeft Terminal, bottomRight Events, rightTop Side chats + slots, rightBottom empty.
- `computeRects(layout, w, h)`: rects per open zone + chat, same rules as prototype `layout()` (sides split height, bottom splits width only if both open, bottom spans full width, chat min 360 px, sizes scaled down to fit). Also used for the drop preview.
- Persist: `harness.chat.layout.<sessionId>`; migrate old `harness.chat.panel.<sessionId>` (threads, and its open view opened in its new zone); Terminal never restored open. Drop `harness.chat.rightPanelWidth`.

## 2. Dock layout: `DockLayout.tsx`

- Measures its box (ResizeObserver), positions chat and panels **absolutely** from `computeRects`. Every mounted panel keeps the same parent, so moving a zone never remounts it (Terminal shell, half-typed side chat prompts and Events filters survive). Terminal and opened side chats stay mounted hidden, as today.
- Resize handles on open edges and splits. Generalize `packages/ui/src/components/resizable.tsx`: `ResizeHandle` gets `orientation` (vertical/horizontal) and positions from props; a `useDragDelta` helper replaces width-only logic (App sidebar keeps `useResizableWidth`). Double-click resets that size.
- Expanded panel: same element gets fixed near-full-screen classes + backdrop, Esc collapses (moved out of `EventsPanel.tsx`). Panels declare `expandable` (Events only for now).

## 3. Stripes: `Stripe.tsx`

- Left: leftTop, separator, leftBottom, spacer, bottomLeft. Right: rightTop, separator, rightBottom, spacer, bottomRight. Icons with tooltip, pressed state, the changed-dot from `SlotTab`.
- Drag and drop with pointer events (not HTML5 DnD: avoids Tauri webview drop handling and gives a custom ghost): 4 px threshold, ghost icon follows cursor, targets found with `elementsFromPoint` + `data-drop-zone`/`data-drop-index`. Targets: stripe groups (dashed slot at index), drop pads on the dock edges, blue preview of the target rect. Esc cancels.
- Keyboard shortcuts stay (Ctrl+` Terminal, Cmd/Ctrl+Shift+B side chat) and open the panel in whatever zone it is in.

## 4. Panel chrome: `PanelHeader.tsx`

- Shared header: title, panel-specific controls (children), ⋮ `DropdownMenu` (Expand/Collapse if expandable, Move to ▸ `DropdownMenuSub` with 6 zones checked, separator, Hide), — hide button. Header is a drag handle (same pointer drag).
- Refactor `DiffPanel`, `EventsPanel`, `ArtifactsPanel`, `TerminalPanel`, `SlotPanel`, side chat tab bar to use it instead of their own close X. Panels drop `border-l`; borders come from the dock.

## 5. View + header

- `View.tsx`: replace `panel` state, `right` width and the right column with `DockLayout` + stripes; `actions` loses the panel buttons (Agent status badge stays in the status slot). Slot auto-open (`lastRight` effect) and `jump` use `show(slotId)`.
- Gear menu: host `SessionHeader.tsx` gets a gear `DropdownMenu` at the far right with Settings… (⌘,) and a portal section the Frontend fills (`menuRef`, like `toolbarRef`/`statusRef`), where Chat adds Reset layout. Remove sidebar footer Settings in `App.tsx`. (See question 1.)

## 6. render_ui `left`

- `tools.ts` `PLACEMENTS` adds `left`; description: right = right top, left = left top, user can move them. `instructions.md` one line. `bun run gen-manifests`. ADR 0015 addendum.

## 7. Docs

- ADR 0019 "Panel zones": zones, per-Session layout, absolute dock so panels never remount, pointer DnD, stripes replace header buttons, gear menu.
- `GLOSSARY.md`: Panel, Zone, Stripe.
- `docs/plans/panel-zones.md`: this plan.

## Verification

- `bun run test` (vitest): `panelLayout.test.ts` for move/toggle/reconcile/migration/computeRects (replaces `panelTabs.test.ts`); existing tests green. `bun run typecheck` (includes boundary + manifest check).
- `bun run dev` + browser preview: move each panel by stripe drag, pad drop and Move to; resize all 6 handles; both-bottom split; Terminal keeps its screen after moving zones; side chat draft survives a move; Expand Events + Esc; switch Sessions and restart: layout per Session; render_ui right/left item lands in right top/left top and auto-opens; screenshot proof.

## Unresolved questions

1. Gear menu ownership: host gear in Session header + Frontend portal section for Reset layout? Suggest yes (same pattern as toolbar/status slots).
2. Defaults as prototype (Changes/Artifacts left, Terminal/Events bottom, Side chats right)? Suggest yes.
3. Sizes per Session too, or global? Suggest per Session (with layout), "save as default" later covers it.
4. Pointer DnD instead of HTML5 DnD? Suggest pointer.
