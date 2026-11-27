# Inline Threads plan

Status: proposed. Design: ADR 0030 (to write), built on [ADR 0018](../adr/0018-side-threads-fork-with-transcript-tools.md). Mockups: Design canvas "Inline Side Threads" (https://claude.ai/artifact/HSydYFBizJW9jkxgSGRAm1).

**Directories:** `crates/harness-core` (api, session, host, tests), `packages/api` (client, derive, mock, platform), `packages/ui`, `packages/frontend-chat` (features/review, features/sideChats, new features/inlineThreads, features/conversation, features/prompt, lib, state), `app/src`, `docs/`.

## Context

Side Threads exist. `StartSideThread { seed, source: ThreadStart, mode }` is at `command.rs:484`. `Session::start_side_thread` (`session/mod.rs:525`) logs `ThreadStarted { forked_from }` (`event.rs:36`). It forks when the Main Thread has an Agent Session. If not, it seeds. Core has no Excerpt type, because it was dropped after review. A quote reaches a Side Thread as a quote chip: a `QuoteComment` that `withReviewComments` turns into prompt text (`state/reviewCommentText.ts:125`).

The chat sends a selection to the prompt box in `SelectionComment.tsx:80-249`. "Add comment" uses that path, and "Ask in side thread" calls `side.ask` (`sideChats/panel.tsx:221`). It is mounted at `shell/View.tsx:305`. Agent rows carry `quotableAttrs(threadId, side)` (`conversation/Row.tsx:75`) but no item id. A merged agent message has the item id `e${seq}`, where `seq` is the seq of its first `AgentMessageChunk` (`state/slices/timeline.ts:124`, `appendText` at 35-64).

The Main list is a `VirtualList` (`MessageList.tsx:107`). Rows unmount when they scroll out, and the list handle has only `scrollToKey` (`ui/composites/virtual-list.tsx:34`). `::highlight(quote-comment)` is at `ui/styles.css:374`. `PromptBox` with a `threadId` shows `ConfigBar modeOnly`, and it always shows `ContextRing` (`PromptBox.tsx:363-384`). `stepThreads` (`api/derive/threads.ts:32`) builds `ThreadInfo`. Web storage goes through `storedValue` and `STORAGE_KEYS` (`api/platform/storageKeys.ts`).

## Rules (agreed in design)

- An Inline Thread is a Side Thread anchored to quoted text in a finished Main Thread agent message. It shows in a popover beside the text.
- It is always a fork with full context. No "Nothing" option is offered. It falls back to a seed when the Agent cannot fork (ADR 0018).
- It uses the same model and config as Main. Its mode is its own, and it starts in the asking mode.
- Composer footer = the Side Thread prompt box footer (attach, mode picker, send/stop), without the context ring. No new footer type.
- A user who wants no context or a different model uses a normal Side Thread.
- The Main Thread does not know about Inline Threads.

## 1. Core: anchor and resolve (additive, ADR 0021)

- `api/event.rs`: `TextAnchor { thread_id: ThreadId, seq: u64, quote: String, prefix: String, suffix: String }`.
  - `seq` is the first `AgentMessageChunk` of the message. It is the message identity: it equals the Frontend item id `e{seq}`, it never changes because the log is immutable, and it needs no new id field.
  - `prefix` and `suffix`: up to 32 characters of rendered text on each side (a W3C-style TextQuoteSelector).
- `ThreadStarted` gets `#[serde(default, skip_serializing_if = "Option::is_none")] anchor: Option<TextAnchor>`.
- `StartSideThread` gets `#[serde(default)] anchor: Option<TextAnchor>`.
- `SessionMeta` does not change. The log is the only source of truth, and Views fold it.
- New Event `SideThreadResolved { resolved: bool }`, on the Side Thread's `thread_id`. `resolved: false` reopens.
- New Command `ResolveSideThread { session_id, thread_id, resolved }`. It refuses the Main Thread and unknown Threads. It does nothing when the state does not change. It works for any Side Thread.
- `start_side_thread` validates the anchor. It refuses the request unless:
  - `source != Fresh`;
  - the anchor's `thread_id` is the Main Thread;
  - the Event at `seq` is a Main `AgentMessageChunk` with `parent_tool_call_id: None`;
  - a Main `TurnEnded` with a higher `seq` exists (the message is finished).

  With these checks, the fork point always covers the anchored message.
- Model, config and `side_mode` need no change.
- No change to `harness_context` or the transcript tools.
- `host/mod.rs:425`: pass `anchor` through, and route `ResolveSideThread`. Then run `bun run gen-ts`.
- Golden log: new `tests/golden/inline-threads.jsonl` (made-up data) with `ThreadStarted.anchor` and both `SideThreadResolved` states. Add the variant names to `tests/golden.rs`.
- Tests (`tests/fake_agent.rs`; `start_side_in` takes an anchor):
  - the anchor is logged, and the fork is used (`Boundary::Forked`);
  - with no fork support, the seed fallback runs and the anchor is still logged;
  - refused: unfinished message, wrong Event kind at `seq`, subagent chunk, `Fresh` with an anchor;
  - resolve and reopen log Events, a repeated resolve does nothing, and resolving Main is refused;
  - the Main Thread log is not changed.
- Unit test: an old `ThreadStarted` line loads with `anchor: None`.

## 2. `@harness/api`

- `client/session.ts` and `session/core.ts`: `startSideThread({ …, anchor })` and `resolveSideThread(threadId, resolved)`.
- `derive/threads.ts`: `ThreadInfo` gets `anchor: TextAnchor | null` and `resolved: boolean`. `stepThreads` handles `SideThreadResolved`. This is pure derivation that a second Frontend would also need (ADR 0012). Update `threads.test.ts`.
- Mock:
  - `handlers/threads.ts` copies `anchor` onto `ThreadStarted`;
  - a new `ResolveSideThread` handler emits `SideThreadResolved`;
  - add both to `mock/commands.test.ts:132` and `mock.test.ts`;
  - add one fixture Session with an anchored Inline Thread that has a reply, for the preview.
- `platform/storageKeys.ts`: `session("harness.chat.inlineSeen.{session}", "frontend-chat/inlineThreads")` and `session("harness.chat.inlineDrafts.{session}", "frontend-chat/inlineThreads")`.

## 3. Chat state and anchor resolution

- `state/reducer.ts` ROUTES: `SideThreadResolved: NONE`. `trackThreadList` already runs for every Event. Update the reducer golden snapshot for the new golden file (`state/__snapshots__`).
- New `lib/textQuote.ts` (DOM only, no React, no `features/` imports):
  - `textIndex(root)`: walks text nodes with a `TreeWalker` and returns `{ text, nodes[], starts[] }`;
  - `describeRange(root, range)`: returns `{ quote, prefix, suffix }` from offsets in that text. It does not use `sel.toString()`, so capture and lookup use the same text;
  - `findQuote(root, anchor)`: returns a `Range` or null. It checks each occurrence of `quote`, scores the `prefix`/`suffix` match (whitespace normalized), takes the best one, and maps the offsets back to nodes.
  - Tests (dom project): unique quote; repeated quote where prefix/suffix picks the right one; quote across inline markup (`code`, `strong`); not found returns null; whitespace changes.
- `Row.tsx`: the Main agent row adds `data-item-id={item.id}`. It also adds `data-anchorable` when `!streaming && !active`. Messages of the running Turn are not anchorable, which matches the core rule. `SelectionComment` reads both attributes into `Spot` (`itemId`, `anchorable`).

## 4. Chat Frontend: `features/inlineThreads/`

- **Model**: in `sideChats/panel.tsx` `useModel`, which already owns `start`, focus and unread. It exposes `inline: InlineModel`:
  - `threads`: `threadList` entries with an `anchor`, plus `state.threads[id]`;
  - `drafts: Record<draftId, { itemId, anchor }>` (`storedValue`, versioned), so a draft survives a closed popover and a restart. The draft text is already saved per composer by `useDraft` (`prompt/drafts.ts`); only the anchor is new. Several drafts can exist at once, one per anchor;
  - `composing: draftId | null`: the draft whose popover is open;
  - `openIds: string[] | null`, `reveal: { id, n }`, and `seen` (`storedValue` `Record<threadId, turnEndedAt>`, versioned);
  - actions: `begin(spot)`, `send(text, files, item, mode)`, `open(ids)`, `close()`, `resolve(id, b)`, `showInChat(id)`.
  - `send` calls `api.startSideThread({ source: "fork", mode, anchor })`. Then it prompts with `withReviewComments(text, [{ kind: "quote", quote, text: "" }])`, so the quote leads the first prompt in the same format as a quote chip. The popover does not show a chip for it. It reuses `deliverPending`, as `start` does.
  - Unread: `turnEndedAt > (seen[id] ?? mountedAt)`. Opening the popover writes `seen`.
- **Anchors context** `InlineAnchors` (`{ byItem: Map<itemId, Thread[]>, register, unregister }`), provided in `View.tsx` around `MessageList` (like `PlanContext`).
- **Highlights**: `useAnchorRanges(itemId, ref)` runs in the agent row.
  - In a layout effect, and after each Markdown commit or `ResizeObserver` change, it finds each anchor with `findQuote` and adds the `Range` to one shared `Highlight` per class: `inline-thread` (blue: sky tint and solid underline), `inline-thread-active` (popover open: stronger tint), `inline-thread-draft` (not sent yet: gray muted text color, dashed underline, light gray tint). No amber or orange: in this app amber means a warning.
  - It removes the ranges on unmount, so virtualized rows leave and return cleanly.
  - `CSS.highlights` entries are registered once per module. Styles go in `ui/styles.css` next to `quote-comment`. Pending uses a dashed underline plus a light tint. WebKit support for `text-decoration` in `::highlight` must be checked; the fallback is tint only.
  - Resolved threads are not registered. An anchor that is not found marks the thread `notFound` for the panel.
- **Hit test**: one `click` listener on the list root. When the selection is collapsed, find the mounted ranges whose `getClientRects()` contain the click point, and open them.
- **Overlaps**: the popover takes `ids[]`. Threads are stacked newest first, with a `‹ 1/2 ›` switcher in the header.
- **Marker** `InlineMarker`: placed absolutely in the row's right gutter (`px-10`), at the first rect of the first range. It shows the count, pulses (`animate-pulse`) while a thread has a running Turn, and shows a dot when unread. A click opens its `ids`. Threads that start on the same line share one marker.
- **Popover** `InlinePopover` (one instance in `View.tsx`):
  - Radix `Popover` with `PopoverAnchor virtualRef={{ current: { getBoundingClientRect: () => range.getBoundingClientRect(), contextElement: rowEl } }}`, `hideWhenDetached`, `side="bottom" align="start"`;
  - root `ScrollArea` with `max-h-[var(--radix-popover-content-available-height)]` and `viewportClassName="max-h-[inherit]"`;
  - header: Resolve/Reopen, "Open in side chats" (`reopen(id)`), "Send last reply to main", More (Copy reply), Close;
  - "Send last reply to main": move `sendReplyToMain(sessionId, text, note)` out of `SideReplyFooter.tsx:30` and use it in both places;
  - messages: new `InlineMessages` renders `chatRowsOf(thread.items)` through `Row` in a plain list (threads are short, so no `VirtualList`). Messages look like the chat and the Quick overlay chat: user messages as the same `UserMessage` bubble (via `Row`), pending ones as `PendingRow`, agent text, thoughts and tools as the same rows. No extra header line or avatar. The Anchor's quote chip is removed from the first prompt, because the highlight shows it;
  - `Row` gets `footer={false}`, so `SideReplyFooter` and `MessageFooter` hide in the popover;
  - replies stream through the normal reducer.
- **Composer**: `PromptBox` gets one new prop, `contextRing?: boolean` (default true). The popover passes false.
  - Before send: `threadId = composing` (a draftId) (`draft:<uuid>`, so draft keys and cleanup follow `isDraftThread`). It uses a draft `ChatState` built like `SideDraft` (mode set to `sideMode`), `onSend` calls `inline.send`, and `onConfigChange` stays local.
  - After send: `threadId = id`, `state = state.threads[id]`.
- **Entry**: `SelectionComment` gets a third button, "Ask inline ⌘I". It shows only when `spot.anchorable` is true and the selection is not in a Side Thread.
  - ⌘I is handled in a capture `keydown`. It fires only while the selection box shows and focus is not in an editor, so italic in `PromptEditor` still works.
  - `begin` stores `describeRange(row, spot.range)` as a new draft, closes the box, and opens the popover on the draft range.
- **Closing a draft**:
  - Empty text: Esc, Close or an outside click removes the draft and its highlight.
  - With text: an outside click does NOT close the popover (Radix `onInteractOutside` → `preventDefault`). Only an explicit close (Close button or Esc) closes it. The draft and its text stay, and the highlight shows the draft color. Use case: the popover covers text the user wants to read.
  - A click on a draft highlight, or its marker (pencil icon, "Draft"), reopens the composer with the saved text.
  - "Discard draft" (in the popover's More menu, or by clearing the text and closing) removes the draft, its text and its highlight.
  - Send turns the draft into an Inline Thread: the draft entry and its saved text are removed, and the highlight turns blue.
  - A draft whose anchor is not found stays in the Inline tab with "Draft · not found in chat" and a Discard button.
- The Inline tab (section 5) also lists drafts at the top, so they are easy to find.

## 5. Side chats panel: Inline tab

- `SidePanel.tsx`: a fixed first pill "Inline · N" (N = unresolved count). It cannot be closed, and it is hidden when no anchored threads exist. Its active id is the reserved `inline` in `threadTabs`. Older builds ignore an unknown id, because `activeThreadId` falls back. A test covers this.
- `InlineList`:
  - each row shows the quote, a short part of the last reply (last agent item of `state.threads[id]`), the state (running, unread, resolved), and "Show in chat";
  - "Show in chat" calls `inline.showInChat(id)`. `View.tsx` handles `reveal` with `list.scrollToKey(itemKey)`, then opens the popover when the row has registered its range;
  - not found: the row shows the quote and "Not found in chat", with no button;
  - resolved rows are in a collapsed `Collapsible` group.
- Inline Threads are not listed in the regular tabs' "past" menu. "Open in side chats" opens one as a normal tab (`ThreadView`).

## 6. Docs

- ADR `docs/adr/0030-inline-threads.md`. It records:
  - the anchor is a TextQuoteSelector on `ThreadStarted`;
  - message identity is the first chunk's `seq`;
  - only finished messages can be anchored;
  - always a fork, with the same model, and the mode is its own;
  - `SideThreadResolved`;
  - the Main Thread does not know about Inline Threads;
  - unread state is frontend-only;
  - the overlap rule (stacked);
  - considered: DOM offsets (they break when rendering changes); a new message id field (not needed).
- `GLOSSARY.md`: **Inline Thread**: a Side Thread anchored to quoted text in a finished Main Thread agent message, shown in a popover beside that text. Resolving it hides its highlight, and it stays in the Session Log. _Avoid_: comment thread, annotation, inline comment. Also add **Anchor**: the quote, its prefix and suffix, and the message's `seq`.
- `docs/explorations/`: a note on WebKit `::highlight` text-decoration support, after it is checked.

## 7. Verify

- `cargo test -p harness-core`, `bun run check:generated`, `bun run typecheck`, `bun run lint`, `bun run dead-code`, `bun run test`. Boundaries: `inlineThreads` imports only `features/*`, `lib/`, `state/` and `@harness/*`.
- Frontend tests:
  - `lib/textQuote.test.ts`;
  - `derive/threads.test.ts` (anchor, resolve, reopen);
  - reducer golden snapshot;
  - `inlineThreads/model.test.tsx`: `send` makes the fork call with the quoted first prompt; unread from `seen`; old, missing and broken stored values load;
  - `app/src/storageFormats.hook.test.tsx`: pins the `inlineSeen` and `inlineDrafts` stored formats;
  - `inlineThreads/drafts.test.tsx`: outside click with text keeps the popover open; Close keeps the draft and its text; reopen restores the text; empty close and Discard remove it; send removes the draft;
  - `sideChats/panel.test.tsx`: Inline tab hidden and shown, resolved group collapsed, not found.
- Preview (`app-alt-port`, fixture Session):
  - select text, press ⌘I, send: the highlight turns blue and the reply streams in the popover;
  - scroll away and back: the highlight returns;
  - click the highlight and the marker; check overlapping threads;
  - resolve, then reopen;
  - Inline tab and "Show in chat";
  - no console errors.
- Real app with Claude and Codex: the fork is used, and the Main Agent never sees the question.

## Order

Each phase can land and be tested alone.

1. Core and api types, Command, Event, golden log, gen-ts, fake-agent tests.
2. `@harness/api` client, derive, mock, fixture.
3. `lib/textQuote` and tests, Row attributes, reducer route.
4. Chat: selection action, pending popover and composer, start flow, highlights, hit test, marker, popover for started threads.
5. Side chats Inline tab, unread `storedValue`, "Show in chat".
6. ADR 0030, Glossary, preview check.

## Unresolved questions

1. Rendered text can change with settings (`guessInlineCode`) or a Markdown upgrade. Fuzzy match? Suggest: no. Use exact match with prefix/suffix scoring, and list "not found".
2. If `e{seq}` is missing (messages merged differently), search the whole Turn? Suggest: yes, as a fallback.
3. Show anchors in transcript tools (`threads_list`)? Suggest: no. Main does not know.
4. Draft highlight color: blue dashed, or gray dashed? Decided: gray dashed, so a draft differs from a sent thread (blue).
5. "Ask inline" in the Quick Overlay? Suggest: no. It has no side chats panel.
6. Can the Agent resolve threads (MCP)? Suggest: not now. User only.
7. Agent without fork support: seed fallback or hide "Ask inline"? Suggest: seed fallback, same as Side Threads.
