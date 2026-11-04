# White flash when a window opens

2026-11-04. tauri 2.12.5, wry 0.57.1, tao 0.37.2, macOS 26.4 (Darwin 25.4).

**Observed:** `PageLoadEvent::Finished` comes before the webview's first paint, so showing the window there can reveal the white default WKWebView background. `wry` 0.57 turns that background off on macOS through `drawsBackground`, both at build time and at runtime. The tauri docs comment "Not implemented for the webview layer" on `WebviewWindow::set_background_color` is out of date. The bundled app showed its window before the 1s fallback could fire. Canvas in WKWebView converts `oklch()` to sRGB bytes.

**Follow-up, same day, release bundle:** the fix above still flashed. An app can read its own window with `CGWindowListCreateImage` without Screen Recording permission, so a temporary probe sampled a 60x60 grid of real pixels from page start. Launched with `open -n` and a scratch `HARNESS_HOME`:

- Native color set and page color correct (`#181818`) before `show()`, yet 6/6 launches had a first visible frame of `ffffff`, then the right color about 10ms later. So the white is in the web layer, not the native background.
- `backgroundColor` in `tauri.conf.json` (`drawsBackground` off at webview creation): still 4/8 white, sometimes 3 captured frames. Not enough.
- Order the window in at alpha 0, reveal after two `requestAnimationFrame`s: 0/26 launches with a white frame, 6 of them with a copy of real sessions and themes. Reveal comes 35-66ms after show. `rAF` does fire at alpha 0.

Why: a hidden window's webview does not render, so its first commit happens after `show()`. Probes started after `show()` or sampling too sparsely can miss this, which is how the first fix looked right.

**Assumed / unverified:** a window capture is not the display, and frames are about 10-17ms apart, so a shorter white frame could escape it. Nobody has watched this fix on screen. View windows share the code path but were not probed. Light mode was not probed.

**Open questions:** `drawsBackground` is a private WebKit key, which may matter for a Mac App Store build.
