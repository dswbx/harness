# First render of a Session: what moves

2026-11-18. macOS 26.4.1 WKWebView, @tanstack/virtual-core 3.19.8, React 19 dev build. Browser mock replaying a real Session Log (565 Events, delivered in batches of 50 over tasks), not the Tauri app.

**Observed:**

- Method: a WKWebView test window; per frame, after paint, JS read the list's `scrollTop`, `scrollHeight` and row positions; screen captures of a colored strip at the rows' left edge at about 250 per second.
- The empty state ("Send a message to start.") was in the DOM from the click until the replay rendered: 180 to 260ms.
- `requestAnimationFrame` callbacks can run 1ms apart (two frames back to back after a long task, here the switch from another Session). A wait for "one frame without a new Event" ended there, between two batches of the replay, in 5 of 7 runs: the log then rendered in parts over about 250ms (screen: 9 or more different layouts). With "no Event for 40ms" instead: 0 of 6 runs, first rows about 35ms later.
- After the first pin to the bottom, the first scroll event moves the rendered range (rows above the view leave, the top spacer grows by their cached size, total size unchanged). `scrollTop` then dropped by exactly the real height of the rows that left (4065 to 3029, the rows were 1036px), with no scroll write: as if the content was laid out without them before the spacer grew. Nothing pinned again until the next scroll event, one frame later.
- In the first 1.5s after page load the list took that drop for a user scroll and stopped following the bottom (the time of the last input started at 0, and so does `performance.now()`).
- The bar over the list's end (the prompt box) grows by 28px when the log is here. Its height reached the list a frame late (a `ResizeObserver` callback that sets state: React renders it after the paint): the screen showed the first frame 28px lower, the next one (8 to 14ms later) right. In the replayed real log JS saw both frames the same; in the mock fixture JS saw the 28px too. With the state set in `flushSync`: one layout on screen, 4 of 4 runs.
- Mock fixture, about 400ms after the first render: a lazy component's placeholder (96px) replaced by its content (66px) drops `scrollTop` the same way (by the placeholder's height). JS saw a 66px gap in one sample; the next sample, 5ms later, was back at the bottom.

**Assumed / unverified:**

- That the Tauri Channel can also leave a frame without an Event mid-replay. Only the mock's batched delivery was measured.
- That the drop of `scrollTop` comes from a layout forced in the middle of React's commit (a layout effect cleanup or ref of a row that leaves). Not traced to the code that forces it.
- That the 66px gap of the lazy component never reached the screen (two samples 5ms apart are not two frames; no screen capture taken).

**Open questions:**

- A clean end-of-replay signal (the core returns the head `seq` at subscribe) would replace the 40ms wait and its cap.
