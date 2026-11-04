# Html frames under the production CSP

2026-11-04. macOS WKWebView (Swift harness, custom schemes with `WKURLSchemeHandler`, the app's CSP as a response header).

**Observed:**

- A sandboxed `srcdoc` frame loads, but no inline script in it runs: it inherits the parent's `script-src 'self'`. Hence `view_artifact` failing with "The HTML frame did not answer" and frames stuck at the default height, without buttons that scripts make, in release builds only.
- A sandboxed frame from a custom scheme with its own CSP runs inline scripts and inline handlers. `self.origin` is `null`.
- `document.write` of the whole document from a `message` handler works, and `postMessage` both ways works afterwards.
- The frame's `load` event fires twice: for the loader, then after `document.close()`. The first fires before the host handles the loader's `ready`.

- Same in the real app (debug Tauri build with the production CSP and a temporary self-test around `UiHtml`): a `srcdoc` control never ran; the frame from `harness-frame://localhost/` ran its script, sized itself, patched state and answered a snapshot, which drew to a PNG.
- In that frame `__TAURI_INTERNALS__` is undefined, so it gets no Tauri API or invoke key. `webkit.messageHandlers.ipc` is visible there, as in any frame.

**Assumed / unverified:**

- Tried only through the self-test, not by clicking through a Session in the app or in a signed release build.

- By the HTML spec `data:` and `blob:` documents inherit the CSP too, so they were not tried.
