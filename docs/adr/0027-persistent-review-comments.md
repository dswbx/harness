# Review Comments are persisted in the Session Log

Line comments on diff and file lines lived only in the Frontend's `localStorage` and vanished when the prompt was sent. The user could not see what was still open, and an Agent could neither read them later nor leave its own (a review Agent placing inline comments).

**Decision:** a **Review Comment** is a core primitive projected from the Session Log (ADR 0021, additive; like `attached` for Shared Artifacts in ADR 0024, no scan). `LineComment { id, path, line, side, code, text, by }`: `path` is Workspace-relative, `line` 1-based, `side` `old`/`new` for a diff comment and none for a file comment, `code` the commented line's text, `by` the user or the Agent. Events (Session-scoped, no Thread): `CommentAdded`, `CommentEdited`, `CommentDeleted`, `CommentsSent { ids }`, `CommentResolved { id, by, note }`.

**Lifecycle.** The user's comment starts **pending**: a draft in the prompt box that can be edited or deleted. `Prompt { comment_ids }` marks the pending ones among them **sent** (shown as open) once the Turn started; from then on it is immutable (no edit, no delete) and stays on its line until **resolved**, by the user or the Agent. An Agent's comment starts open, never pending. No reopen, no replies: the user makes a new comment instead. Resolving a pending comment is a conflict; resolving a resolved one does nothing.

**Ids** are `c1`, `c2`, ... (the number of `CommentAdded` so far, plus one), never reused, even after a delete. They appear in the prompt text (`src/a.ts:12 (new) [c3]`), so the Agent can resolve what it addressed.

**Commands:** `AddComment`, `EditComment`, `DeleteComment`, `ResolveComment` (all as the user). **Harness MCP:** `comment_list` (read; never drafts), `comment_add` (state; the core reads the line's code from the working tree, or from `HEAD` for `old`), `comment_resolve` (state).

**Quotes stay in the Frontend.** Quote comments (selected chat, plan or artifact text) remain Frontend-only drafts: they point at no file line and are sent as text.

**Line drift** is the Frontend's job: the log keeps `code` as it was when commented, and the Frontend compares it with the current line to show a moved or outdated comment. The core never rewrites a comment's line.
