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

/** A window's last place and size, in logical pixels. */
type Frame = { x: number; y: number; width: number; height: number };
const frameKey = (key: string) => `harness:window-frame:${key}`;
const readFrame = (key: string): Frame | null => {
   try {
      const f = JSON.parse(localStorage.getItem(frameKey(key)) ?? "null");
      return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) ? f : null;
   } catch {
      return null;
   }
};

/** Opens an app URL (e.g. `/?session=..&solo=1`) in a new window. Frontends can't import Tauri, so this lives here. With `pane=...` the host adds no Session header.
 * `remember`: the window opens at the frame last saved under this key (see `rememberWindowFrame`).
 * `overlayTitleBar`: the traffic lights sit inside the page, like the main window; the page must leave 92px free on the left of a 52px-high top bar. */
export async function openWindow(
   label: string,
   url: string,
   opts: {
      title: string;
      width?: number;
      height?: number;
      remember?: string;
      overlayTitleBar?: boolean;
   },
) {
   if (!inTauri()) {
      window.open(url, "_blank");
      return;
   }
   const [{ WebviewWindow }, { LogicalPosition }] = await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/dpi"),
   ]);
   const frame = opts.remember ? readFrame(opts.remember) : null;
   // A label can hold only `a-zA-Z0-9-/:_`; reusing one focuses nothing, so add a counter.
   const safe = `${label.replace(/[^a-zA-Z0-9\-/:_]/g, "_")}-${Date.now().toString(36)}`;
   const w = new WebviewWindow(safe, {
      url,
      title: opts.title,
      width: frame?.width ?? opts.width ?? 1200,
      height: frame?.height ?? opts.height ?? 800,
      ...(frame && { x: frame.x, y: frame.y }),
      visible: false,
      ...(opts.overlayTitleBar && {
         titleBarStyle: "overlay" as const,
         hiddenTitle: true,
         trafficLightPosition: new LogicalPosition(18, 28),
      }),
   });
   w.once("tauri://error", (e) => console.error("window create failed", e));
}

/** Saves this window's place and size under `key` whenever it moves or resizes, for `openWindow({ remember: key })`. Returns a cleanup. */
export function rememberWindowFrame(key: string): () => void {
   if (!inTauri()) return () => {};
   let off = false;
   const unlisten: (() => void)[] = [];
   void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
      const w = getCurrentWebviewWindow();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const save = () => {
         clearTimeout(timer);
         timer = setTimeout(async () => {
            if (await w.isMinimized()) return;
            const scale = await w.scaleFactor();
            const [pos, size] = await Promise.all([w.outerPosition(), w.innerSize()]);
            const p = pos.toLogical(scale);
            const s = size.toLogical(scale);
            const frame: Frame = { x: p.x, y: p.y, width: s.width, height: s.height };
            try {
               localStorage.setItem(frameKey(key), JSON.stringify(frame));
            } catch {
               /* convenience only */
            }
         }, 300);
      };
      for (const u of await Promise.all([w.onMoved(save), w.onResized(save)])) {
         if (off) u();
         else unlisten.push(u);
      }
   });
   return () => {
      off = true;
      for (const u of unlisten) u();
   };
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
