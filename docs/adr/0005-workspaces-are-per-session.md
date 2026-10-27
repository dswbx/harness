# Workspaces are defined per Session, not created up front

Unlike tools such as Conductor, where a workspace must exist before sessions can be created from it, each Session defines its own Workspace in the Composer (which folders, whether to create a Worktree, from which starting point). Setups vary every time, so a prerequisite workspace entity adds friction without value; reuse comes from optional Workspace Templates. A Worktree belongs to exactly one Session, which makes cleanup unambiguous; a plain folder may be shared by several Sessions and the Harness cannot prevent that.
