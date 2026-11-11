# Quick Overlay: a floating window that starts a Quick Session from any app

A Quick Session (ADR 0020) still needs the main window: switch to Harness, click the Quick group's +, type. Users want to ask something from where they are, like a launcher, and keep the answer on screen while they work in the other app.

**Decision:** a global shortcut (default ⌥Space, Settings > Quick overlay) opens the Quick Overlay: one floating, always-on-top window with a prompt box, at the mouse or at the bottom center of the screen. The first message turns it into a small pinned chat, which can be minimized to one bar, merged into the main window, or closed.

**One window, made once.** Label `overlay`, URL `/?overlay=1`, created hidden on first use and never destroyed: close (and ⌘W) only hides it. It is one more Frontend window of the core, like the pop-out View windows: the Session syncs through the same `execute` / `subscribe` / `subscribe_app`. Signals between windows use Tauri events (`overlay-shown`, `overlay-shortcut` to the overlay, `select-session` to the main window).

**The webview owns the state, the host follows it.** `overlayMode.ts` is a pure reducer: `prompt` (a draft, only the prompt box), `chat` (pinned), `mini` (one bar, "New reply" when a Turn ends while mini), and `visible`. Each mode change calls `overlay_set_mode`, which resizes the window around its bottom center, so the prompt box stays where it was. The shortcut shows a hidden overlay; on a visible one the webview decides: the prompt hides, a pinned chat switches between chat and mini (to start a new chat, close first). ⌘M and Esc minimize. Placement is a pure `place()` in `overlay.rs` that keeps the window on the screen it opens on.

**The Quick Session is created when the overlay opens, not on send** (`CreateQuickSession` + `WarmUp`). The model list and the modes exist only once the Agent runs, so the prompt box and its option chips are the main window's, unchanged. Changing the Agent in the draft is `DiscardEmptySession` plus a new draft. The draft starts with the Agent last sent from the overlay, else `quickAgent`. The main sidebar hides Quick Sessions nobody wrote in yet, unless that window has one selected, so the draft never shows as an empty row. The core still decides what is empty and removes leftovers at startup (ADR 0020).

**Reuse, no look-alikes.** The overlay renders the chat Frontend's View with `variant: "overlay"`: no Stripes, Panels or header of its own, and before the first message only the `PromptBox`. A View prop `agentSwitch` turns the footer's model chip into a two-level Agent > model menu (other Agents' models are known only after they start, so picking one replaces the draft). The host draws the overlay's header (Quick chip, title, minimize, open in main window, close) and the mini bar; both are drag regions.

**macOS: a non-activating NSPanel** through `tauri-nspanel` (pinned git rev), in one module of `overlay.rs`: floating level, on every Space and over full-screen apps, does not hide when Harness is not active. Typing in it does not make Harness the active app; "Open in main window" does. This needs `macOSPrivateApi` (transparent window), which rules out the Mac App Store; Harness is not distributed there. Windows and Linux get the shortcut and an always-on-top window only.

**Look.** The window is transparent; the card is CSS (rounded corners, shadow, theme tokens), no vibrancy. The overlay window skips the opaque-background reveal of the other windows (`syncWindowBackground`, the page-load fallback). The prompt window is taller than the box, so its menus open above it inside the window; that transparent area still takes clicks.

**Later.** Phase 2: `render_ui` Panels in the same window, which grows wider (one shared dock parent, ADR 0019). Phase 3: the frontmost app as context and screenshots.

**Design:** https://claude.ai/artifact/7GkaGzkcrjgdeDmgoMgEBz
