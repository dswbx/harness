import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./transport";

/** Lets the user save `data` under a suggested `name`: the native save dialog in Tauri, a browser download otherwise. Returns where it went (in a browser, `name`), or null on cancel. */
export async function saveFile(name: string, data: Blob): Promise<string | null> {
   if (!inTauri()) {
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return name;
   }
   const bytes = new Uint8Array(await data.arrayBuffer());
   let binary = "";
   // In parts: one call with all bytes as arguments overflows the stack on large files.
   for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
   }
   return invoke<string | null>("save_file", { name, data: btoa(binary) });
}

/** Opens an app URL (e.g. `/?session=..&solo=1`) in a new window. Frontends can't import Tauri, so this lives here. With `pane=...` the host adds no Session header. */
export async function openWindow(
   label: string,
   url: string,
   opts: { title: string; width?: number; height?: number },
) {
   if (!inTauri()) {
      window.open(url, "_blank");
      return;
   }
   const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
   // A label can hold only `a-zA-Z0-9-/:_`; reusing one focuses nothing, so add a counter.
   const safe = `${label.replace(/[^a-zA-Z0-9\-/:_]/g, "_")}-${Date.now().toString(36)}`;
   const w = new WebviewWindow(safe, {
      url,
      title: opts.title,
      width: opts.width ?? 1200,
      height: opts.height ?? 800,
      visible: false,
   });
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
