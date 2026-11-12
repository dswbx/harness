import type { OverlaySettings } from "@harness/api";
import { inTauri } from "@harness/api";
import type { OverlayMode } from "./overlayMode";
import type { WindowContext } from "./windowContext";

/** The Quick overlay's window commands and signals (`overlay.rs`). Outside Tauri they do nothing. */

const invoke = async <T>(cmd: string, args?: Record<string, unknown>) =>
   (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);

const run = (cmd: string, args?: Record<string, unknown>) => {
   if (!inTauri()) return;
   invoke(cmd, args).catch((e) => console.error(`${cmd} failed`, e));
};

/** Which card edge stays in place (`overlay-shown`): top below the mouse, bottom at the screen's bottom. */
export type OverlayAnchor = "top" | "bottom";

export const overlayHost = {
   setMode: (mode: OverlayMode) => run("overlay_set_mode", { mode }),
   /** Grows the window right and down while a menu is open (`open`), or back; resolves once done. */
   setMenuRoom: (open: boolean) =>
      inTauri() ? invoke<void>("overlay_set_menu_room", { open }) : Promise.resolve(),
   /** A chat resize grip: the chat card's new size with its shadow margin (logical px), its top-left kept (its bottom-right with `topLeft`). */
   /** Resolves to the card's width after (logical px), or null when the host did not resize (not in the chat, a menu open). */
   resize: (width: number, height: number, topLeft = false) =>
      inTauri()
         ? invoke<number | null>("overlay_resize", { width, height, topLeft })
         : Promise.resolve(null),
   /** The chat card's width (logical px): the user's last resize this app session, else the default. */
   chatWidth: () => (inTauri() ? invoke<number>("overlay_chat_width") : Promise.resolve(null)),
   /**
    * Room for side panels left and right of the chat card (logical px): the window grows by that
    * much on each side, the card stays where it is. Resolves once the window has its size.
    */
   setPanels: (left: number, right: number) =>
      inTauri() ? invoke<void>("overlay_set_panels", { left, right }) : Promise.resolve(),
   /** The page painted its first frame: the host may show the window (a shortcut may be waiting). */
   ready: () => run("overlay_ready"),
   hide: () => run("overlay_hide"),
   /** The last window context sent (`overlay-context` may have come before the page listened). */
   context: () =>
      inTauri() ? invoke<WindowContext | null>("overlay_context") : Promise.resolve(null),
   /** System Settings > Privacy & Security > Accessibility or Automation. */
   openPrivacySettings: (pane: "accessibility" | "automation") =>
      run("overlay_open_privacy_settings", { pane }),
   /** Opens the Session in the main window and hides the overlay. */
   merge: (sessionId: string) =>
      inTauri() ? invoke<void>("overlay_merge", { sessionId }) : Promise.resolve(),
};

/** `select-session` (main window), `overlay-shown`, `overlay-shortcut` and `overlay-context` (overlay). */
export function listenHost(
   event: string,
   cb: (payload: unknown) => void,
   /** Runs once the listener is registered. */
   onListening?: () => void,
): () => void {
   if (!inTauri()) return () => {};
   let stop = false;
   let off: (() => void) | undefined;
   void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
      // Events sent with `emit_to(label, ..)` reach only that window.
      const u = await getCurrentWebviewWindow().listen(event, (e) => cb(e.payload));
      if (stop) u();
      else {
         off = u;
         onListening?.();
      }
   });
   return () => {
      stop = true;
      off?.();
   };
}

/** All fields set (the generated type has them optional: the file may miss some). */
export type OverlayConfig = Required<OverlaySettings>;

/** The overlay's settings, and why its shortcut is not registered, if it is not. */
export type OverlayStatus = { settings: OverlayConfig; shortcut_error: string | null };

export const getOverlaySettings = () => invoke<OverlayStatus>("overlay_settings");

/** Registers the shortcut (rejects when that fails; the old one stays) and saves. */
export const setOverlaySettings = (settings: OverlayConfig) =>
   invoke<OverlayStatus>("overlay_set_settings", { settings });
