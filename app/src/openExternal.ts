import { inTauri } from "@harness/api";

/** Inside Tauri, links open in the default browser; in a plain browser the anchor works as is. */
export function openExternal(e: React.MouseEvent, url: string) {
  if (!inTauri()) return;
  e.preventDefault();
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
}
