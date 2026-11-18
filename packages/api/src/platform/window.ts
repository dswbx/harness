import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../transport/transport";
import { storedValue } from "./storage";

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
const frameStore = (key: string) =>
   storedValue<Frame | null>({
      key: `harness:window-frame:${key}`,
      scope: "app",
      parse: (raw) => {
         try {
            const f = JSON.parse(raw ?? "null");
            return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) ? f : null;
         } catch {
            return null;
         }
      },
      sync: false,
   });
const readFrame = (key: string): Frame | null => frameStore(key).get();

/** Opens an app URL (e.g. `/?session=..&solo=1`) in a new window. Frontends can't import Tauri, so this lives here. With `pane=...` the host adds no Session header.
 * `remember`: the window opens at the frame last saved under this key (see `rememberWindowFrame`).
 * `overlayTitleBar`: the traffic lights sit inside the page, like the main window; the page must leave 92px free on the left of a top bar `titleBarHeight` high (default 52px); the lights are centered in it. */
export async function openWindow(
   label: string,
   url: string,
   opts: {
      title: string;
      width?: number;
      height?: number;
      remember?: string;
      overlayTitleBar?: boolean;
      titleBarHeight?: number;
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
         // 28 centers the lights in a 52px bar; each px less moves them up a full px (measured at 44px: 20).
         trafficLightPosition: new LogicalPosition(18, 28 - (52 - (opts.titleBarHeight ?? 52))),
      }),
   });
   w.once("tauri://error", (e) => console.error("window create failed", e));
}

/** Shows a file in the system file manager (Tauri only; frontends can't import Tauri, so this lives here). */
export async function revealPath(path: string): Promise<void> {
   const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
   await revealItemInDir(path);
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
            frameStore(key).set(frame);
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

/**
 * Opens a web URL in the user's browser (inside Tauri via the opener plugin; in a plain browser a
 * new tab). Frontends can't import Tauri, so this lives here. A failure goes to `onError`
 * (default: the console).
 */
export function openExternalUrl(
   url: string,
   onError: (e: unknown) => void = (e) => console.error("open url failed", e),
) {
   if (!inTauri()) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
   }
   void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(onError);
}

/** Click handler for a link: in Tauri open it in the browser, in a plain browser let the anchor work as is. */
export function openExternalLink(e: { preventDefault(): void }, url: string) {
   if (!inTauri()) return;
   e.preventDefault();
   openExternalUrl(url);
}
