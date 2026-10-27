# Git Primitives shell out to the git CLI

Git Primitives invoke the user's `git` binary rather than libgit2 or gitoxide. This guarantees identical behaviour to the user's terminal (config, hooks, credential helpers, signing) and full worktree support, which the libraries handle incompletely. Cost: parsing CLI output and a runtime dependency on git being installed.
