# The Session Log evolves additively

A Session Log is forever: every Event kind we ship is a format we must read for as long as the Session exists, and a log written by a newer build may be opened by an older one. Losing or rewriting history on a parse failure is never acceptable (ADR 0003).

**Decision:**

1. **Event changes are additive only.** New kinds, and new fields that are optional with a serde default. A field or kind is never repurposed.
2. **Renames and removals go through an upcaster.** `log::upcast(v, json) -> json` runs on every line before it is parsed and rewrites an old shape into the current one, keyed on the Event's `v`. It is the identity while only v1 exists. A breaking change bumps `EVENT_SCHEMA_VERSION` and adds a step there. The file is never rewritten.
3. **`EventKind::Unknown` covers newer kinds.** A `type` this build does not know reads as `Unknown` (`#[serde(other)]`), keeping `seq` contiguous. The original line stays in the file only. Frontends ignore it.
4. **A newer `v` opens the Session read-only.** Appends fail with a clear error; nothing is written or truncated.
5. **Bad lines are kept.** Only a final line without a newline is cut on open. A complete line that does not parse stays in the file, after a one-time copy to `log.jsonl.corrupt-<ts_ms>`; if it is not an Event at all it is left out of the in-memory view.
6. **Golden logs guard it.** `crates/harness-core/tests/golden/` holds recorded logs, added per release. CI parses each with zero `Unknown`s in Rust and reduces each through the chat reducer against a committed snapshot, so a change that breaks an old log or its reduced state fails.

**Storage and fan-out** (amends ADR 0010): `session.json` is the catalog; no SQLite store was built. A `log.checkpoint.json` beside each log (`next_seq`, `last_ts_ms`, `agent_was_running`, `byte_len`, written on `sync`) lets open parse only the tail. Events are held in memory once loaded, one writer thread per log owns the file, and each View has a bounded queue (`Lagged`, then resubscribe from `last_seq`). A lock on `<data dir>/.lock` keeps a second Harness from writing the same logs.
