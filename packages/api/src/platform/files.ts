import { inTauri, type Unsubscribe } from "../transport/transport";

/** Native file picker (Tauri): absolute paths, `[]` when cancelled. `null` outside Tauri: use an `<input type="file">`. */
export async function pickFiles(): Promise<string[] | null> {
   if (!inTauri()) return null;
   const { open } = await import("@tauri-apps/plugin-dialog");
   const r = await open({ multiple: true, directory: false });
   return r === null ? [] : Array.isArray(r) ? r : [r];
}

/** Cursor position in CSS pixels, relative to the window's top-left corner. */
export type DropPoint = { x: number; y: number };

export type FileDrop =
   | { type: "over"; position?: DropPoint }
   | { type: "leave" }
   | { type: "drop"; paths: string[]; position?: DropPoint };

/**
 * Files dragged onto this window (Tauri). Tauri takes file drops before the page sees them, so
 * HTML5 `drop` never fires there; outside Tauri this returns `null` and HTML5 drop works.
 */
export async function onFileDrop(cb: (e: FileDrop) => void): Promise<Unsubscribe | null> {
   if (!inTauri()) return null;
   const { getCurrentWebview } = await import("@tauri-apps/api/webview");
   // Tauri types the position as physical pixels. On macOS it is not: wry passes AppKit's dragging
   // location on, which is in points (CSS pixels) already. Elsewhere it is physical.
   const mac = /Mac/.test(navigator.userAgent);
   const css = (p: { x: number; y: number }): DropPoint => {
      const r = mac ? 1 : window.devicePixelRatio || 1;
      return { x: p.x / r, y: p.y / r };
   };
   return getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      if (p.type === "drop") cb({ type: "drop", paths: p.paths, position: css(p.position) });
      else if (p.type === "leave") cb({ type: "leave" });
      else cb({ type: "over", position: css(p.position) });
   });
}
