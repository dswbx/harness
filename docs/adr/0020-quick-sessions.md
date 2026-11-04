# Quick Sessions

Some work needs no specific folder: a question, a small script, a conversion. Until now every Session needed a folder from the user, and the only way to start one was the Composer.

**Decision:** a Quick Session is a Session with a folder the Harness makes, `<data_dir>/quick/<id>/`. The sidebar's Quick group starts one with one click, and the Composer offers "No folder".

**Why a folder at all:** an ACP Agent needs a working folder to start (`NewSessionRequest` takes it as a required value). So "no folder" means "a folder the Harness picks". `SessionSummary.folder` stays a real path, so the terminal, Reveal in Finder and Open in editor need no change.

**Why one folder per Session:** Sessions cannot overwrite each other's files, and the folder can go with its Session. It is deleted with the Session, kept on archive, and only deleted if its name is the Session id, so bad metadata can never delete another folder.

**Why a separate command:** `CreateQuickSession`, not an optional `folder` on `CreateSession`. Branch, worktree and PR have no meaning without a folder; a separate command makes those combinations impossible. `quick` is stored and not read from the path, so a later setting can change the location.

**Why the core removes unused Quick Sessions:** one click creates a Session, so a click with no message would leave an empty row. Frontends call `DiscardEmptySession` when the user leaves one, and the core decides: no prompt yet on any Thread and nothing in the folder. A Frontend's Session list can be out of date, and an out-of-date check there could delete a used Session. The core also removes them at startup, for an app that closed while one was open.

**Title:** "New Quick Session" until the first Main Thread prompt, then the first line of that prompt, until the Agent sends a title.

**Design:** https://claude.ai/artifact/SdvTpZbVA7bNayAk5SFSaz
