# Views load a Session Log in pages, then subscribe

A View opened a Session with one subscription: a replay of the whole Session Log, then live Events. The core sent the replay as one Channel message per Event (each a deep copy, its own JSON, and its own webview eval or fetch), so a big log (thousands of Events, tens of MB) was slow to open. The View also did not know where the replay ended. It guessed (no Event for 40 ms, at most 1 s), and a big log rendered in parts (see [the exploration note](../explorations/2026-11-18-first-render-of-a-session.md)).

**Decision:**

1. **A fifth Transport operation: `readLogPage(sessionId, fromSeq, toSeq)`** (Tauri `read_log_page`, one answer per page, on the blocking pool). It returns the Events with `fromSeq <= seq < end`, oldest first, and `more`. `end` is `toSeq`, else the `seq` the next Event of the log gets. A page holds at most `PAGE_EVENTS` (2000) Events and `PAGE_BYTES` (1 MiB) of JSON, but always one Event while any is left, because one Event can hold megabytes of tool output. The core serializes each Event once, from its shared handle, when it cuts the page. A read flushes a held chunk first.
2. **Pages, then live.** A View reads its first page from the `next` of its fold (0, or the `next` of a cached fold), keeps the `end` of that page, subscribes from `end`, and reads on to `end`. It asks for the next page only after it has folded the last one, so an unmount stops the load. Live Events are held until the last page is folded, then folded on top. The pages hold every Event below `end` and the subscription every Event from `end`: no gap and no duplicate, also when Events are appended between the reads and the subscribe (the subscription replays them) and after `Lagged` (`subscribeResilient` subscribes again from its last `seq` + 1).
3. **One first render**, when the whole log up to `end` is folded. No timing guess. The fold cache keeps only whole folds.
4. **`subscribe` keeps its replay.** It covers what came after `end`, and a subscribe again after `Lagged`.

**Not chosen:** an end marker at the end of the subscription's replay. It removes the guess, but the replay still costs one message per Event, and a View cannot stop a replay it no longer needs.
