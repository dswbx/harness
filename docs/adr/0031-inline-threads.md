# Inline Threads are Side Threads anchored to quoted text

The user wants to ask about one passage of an agent message and keep the answer next to that passage. A Side Thread (ADR 0018) already does the isolated question. It lacks the link to the text. Design: [plan](../plans/inline-threads.md).

**An Inline Thread is a Side Thread with an Anchor.** It is anchored to quoted text in a finished Main Thread agent message and shows in a popover beside that text. It is not a new kind of Thread. All Side Thread rules from ADR 0018 hold: same Session, never feeds the Main Thread's context, tabs in the Side chats Panel.

**The Anchor is a text quote.** `ThreadStarted` gets an optional `anchor: TextAnchor { thread_id, seq, quote, prefix, suffix }`, and `StartSideThread` carries it. `prefix` and `suffix` are up to 32 characters of rendered text on each side of the quote (a W3C TextQuoteSelector). The Frontend finds the text again by the quote, and uses prefix and suffix to pick the right match when the quote repeats. Old logs have no anchor and load as before (ADR 0021). `SessionMeta` does not change: the Session Log is the source of truth and Views fold it.

**Message identity is the first chunk's `seq`.** `seq` is the `seq` of the first `AgentMessageChunk` of the message. It equals the Frontend item id `e{seq}`. The log is immutable, so it never changes, and no new id field is needed.

**Only finished messages can be anchored.** Core refuses the anchor unless: it points to the Main Thread, the Event at `seq` is a Main `AgentMessageChunk` without a parent tool call, and a later Main `TurnEnded` exists. So the fork point always covers the anchored message. A source of `Fresh` with an anchor is refused.

**Always a fork.** There is no "Nothing" choice. The Inline Thread starts as a fork of the Main Thread with full context, and falls back to a seed when the Agent cannot fork (ADR 0018). It uses the same model and config as the Main Thread. Its mode is its own and starts in the asking mode, as for any Side Thread. A user who wants no context or another model uses a normal Side Thread. The first prompt starts with the quote, in the same format as a quote chip.

**Composer.** The popover composer reuses the Side Thread prompt box footer (attach, mode picker, send or stop) without the context ring. No new footer type.

**Drafts.** The text and the Anchor of an unsent question are kept as a draft, one per Anchor.
- An outside click does not close a popover that has text. Only an explicit close (Close button or Esc) closes it, because the popover can cover text the user wants to read.
- An explicit close keeps the draft and its text. The highlight shows in a draft color: gray (muted text color) with a dashed underline and a light gray tint. A click on the highlight or its marker reopens the composer.
- With no text, any close removes the draft.
- "Discard draft" removes the draft, its text and its highlight.
- Send turns the draft into an Inline Thread, and the highlight turns blue (sky tint, solid underline). Inline Threads use no amber or orange: in this app amber means a warning.
- A draft whose Anchor is not found stays in the Inline tab, marked "not found in chat", with a Discard button.

**Resolve.** New Event `SideThreadResolved { resolved }` on the Side Thread, and Command `ResolveSideThread`. Resolving hides the highlight. The thread stays in the Session Log and can be reopened with `resolved: false`. It works for any Side Thread. The Main Thread cannot be resolved.

**The Main Thread does not know about Inline Threads.** Anchors do not appear in the transcript tools. Nothing flows back unless the user sends it (ADR 0018).

**Unread state is frontend-only.** The Frontend stores the last seen `TurnEnded` time per thread. It is not in the Session Log.

**Overlaps stack.** When anchors overlap, one popover lists the threads, newest first, with a switcher in the header. Threads that start on the same line share one marker.

**Considered.** DOM offsets as the Anchor: they break when rendering changes (Markdown upgrade, inline code settings), while a quote with prefix and suffix survives. A new message id field: not needed, since the first chunk's `seq` is already stable and unique. A "Nothing" start for Inline Threads: the point is a question about this text in this conversation, and a normal Side Thread already covers the no-context case. Fuzzy matching of lost quotes: not now. An exact match with prefix and suffix scoring is predictable, and a lost Anchor is listed as "not found".

**Risks.** Rendered text can change, so an old Anchor may not be found. The thread is still in the Inline tab and can open as a normal Side Thread tab. Highlights use `CSS.highlights`; text-decoration support inside `::highlight` differs between engines. The fallback is a tint only.
