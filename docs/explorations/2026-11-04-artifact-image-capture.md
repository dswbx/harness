# Artifact image capture in the webview

2026-11-04. macOS 26 WKWebView (Swift harness loading the app with the mock and the production CSP), Electron Chromium 152, mermaid 11.

**Observed:**

- WKWebView draws an SVG with `foreignObject` (from a data URL) to a canvas without tainting it: `toDataURL` and `getImageData` work.
- Inside that SVG, `:root` rules match the `svg` root, so the theme variables and `:root.dark` work when the `svg` gets the page's `class` and `style`.
- The page's stylesheets copied in full give the same look as on screen, pseudo elements included. Cloning computed styles is not needed.
- A sandboxed Html frame can serialize itself and post the XML to the host, which draws it. Its canvases must become images first.
- Mermaid's SVG is HTML, not XML (`<br>`). Parse as HTML, then `XMLSerializer` gives valid XML. Its CSS has `font-family: inherit`, so the root needs a font.
- In WKWebView a script error in a frame reports only "Script error." (opaque origin). Chromium gives the real message.
- The app's CSP `img-src` allows `data:` but not `blob:`.

**Assumed / unverified:**

- Timers still run in a hidden or minimized window, slowly enough for a capture within the 60 s limit. Capture uses timers and not `requestAnimationFrame` for this reason. Not tested.
- Images from other sites in a render_ui tree come out blank: the canvas that embeds them is tainted. Not tested.

**Open questions:**

- Does `view_artifact` need a way to pick a theme? It uses the app's current one.
