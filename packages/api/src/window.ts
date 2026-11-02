import { inTauri } from "./transport";

/** Opens an app URL (e.g. `/?session=..&solo=1`) in a new window. Frontends can't import Tauri, so this lives here. With `pane=...` the host adds no Session header. */
export async function openWindow(label: string, url: string, opts: { title: string; width?: number; height?: number }) {
  if (!inTauri()) {
    window.open(url, "_blank");
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  // A label can hold only `a-zA-Z0-9-/:_`; reusing one focuses nothing, so add a counter.
  const safe = `${label.replace(/[^a-zA-Z0-9\-/:_]/g, "_")}-${Date.now().toString(36)}`;
  const w = new WebviewWindow(safe, { url, title: opts.title, width: opts.width ?? 1200, height: opts.height ?? 800, visible: false });
  w.once("tauri://error", (e) => console.error("window create failed", e));
}

/** Opens a web URL in the user's browser (inside Tauri via the opener plugin; in a plain browser a new tab). Frontends can't import Tauri, so this lives here. */
export function openExternalUrl(url: string) {
  if (!inTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch((e) => console.error("open url failed", e));
}
