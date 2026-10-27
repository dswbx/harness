# Harness

A desktop host for ACP-compliant agents. It provides the shared building blocks (agent communication, sessions, git, tools) that purpose-built frontends assemble into different working environments.

## Language

### Actors

**Harness**:
The system being built here: the shared core plus the app that hosts its frontends.
_Avoid_: host, shell, app (when meaning the core)

**Agent**:
An external program that speaks ACP and does the actual AI work, e.g. Claude Code, Codex, Gemini CLI.
_Avoid_: agent harness, harness (for the external program), backend

**ACP Registry**:
The public catalog of ACP Agents with install recipes, from which the Harness offers and installs Agents.
_Avoid_: marketplace, agent store

**Custom Agent**:
An Agent the user adds by hand rather than from the ACP Registry.
_Avoid_: local agent, manual agent

### Sessions and frontends

**Session**:
One working environment the user manages, bound to exactly one Frontend for its whole life and made of one Main Thread plus any Side Threads.
_Avoid_: chat, conversation, workspace

**Turn**:
One user prompt in a Thread plus all the Agent's work in response, until the Agent stops.
_Avoid_: prompt turn (in prose), exchange, round

**Task List**:
The Agent's live list of steps and their statuses for the work it is currently doing in a Thread; owned and updated by the Agent.
_Avoid_: plan, todo list, tasks

**Plan**:
A proposal the Agent drafts for the user to review before it acts.
_Avoid_: task list, spec

**Plan Mode**:
An Agent mode in which it drafts a Plan instead of acting.
_Avoid_: planning mode, read-only mode

**Archived Session**:
A Session set aside by the user: its work is preserved and it can be restored, but its Worktrees no longer occupy disk.
_Avoid_: closed session, inactive session

**Thread**:
One line of conversation inside a Session, backed by one Agent Session at a time and with its own Agent.
_Avoid_: branch, subagent, chat

**Main Thread**:
The Session's primary Thread; every Session has exactly one.
_Avoid_: main chat, root thread

**Side Thread**:
A secondary Thread in a Session (e.g. sidechat, btw window, comment thread) that never feeds the Main Thread's Agent context unless the user explicitly says so.
_Avoid_: subthread, branch, sidechat (as the general term)

**Context Seed**:
What a Thread starts with from elsewhere in the Session: nothing, a summary of the Main Thread, or a selected excerpt.
_Avoid_: initial context, prefill

**Agent Session**:
The Agent's own ACP session backing a Thread; a Thread may span several Agent Sessions over time (e.g. after the Agent lost its context or was switched), each start after the first being an explicit, visible boundary in the Session Log.
_Avoid_: ACP session (in prose), backend session

**Frontend**:
A kind of purpose-built working environment (e.g. chat, gen UI chat, canvas) chosen when a Session is created and fixed thereafter; it may keep its own Session-specific state.
_Avoid_: UI, client, mode

**Frontend Manifest**:
A Frontend's self-description to the Harness: its identity, the Frontend Tools it declares, and what it needs from the Harness.
_Avoid_: plugin manifest, config

**View**:
One live rendering of a Session by its Frontend, such as a window or pane; a Session may have several Views at once, all of the same Frontend.
_Avoid_: window, tab, subscriber

**Session Directory**:
Storage the Harness owns for one Session, separate from its Workspace, holding that Session's state including whatever its Frontend Tools produced.
_Avoid_: session folder, data dir, workspace

**Session Log**:
The Harness's own append-only record of everything that happened in a Session; the source of truth Views render from, independent of the Agent's memory.
_Avoid_: transcript, history, chat log

### Workspaces

**Workspace**:
The set of folders one Session's Agents work in, defined for that Session alone when it is created and fixed thereafter; one folder is primary.
_Avoid_: project, working directory, repo

**Workspace Folder**:
One folder in a Workspace: either an existing folder used as is (which other Sessions may also use) or a Worktree.
_Avoid_: root, mount, directory

**Worktree**:
A git checkout the Harness creates from a chosen starting point (e.g. a branch) for exactly one Session, and which belongs to that Session alone.
_Avoid_: checkout, clone, sandbox

**Workspace Template**:
A saved Workspace setup from which new Sessions can be composed; a convenience, never a prerequisite for creating a Session.
_Avoid_: project, workspace (for the saved setup)

**Composer**:
The place where the user sets up a new Session (Workspace, Agent, Frontend) before work starts, outside any Frontend.
_Avoid_: launcher, new-session dialog, wizard

### Capabilities

**Primitive**:
A shared capability the Harness owns (e.g. git status, create worktree), offered both to the Agent as a tool and to Frontends as an action, with one behaviour behind both.
_Avoid_: command, action, API (alone)

**Frontend Tool**:
A tool a Frontend declares for its Sessions; when the Agent calls it, the Harness records the call's output in the Session Directory and the Frontend interprets it whenever a View renders (e.g. `json_render`).
_Avoid_: custom tool, plugin tool

**Harness MCP**:
The MCP server the Harness itself provides to every Agent Session, carrying the Primitives and the Session's Frontend Tools.
_Avoid_: core MCP, internal tools

**MCP Library**:
The MCP servers a user configures once in the Harness, from which each Session is given a selection for all its Agents.
_Avoid_: MCP config, integrations

### Permissions

**Permission Policy**:
The Harness's rules deciding whether an Agent's request to act is allowed, denied, or put to the user; it applies the same way in every Frontend.
_Avoid_: permission settings, rules (alone)

**Permission Checker**:
An automated judge the Harness may consult for requests the Permission Policy would otherwise put to the user, for Agents without their own automatic mode.
_Avoid_: auto mode (that is the Agent's own feature), classifier
