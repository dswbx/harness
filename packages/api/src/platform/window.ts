import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../transport/transport";
import { type Stored, storedValue } from "./storage";

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

/** A window's place and size, in logical pixels. */
export type Frame = { x: number; y: number; width: number; height: number };

/** A stored frame; anything else (missing, bad JSON, a non-finite field) is null. */
export function parseFrame(raw: string | null): Frame | null {
   try {
      const f = JSON.parse(raw ?? "null");
      return f && [f.x, f.y, f.width, f.height].every(Number.isFinite) ? f : null;
   } catch {
      return null;
   }
}

/** Where a window keeps its frame: a key under `harness:window-frame:`, or a caller's own store. */
export type FrameStore = string | Stored<Frame | null>;
const frameStore = (store: FrameStore): Stored<Frame | null> =>
   typeof store === "string"
      ? storedValue<Frame | null>({
           key: `harness:window-frame:${store}`,
           scope: "app",
           parse: parseFrame,
           sync: false,
        })
      : store;

/** URL parameter `openWindow({ quiet })` adds: the page shows its window without taking focus. */
const QUIET_PARAM = "quiet";

/** Whether this page's window was opened with `openWindow({ quiet: true })` (it must show without focus). */
export function windowOpenedQuietly(): boolean {
   try {
      return new URLSearchParams(globalThis.location?.search ?? "").get(QUIET_PARAM) === "1";
   } catch {
      return false;
   }
}

/** Brings the window with this label to the front (unminimized, shown, focused). False when there is none or outside Tauri. */
export async function focusWindow(label: string): Promise<boolean> {
   if (!inTauri()) return false;
   return invoke<boolean>("focus_window", { label });
}

/** Opens an app URL (e.g. `/?session=..&solo=1`) in a new window. Frontends can't import Tauri, so this lives here. With `pane=...` the host adds no Session header.
 * `remember`: the window opens at the frame last saved there (see `rememberWindowFrame`); `frame` wins over it.
 * `stable`: the label is used as given (it must hold only `a-zA-Z0-9-/:_`), so a window with it already open is focused instead of opening a second one.
 * `quiet`: the window opens without taking focus.
 * `overlayTitleBar`: the traffic lights sit inside the page, like the main window; the page must leave 92px free on the left of a top bar `titleBarHeight` high (default 52px); the lights are centered in it. */
export async function openWindow(
   label: string,
   url: string,
   opts: {
      title: string;
      width?: number;
      height?: number;
      remember?: FrameStore;
      frame?: Frame;
      stable?: boolean;
      quiet?: boolean;
      overlayTitleBar?: boolean;
      titleBarHeight?: number;
   },
) {
   if (opts.quiet) url = withQuery(url, QUIET_PARAM, "1");
   if (!inTauri()) {
      // A named target reuses the tab, like a stable label reuses the window.
      window.open(url, opts.stable ? label : "_blank");
      return;
   }
   const [{ WebviewWindow }, { LogicalPosition }] = await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/dpi"),
   ]);
   // Already open: focus it (a quiet open leaves it as it is).
   if (
      opts.stable &&
      (opts.quiet ? await WebviewWindow.getByLabel(label) : await focusWindow(label))
   )
      return;
   const frame = opts.frame ?? (opts.remember ? frameStore(opts.remember).get() : null);
   // A label can hold only `a-zA-Z0-9-/:_`; reusing one focuses nothing, so add a counter.
   const safe = opts.stable
      ? label
      : `${label.replace(/[^a-zA-Z0-9\-/:_]/g, "_")}-${Date.now().toString(36)}`;
   const w = new WebviewWindow(safe, {
      url,
      title: opts.title,
      width: frame?.width ?? opts.width ?? 1200,
      height: frame?.height ?? opts.height ?? 800,
      ...(frame && { x: frame.x, y: frame.y }),
      visible: false,
      ...(opts.quiet && { focus: false }),
      ...(opts.overlayTitleBar && {
         titleBarStyle: "overlay" as const,
         hiddenTitle: true,
         // 28 centers the lights in a 52px bar; `y` moves them 1:1, so a shorter bar takes half the difference.
         trafficLightPosition: new LogicalPosition(18, 28 - (52 - (opts.titleBarHeight ?? 52)) / 2),
      }),
   });
   w.once("tauri://error", (e) => console.error("window create failed", e));
}

/** `url` (an app path like `/?a=1`) with `name=value` added to its query. */
function withQuery(url: string, name: string, value: string): string {
   const [path = "", hash] = url.split("#", 2);
   const sep = path.includes("?") ? "&" : "?";
   return `${path}${sep}${encodeURIComponent(name)}=${encodeURIComponent(value)}${hash === undefined ? "" : `#${hash}`}`;
}

/** Shows a file in the system file manager (Tauri only; frontends can't import Tauri, so this lives here). */
export async function revealPath(path: string): Promise<void> {
   const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
   await revealItemInDir(path);
}

/** Saves this window's place and size to `store` (a key, or the caller's own store) whenever it moves or resizes, for `openWindow({ remember: store })`. Returns a cleanup. */
export function rememberWindowFrame(store: FrameStore): () => void {
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
            frameStore(store).set(frame);
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
 * Runs `cb` when the user closes this window (Tauri: the red X or Cmd+W; quitting the app raises no
 * close request). The close goes on. In a browser: the page is left (`pagehide`). Returns a cleanup.
 */
export function onWindowClose(cb: () => void): () => void {
   if (!inTauri()) {
      window.addEventListener("pagehide", cb);
      return () => window.removeEventListener("pagehide", cb);
   }
   let off = false;
   let unlisten: (() => void) | undefined;
   void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const u = await getCurrentWindow().onCloseRequested(() => cb());
      if (off) u();
      else unlisten = u;
   });
   return () => {
      off = true;
      unlisten?.();
   };
}

/** Closes this page's window without a close request (Tauri: destroys it; a browser: `window.close()`). */
export async function closeCurrentWindow(): Promise<void> {
   if (!inTauri()) {
      window.close();
      return;
   }
   const { getCurrentWindow } = await import("@tauri-apps/api/window");
   await getCurrentWindow().destroy();
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
