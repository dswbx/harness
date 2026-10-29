# git-diff-view for the diff UI (spike)

Date: 2026-10-29. `@git-diff-view/react` 0.1.8 (core 0.1.8, lowlight 3, highlight.js 11), React 19, Vite 8, Tailwind v4. Tested in the browser with MockTransport only, not in Tauri.

## Built

- Sidebar (`DiffPanel`): each file of `Diff.patch` in unified mode, 11px, wrapped. Collapsible per file; file list scrolls to the file.
- Pop-out (`DiffWindow`): URL `/?session=..&solo=1&pane=diff[&from&to&label]`, opened with `openWindow` from `@harness/api` (WebviewWindow in Tauri, `window.open` in a browser). The chat `View` renders `DiffWindow` when `pane=diff`. File list with status icons; split/unified toggle; "N differences"; Alt+↑/↓ change, Alt+←/→ file; ↑/↓ in the focused file list. Next/previous change crosses into the next/previous file.
- Full file context: new core command `GitShowFile { rev, path }` (`git show rev:path`, empty when absent). The pop-out loads both sides for the current file, so git-diff-view can expand collapsed regions. The sidebar uses hunks only (no expand).
- Inline comments in both views: the "+" gutter widget opens a form; comments show under the line (`extendData`). They live in `localStorage` per Session (`reviewComments.ts`); the `storage` event syncs windows. The prompt box shows them as chips above the editor. On send they are appended as a `Review comments:` section (`path:line (old|new)`, fenced code line, comment text) and cleared; restored if the send fails.
- Edit tool diffs (`ToolCard`): `unifiedPatch()` turns old/new text into a patch with 3 context lines, rendered read-only.

## Observed

- Takes our per-file `diff --git` section as `hunks: [text]` and parses it (tests compare its addition/deletion counts with ours).
- CSS: `diff-view-pure.css` is scoped under `.diff-tailwindcss-wrapper` and is unlayered, so it beats our layered Tailwind utilities inside the diff. No visible clash in our widgets. The scroll container sets `font-family: Menlo...` inline; overridden with `!important`.
- Theming: only `light`/`dark` plus CSS variables (`--diff-*--`). `diffView.css` maps them to our tokens (`--background`, `--muted`, `--border`, `--primary`, add/del as `color-mix` with emerald/red).
- Widgets and extend lines render one frame at width 0 (git-diff-view measures first), so a comment flashes narrow on add.
- Changed lines have no class or data attribute; only the line-number cell's background variable or an empty-side placeholder cell marks them. Change navigation queries that (`changeRows` in `DiffWindow.tsx`), so it can break on a library update.
- No virtualization: every row is a DOM `tr`. Split mode syncs horizontal scroll and row heights between its two tables itself.
- Bundle (app, minified/gzip): main JS 1118/336 kB before; 2205/679 kB with git-diff-view as is (its lowlight registers all ~190 highlight.js languages); 1462/432 kB with a Vite transform to lowlight's `common` set (`app/vite.config.ts`). CSS +23 kB (+3 kB gzip).
- CSP: no `eval`/`new Function` in core or react dist; highlighting is lowlight (pure JS), so `script-src 'self'` is fine. Shiki's WASM regex engine would need `'wasm-unsafe-eval'`; its JS regex engine would not. Workers (git-diff-view has an optional worker mode) would need `worker-src`/`blob:`; not used.
- `window.open` in the Browser pane replaces the current tab instead of opening one.

## Code theme

Syntax colors come from the library's built-in highlight.js GitHub theme (`.hljs-*` under `.diff-line-syntax-raw`). A shared code theme would set those `.hljs-*` colors (or `--diff-view-light`/`--diff-view-dark`) in one stylesheet used by diffs, prompt and message code blocks. git-diff-view also accepts `registerHighlighter` (e.g. Shiki with its JS engine) if all code views move to one highlighter.

## Assumed / unverified

- The `storage` event reaches other Tauri WebviewWindows (appearance sync relies on it; not retested here).
- `GitShowFile` with a tree id from `Diff.to` (`workspace::snapshot`) works like a commit id (`git show <tree>:<path>`); not run against a real repo.
- Large diffs (thousands of lines) without virtualization: not measured.

## Open questions

- Lazy-load the diff viewer (dynamic import) to keep it out of the main chunk?
- Comments as Lexical decorator nodes instead of chips above the editor?
- Should `GitShowFile` error instead of returning empty for missing files?
