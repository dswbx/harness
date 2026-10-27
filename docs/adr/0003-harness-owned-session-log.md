# The Harness keeps its own Session Log as source of truth

Agents differ in whether and how they can reload past sessions (`session/load` and `session/resume` are optional in ACP) and store history in their own formats. The Harness therefore records every Session event in its own append-only Session Log in the Session Directory; Views always render from it, never from the Agent. The Agent's memory is used only to continue a Session, not to display it. Cost: duplicated storage and a normalized event schema we must maintain.
