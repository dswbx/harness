# Quick Sessions: ideas for later

Date: 2026-11-04. No Agents tested for these ideas. Source: the design canvas, https://claude.ai/artifact/SdvTpZbVA7bNayAk5SFSaz. Decision context: ADR 0020.

**Observed:** `NewSessionRequest` needs a folder (`acp.rs`). The Glossary says a Workspace is fixed after creation.

**Assumed / unverified:**

- Continue in a folder (board F): copy files to a folder the user picks and start a new Session there. A Session cannot move, because its Workspace is fixed. "Read the Quick Session on request" needs new work: the transcript tools only read the Session they run in.
- Small prompt over the open Session (board B): needs a new floating surface.
- Setting for the Quick Session location: changes new Sessions only. `quick` is stored, so old ones stay quick.

**Open questions:**

- At the bottom of a long list, the Quick + can scroll out of view. Does that matter in use?
- Do Quick Sessions pile up enough to need a limit in the group or an automatic delete?
