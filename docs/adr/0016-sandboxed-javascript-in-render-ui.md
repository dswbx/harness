# Sandboxed JavaScript in render_ui

An Agent asked for a calculator. Bindings and `setState` could append digits, but nothing could evaluate `12+3*4`, so the Agent sent a message for every key press. One-off `$computed` functions (math, slice, ...) would pile up for each new case, so `render_ui` runs JavaScript instead.

**What.** `{"$js": "code"}` is a value like `$state`; the action `{"action": "js", "params": {"statePath", "code"}}` writes the code's result to `statePath`. Code is an expression, or a function body when it has a `return`, with `state` (the Session State) in scope. Actions in a list see the writes before them.

**Sandbox.** QuickJS compiled to wasm (`quickjs-emscripten-core`, single-file variant, about 800 KB, loaded on first use), never the webview's `eval`. Each run gets a fresh context: no DOM, network, timers or storage, 50 ms and 16 MB at most, JSON in and out. Code can only compute values and write the Session State, which the Agent can already change. This narrows ADR 0013's "no Agent script runs in the app"; arbitrary HTML stays out.

**Kept.** The code lives in the tool input, so the log stays data and old Sessions replay the same. A non-web Frontend needs a JS engine to run it (QuickJS also embeds in Rust, e.g. `rquickjs`). Errors are runtime only: a failing `js` action changes nothing and shows under the tree; a failing `$js` gives undefined.

**Also.** User writes apply at once on top of the Session State until the core's `StateChanged` arrives, and each write builds on the ones before, so fast presses keep every key. A Grid of only Buttons is a keypad: exactly `columns` wide (up to 6), keys filling their cells.
