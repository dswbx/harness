# Panel windows: a Session's Panel in its own OS window

Users want to move a Panel (Plan, Tasks, Terminal, ...) out of the main window, for example onto a second display. The main window switches between Sessions, so a moved Panel must show which Session it belongs to, must dock back into its Zone, and must come back after quit and relaunch. Before this, only Changes (DiffWindow) and Files had windows of their own.

**Decision:** any Panel can pop out into a Panel window: an OS window that shows only that Panel of one Session. In the main window the Panel shows as closed (its Zone collapses when nothing else is open there), but the stored layout keeps it open in its Zone, so Dock back shows it there again. Closing the window (red X) does not dock back: the Panel is docked but hidden in its Zone; its Stripe icon opens it. The Stripe icon and the sidebar row get a window badge; a click on the icon focuses the window, and its context menu (the same entries as the Panel's ⋮ menu) has Show window and Dock back.

**Bound to one Session.** A Panel window shows one Panel of one Session for its whole life. Switching Sessions in the main window does not change it. The same Panel id in two Sessions gives two windows. Popping a Panel that is already popped focuses its window. The window label is `panel-{session}:{panel}` with both parts escaped (`panelWindowLabel`, injective), so the label finds the open window.

**Same View, window mode.** The window loads `/?session=&solo=1&pane=panel&panel=<id>` and renders the chat Frontend's View with `popout: <id>`. Its layout is the Session's stored layout with that Panel shown, kept in memory and never saved (like the Quick Overlay, ADR 0022). Every Panel gets the window header from `PanelHeader`, so no Panel needs changes. An unknown Panel id (a removed `render_ui` item) removes its key and closes the window.

**Storage: one key per window.** All keys are in the `STORAGE_KEYS` registry. No stored layout format changes.

- `harness.panelWindow.{session}#{name}` → `{v:1, at, closed?: true}`. Key present and not `closed` = the Panel is popped. `closed` = the user closed the window; the Session's main view still has to hide the Panel. Bad data counts as absent and is removed. Older values have no `closed` and still parse.
- `harness.panelWindowFrame.{session}#{name}` → the window's frame (logical pixels). Only the Panel window writes it.
- `harness.panelWindows.reopen` → app setting "Reopen panel windows on launch" (`on`/`off`, default on; Settings > Appearance > Windows).

One key per window, not one shared list, because each window is its own webview: two webviews that read, change and write one list can lose each other's change. With one key per window, each write touches only its own key. `forgetSession` removes both Session families. Data from older builds has no keys, so nothing is popped.

**Quit vs close vs Dock back.** In Tauri, `app.exit()` raises `ExitRequested` and then exits; it never raises `CloseRequested` on a window (checked in tauri-runtime-wry). So `onCloseRequested` in a Panel window means the user closed it (red X, Cmd+W).

| Action                                              | Key                           | Main view                                                 |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| Quit, crash                                         | kept                          | window comes back on the next launch                      |
| Close (red X, Cmd+W, browser tab)                   | `closePanel`: marked `closed` | hides the Panel in its Zone (saved), then removes the key |
| Dock back (window header, Stripe menu, main window) | `dockPanel`: removed          | Panel shows open in its Zone                              |
| Session deleted, setting off on launch              | removed                       | as Dock back                                              |

The Panel window must not write the Session's stored layout: the main view keeps that layout in memory and would write over it. So the close only marks the key, and the main view of that Session applies it (`useClosedWindows`): at once when it shows the Session, else when the Session's view mounts later (the main window showed another Session, or was not running). It removes the key only after the hidden layout is saved. `closePanel` does nothing when the key is gone, so the close that follows Dock back changes nothing. A Panel window closes itself when its Panel is no longer popped (key gone or `closed`).

**Restore on launch.** Once per launch, in the main window only, after the Session list has loaded (`app/src/shell/restorePanelWindows.ts`, a pure `planRestore` plus a runner):

- Session deleted → remove the key (also a `closed` one).
- `closed` → leave it for the Session's main view; never reopen.
- Session archived → remove the key (dock back). Its layout already has the Panel open in its Zone.
- Setting off → remove all keys (all dock back).
- Else open the window quietly (it does not take focus from the main window) at its saved frame. A frame that no display shows (a display was removed or moved) moves to the main window's display, centered (`fitFrame`).

In the browser mock, tabs outlive the main page and a closed tab marks its own key `closed` (`pagehide`), so only the removals run there.

**Consequences.** Each Panel window runs the full chat fold and the Panel models of its Session (more memory on long Sessions). A target sent to a popped Panel from the main window (a diff link while Changes is popped) only focuses its window for now. Closing the main window while Panel windows are open leaves them without a main window (an older issue: there is no reopen handler).
