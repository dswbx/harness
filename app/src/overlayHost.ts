import type { OverlaySettings } from "@harness/api";
import { inTauri } from "@harness/api";
import type { OverlayMode } from "./overlayMode";

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
   /** The chat's resize grip: the chat card's new size with its shadow margin (logical px), its top-left kept. */
   resize: (width: number, height: number) => run("overlay_resize", { width, height }),
   /**
    * Room for side panels left and right of the chat card (logical px): the window grows by that
    * much on each side, the card stays where it is. Resolves once the window has its size.
    */
   setPanels: (left: number, right: number) =>
      inTauri() ? invoke<void>("overlay_set_panels", { left, right }) : Promise.resolve(),
   hide: () => run("overlay_hide"),
   /** Opens the Session in the main window and hides the overlay. */
   merge: (sessionId: string) =>
      inTauri() ? invoke<void>("overlay_merge", { sessionId }) : Promise.resolve(),
};

/** `select-session` (main window), `overlay-shown` and `overlay-shortcut` (overlay). */
export function listenHost(event: string, cb: (payload: unknown) => void): () => void {
   if (!inTauri()) return () => {};
   let stop = false;
   let off: (() => void) | undefined;
   void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
      // Events sent with `emit_to(label, ..)` reach only that window.
      const u = await getCurrentWebviewWindow().listen(event, (e) => cb(e.payload));
      if (stop) u();
      else off = u;
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
