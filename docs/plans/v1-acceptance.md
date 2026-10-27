# v1 acceptance checklist

Run on a clean machine or user account: no system Node, no prior `~/Library/Application Support/dev.dswbx.harness`. Use the released `.dmg` where possible, otherwise `bun run dev`. Tick each line and note anything odd.

## Install and Agents

- [ ] The app opens from the DMG (signed, or right-click → Open when unsigned) and shows an empty sidebar.
- [ ] **Agents** → the registry list loads, entries without a build for this Mac are greyed out, and search works.
- [ ] Install **Claude** and **Codex**. Both finish in under 2 minutes with no system Node, and Node appears in `toolchain/`.
- [ ] Install **OpenCode** (binary distribution).
- [ ] **Update** shows when the registry has a newer version; **Remove** removes the Agent.
- [ ] A Custom Agent (command, args, env) can be added and used.
- [ ] Signing in: when an Agent needs a login, the chat shows the sign-in card, and the agent or terminal method works.

## Sessions and chat

- [ ] **New Session** on a plain folder with Claude: messages stream, thoughts and tool calls render, and the Task List updates.
- [ ] Model, mode and thought-level selects work for Claude and Codex, and survive a new Turn.
- [ ] `/` shows the Agent's commands, prefix matches first.
- [ ] Cancel stops a running Turn.
- [ ] Plan Mode (Claude `plan`, Codex collaboration mode `plan`) shows the Plan card, and approving continues.
- [ ] **Open in new window**: both windows stay in sync, and a late window renders identically.

## Permissions

- [ ] With no rules, edits and shell commands ask and reads don't. The Session shows needs-attention in the sidebar, as a dock badge, and as a notification when the app is in the background.
- [ ] A global rule (execute, `ls`, allow) answers automatically with an "Auto-allowed by rule" note.
- [ ] A Session rule overrides a global one.
- [ ] "Always allow" remembers for the Session and appears in **Permission rules**.

## Continuity

- [ ] Quit and reopen the app, then send a message: "Agent session resumed", and the Agent remembers the context.
- [ ] `pkill -f claude-agent-acp` during a Turn shows an error notice, and the next message recovers.
- [ ] After 15 minutes with no window open on a Session, its Agent stops ("stopped while idle") and restarts on the next message.

## Workspaces and git

- [ ] The Composer lists branches for a repo, the Worktree switch turns on for a non-current branch, and a non-repo shows "Not a git repository".
- [ ] A Worktree Session works on `harness/<slug>-<id>` without touching the original checkout.
- [ ] "Changed N files" appears after a Turn that edits files, and the diff panel shows it per Turn and in total.
- [ ] Commit and Push from the diff panel work; push over SSH works when launched from Finder.
- [ ] Archive a dirty Worktree Session: a WIP commit is made and the Worktree is removed. Unarchive restores it. Delete refuses unmerged work and "Delete anyway" works.

## Harness MCP and Frontend Tools

- [ ] Ask Claude and Codex to "use the harness git_status tool": the tool card shows "Harness · git_status" with no double permission prompt.
- [ ] Ask for a `json_render` card: it renders in chat, and invalid input is rejected back to the Agent.
- [ ] An agent-initiated `git_push` asks first.
- [ ] MCP Library: add a stdio server with a secret env var, select it in the Composer, and the Agent can use it. The secret is not in `mcp.json`.

## Robustness

- [ ] A long Session (a few thousand events, e.g. a long Codex task) scrolls smoothly, and reopening it is quick.
- [ ] A broken Custom Agent command shows a readable error with the Agent's stderr.
- [ ] When launched from Finder (not a terminal), Agents and git find their tools (login-shell PATH).
