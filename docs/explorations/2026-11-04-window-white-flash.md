# White flash when a window opens

2026-11-04. tauri 2.12.5, wry 0.57.1, tao 0.37.2, macOS 26.4 (Darwin 25.4).

**Observed:** `PageLoadEvent::Finished` comes before the webview's first paint, so showing the window there can reveal the white default WKWebView background. `wry` 0.57 turns that background off on macOS through `drawsBackground`, both at build time and at runtime. The tauri docs comment "Not implemented for the webview layer" on `WebviewWindow::set_background_color` is out of date. The bundled app showed its window before the 1s fallback could fire. Canvas in WKWebView converts `oklch()` to sRGB bytes.

**Assumed / unverified:** that no white frame remains. Screen capture was denied in the test environment, so nobody has watched the fix on screen yet.

**Open questions:** `drawsBackground` is a private WebKit key, which may matter for a Mac App Store build.
