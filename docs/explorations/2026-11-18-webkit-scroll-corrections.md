# WebKit: scroll corrections during a trackpad scroll

2026-11-18. macOS 26.4.1 WKWebView, @tanstack/virtual-core 3.19.8. Browser mock (`?stress`), not the Tauri app.

**Observed:**

- Method: a WKWebView test window, real wheel events (CGEvent scroll wheel with scroll and momentum phases, made into an NSEvent and passed to the view's `scrollWheel`; no Accessibility permission needed), and screen captures of the window at about 250 per second. Each row had a colored strip with unevenly spaced ticks, so the captures show where the content really was on screen.
- Reading `scrollTop` and element positions in JS (also "after paint") does not show what is on screen during a wheel scroll. JS saw a 600px shift for one frame at each correction; the screen did not show it. The screen showed something JS did not: the content stepped back.
- An absolute scroll write (`scrollTo`, `scrollTop =`) during a wheel or momentum scroll sets the view back by what the scrolling thread scrolled since the page's last known offset: one wheel step per write (20px steps: -20; 60px steps: -60). The virtual list wrote "known offset + size change" for every row first measured above the view: 7 to 14 steps back per 300 wheel events.
- A relative write (`scrollBy`) is added to the scrolling thread's own position: no step back, and the content moved exactly as far as the wheel deltas (15297 of 15300px; absolute writes lost one step per correction).
- Left with `scrollBy`: in roughly 1 of 150 corrections (6 in 22 runs) the layout change and the scroll correction reach the screen one frame apart (a shift of the correction's size, seen: 5 and 29px).

**Assumed / unverified:**

- That older macOS versions also apply `scrollBy` as a delta on the scrolling thread. If not, it behaves like the absolute write.
- That a real trackpad behaves like the synthesized events (same event fields, but real timing and 120Hz devices were not tested).
- One run of 22 showed a single step back of 436px mid-scroll; not seen again, cause unknown.

**Open questions:**

- Keyboard scrolling (animated by WebKit): do corrections during it show the same step back?
- Would holding corrections in the top spacer until the gesture ends (the library does this on iOS) remove the last one-frame shifts? A first try needed a write anyway once the held amount passed the scroll offset.
