# Harness MCP is served over loopback HTTP, with a stdio shim fallback

The M0 spike showed Claude and Codex both accept HTTP MCP servers. The Harness MCP therefore runs in-process (rmcp streamable HTTP) on 127.0.0.1 with a per-Agent-Session bearer token that identifies Session and Thread, rejecting any `Origin` header. Agents without HTTP MCP get a stdio shim mode of the app binary that proxies to the same server. Alternatives: stdio-only (needs a process per Agent Session and loses in-process state access) or MCP over ACP (still a draft).
