# A long Session with many subagents: what made the app slow

2026-11-19. Harness 2026.11.42, React 19 production build (unminified) of the browser mock, Playwright 1.65.1 WebKit (build 2388) and Chromium headless shell 1234. Session Log: a real Session (3,400 Events, 5.8 MB, 8 background subagents with 31 to 79 calls each, bursts up to 36 Events/s), replayed with `?replay=<id>&speed=20&from=0.3`, Subagents panel open.

**Observed:**

- Chat only (the Session's panel files absent): WebKit 95 fps, no frame over 30 ms, typing 2 keys 11 to 17 ms, no growth over 70 s. Chromium: about 10% CPU at 20x speed. No JS heap or DOM growth over 30 Session switches (25 MB after GC).
- With the Session's panel files (one is a 204 KB `.md` file, open in the right dock): from the moment it shows, the main thread was blocked 55% of the time, frame p95 120 ms, typing 2 keys 270 to 390 ms. Profile: almost all of it in `Markdown` (react-markdown parse of the whole file), on every Event batch, because the panel re-renders with the chat state and `Markdown` was not memoized.
- With `Markdown` memoized: blocked 4%, frame p95 12 ms, typing about 20 ms. One 333 ms frame left when the panel first shows (the one parse).
- Synthetic `/stress` Turn (8 subagents, about 2,500 Events): about 5% CPU in Chromium. It does not reproduce the slowness: the cause was the large panel file, not the Event volume.
- `new Intl.DateTimeFormat(...)` costs about 60 µs per call in JavaScriptCore (Bun), 0.6 µs to format with a kept one. `toLocaleString` with options about 55 µs.
- The live app at rest after 4 h: WebContent process 5% CPU, 1.3 GB (top MEM); the Rust process idle (all threads waiting).

**Assumed / unverified:**

- That the real app (WKWebView, Tauri Channel delivery) behaves like Playwright WebKit with the mock transport. The Channel's per-Event cost was not measured.
- That the 1.3 GB of the live WebContent process is not a leak (the mock showed none; the real app was not measured over time).

**Open questions:**

- The first parse of a large panel file (333 ms in WebKit) still blocks a frame; a large file the Agent rewrites often would block once per write. Parse off the main thread, or render the visible part first?
- Other places that re-render a large subtree per Event batch (non-chat panels) may hide the same cost; `?scan` (react-scan) shows them.
