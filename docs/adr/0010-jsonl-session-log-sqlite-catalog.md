# Session Log is JSONL per Session Directory; SQLite only as a rebuildable catalog

Each Session Log is an append-only `log.jsonl` in its Session Directory: self-contained (archive or export is a folder copy), greppable, and needs no migrations for old Sessions; a torn trailing line is truncated on open. Cross-Session data (session list, installs, rules, MCP Library, settings) may live in one app-level SQLite database that can be rebuilt from the logs. SQLite per Session was rejected as unnecessary at v1 sizes.
