# Panel windows: a Session's Panel in its own OS window

Users want to move a Panel (Plan, Tasks, Terminal, ...) out of the main window, for example onto a second display. The main window switches between Sessions, so a moved Panel must show which Session it belongs to, must dock back into its Zone, and must come back after quit and relaunch. Before this, only Changes (DiffWindow) and Files had windows of their own.

**Decision:** any Panel can pop out into a Panel window: an OS window that shows only that Panel of one Session. Popping out does not change the stored layout. In the main window the Panel shows as closed (its Zone keeps showing what it showed, or collapses when nothing else is open there). Dock back opens the Panel in its Zone. Closing the window (red X) does not dock back: the Panel is docked but hidden in its Zone; its Stripe icon opens it. The Stripe icon and the sidebar row get a window badge; a click on the icon shows the window (focused, or opened again when it is gone), and its context menu (the same entries as the Panel's ⋮ menu) has Show window and Dock back. Move to on a popped Panel changes only its Zone (no Zone's shown Panel changes); docked back, it opens in the new Zone.

**Bound to one Session.** A Panel window shows one Panel of one Session for its whole life. Switching Sessions in the main window does not change it. The same Panel id in two Sessions gives two windows. Popping a Panel that is already popped focuses its window. The window label is `panel-{session}:{panel}` with both parts escaped (`panelWindowLabel`, injective), so the label finds the open window.

**Same View, window mode.** The window loads `/?session=&solo=1&pane=panel&panel=<id>` and renders the chat Frontend's View with `popout: <id>`. Its layout is the Session's stored layout with that Panel shown, kept in memory and never saved (like the Quick Overlay, ADR 0022). Every Panel gets the window header from `PanelHeader`, so no Panel needs changes. An unknown Panel id (a removed `render_ui` item) removes its key and closes the window.

**Storage: one key per window.** All keys are in the `STORAGE_KEYS` registry. No stored layout format changes.

- `harness.panelWindow.{session}#{name}` → `{v:1, at, closed?: true, docked?: true}`. Key present without `closed` or `docked` = the Panel is popped (live). `closed` = the user closed the window; `docked` = Dock back. Both are ended entries: the Session's main view still has to apply them (hide or show the Panel). Bad data counts as absent and is removed. Older values (no `closed`, or `closed: true`) still parse. `popPanel` on an absent or ended key writes a fresh live entry (`at` = now).
- `harness.panelWindowFrame.{session}#{name}` → the window's frame (logical pixels). Only the Panel window writes it.
- `harness.panelWindows.reopen` → app setting "Reopen panel windows on launch" (`on`/`off`, default on; Settings > Appearance > Windows).

One key per window, not one shared list, because each window is its own webview: two webviews that read, change and write one list can lose each other's change. With one key per window, each write touches only its own key. `forgetSession` removes both Session families. Data from older builds has no keys, so nothing is popped.

**Quit vs close vs Dock back.** In Tauri, `app.exit()` raises `ExitRequested` and then exits; it never raises `CloseRequested` on a window (checked in tauri-runtime-wry). So `onCloseRequested` in a Panel window means the user closed it (red X, Cmd+W).

| Action                                                | Key                           | Main view                                                 |
| ----------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| Quit, crash                                           | kept                          | window comes back on the next launch                      |
| Close (red X, Cmd+W, browser tab)                     | `closePanel`: marked `closed` | hides the Panel in its Zone (saved), then removes the key |
| Dock back (window header, Stripe menu, main window)   | `dockPanel`: marked `docked`  | shows the Panel in its Zone (saved), then removes the key |
| Archived Session or setting off, on launch            | marked `docked`               | as Dock back                                              |
| Session deleted, unknown Panel id, window not created | removed (`forgetPanelWindow`) | nothing to do                                             |
| Pop out again (from any state)                        | `popPanel`: live, fresh `at`  | Panel shows as closed                                     |

The Panel window must not write the Session's stored layout: the main view keeps that layout in memory and would write over it. So close and Dock back only mark the key, and the main view of that Session applies it (`useEndedWindows`): at once when it shows the Session, else when the Session's view mounts later (the main window showed another Session, or was not running). It applies each end once and removes the key only after the changed layout is saved. `closePanel` and `dockPanel` do nothing on an ended or absent key, so the close that follows Dock back changes nothing.

**A live key without a window.** The window can be gone while its key is live (it was never created, or it died). Every way to reach a popped Panel (Stripe icon, its menu's Show window, a shortcut, a link into the Panel, the sidebar badge) calls `showPanelWindow`: it focuses the window, and when there is none it opens it again at its saved frame. When `openWindow` cannot create the window (`tauri://error`), `popPanel` removes the key again, so the Panel is not stuck as popped.

**A Panel window closes itself** when its Panel is no longer popped (key absent or ended), but only after a short grace time (`CLOSE_GRACE_MS`, 200 ms) and only if the key is still not live then. This handles Dock back followed quickly by a new pop out: the new pop out finds the old window still open and focuses it (stable label), and that window must stay. Rule: the stored value at the end of the grace time decides, not the change that started it. A pop out in the few milliseconds between that read and the window's destroy can still lose the window; the next click on the Stripe icon opens it again (`showPanelWindow`).

A Panel window of a deleted Session (`Solo`: the Session list loaded and the Session is not in it) removes its key and closes. A failed first load of the list does not count as deleted: the window waits for the next load.

**Restore on launch.** Once per main-window page load, in the main window only, after the Session list has loaded (`app/src/shell/restorePanelWindows.ts`, a pure `planRestore` plus a runner):

- Session deleted → remove the key (also an ended one).
- Ended (`closed`, `docked`) → leave it for the Session's main view; never reopen.
- Session archived → mark it `docked` (dock back).
- Setting off → mark all `docked` (all dock back).
- Else open the window quietly (it does not take focus from the main window) at its saved frame. A frame that no display shows (a display was removed or moved) moves to the main window's display, centered (`fitFrame`).

A reload of the main window (dev: a full reload, Cmd+R) runs the restore again while Panel windows are open. So a live key whose window exists (`panelWindowOpen`, Tauri `getByLabel`) is never docked, and a quiet reopen of an open window does nothing. No extra storage is needed for this.

In the browser mock, tabs outlive the main page and a closed tab marks its own key `closed` (`pagehide`), so only the removals and docks run there.

**Opens between windows (panel inbox).** A `ctx.open(ref, target)` that a View cannot show goes to the View that owns that Panel for this Session: the Panel window when the Panel is popped, else the main window (which first switches to the Session, `showSession`). Examples: "Show in artifacts" in a popped slot opens Artifacts in the main window at the item; a diff link in the main window while Changes is popped opens the Changes window at that scope. The fallback of a Panel (Files) is now for the Quick Overlay only; a Panel window sends to the main window instead.

- `harness.panelOpen.{session}#{name}` → `{v:1, at, target?}`, one key per (Session, Panel) like the window keys. `target` is the JSON value of the open (all targets are JSON). `sendPanelOpen` writes the key, then shows the owner's window (`showPanelWindow` or `showSession`). `forgetSession` removes the family.
- The owner applies it (`useInbox`): the main view owns the Panels that are not popped, a Panel window only its own Panel, the Quick Overlay none. Each entry is applied once through `ctx.open`, then `takePanelOpen` removes the key. An entry for a Panel the View does not host (yet) stays: a slot made just before the open shows on the next render and then matches.
- An entry older than 30 s (`PANEL_OPEN_TTL`) is stale: removed, never applied. So an open that no View took does not fire on the next launch. Bad data is removed too.

**Main window close.** On macOS the main window's red X (or Cmd+W) only hides it; Panel windows stay open. The Dock icon (`RunEvent::Reopen`) shows it again, and so does a Session chip or a sent open (`show_session` shows a hidden main window). On other platforms closing the main window quits the app, so Panel windows never run without it; quit keeps their keys, so they restore on the next launch.

**Consequences.** Each Panel window runs the full chat fold and the Panel models of its Session (more memory on long Sessions).
