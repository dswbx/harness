# Agent behaviours stay with the Agent: strict ACP

Planning, compaction, slash commands, modes/models, usage, and skills are Agent behaviours. The Harness does not reimplement them; it records ACP's notifications for them in the Session Log, exposes generic commands (send a slash command, set a config option), and lets Frontends present them. If an Agent lacks a feature, it is absent for that Thread. Harness-side "sugar" may be added later only where something is clearly missing, not by default.
