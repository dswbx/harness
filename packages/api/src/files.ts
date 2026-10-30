import { inTauri, type Unsubscribe } from "./transport";

/** Native file picker (Tauri): absolute paths, `[]` when cancelled. `null` outside Tauri: use an `<input type="file">`. */
export async function pickFiles(): Promise<string[] | null> {
  if (!inTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple: true, directory: false });
  return r === null ? [] : Array.isArray(r) ? r : [r];
}

export type FileDrop = { type: "over" } | { type: "leave" } | { type: "drop"; paths: string[] };

/**
 * Files dragged onto this window (Tauri). Tauri takes file drops before the page sees them, so
 * HTML5 `drop` never fires there; outside Tauri this returns `null` and HTML5 drop works.
 */
export async function onFileDrop(cb: (e: FileDrop) => void): Promise<Unsubscribe | null> {
  if (!inTauri()) return null;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent(({ payload: p }) => {
    if (p.type === "drop") cb({ type: "drop", paths: p.paths });
    else if (p.type === "leave") cb({ type: "leave" });
    else cb({ type: "over" });
  });
}
