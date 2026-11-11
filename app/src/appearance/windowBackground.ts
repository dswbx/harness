import { inTauri } from "@harness/api";
import { invoke } from "@tauri-apps/api/core";

/** The page background as sRGB bytes (the theme may use any CSS color), or null if it has none. */
function backgroundRgb(): [number, number, number] | null {
   const canvas = document.createElement("canvas");
   canvas.width = canvas.height = 1;
   const ctx = canvas.getContext("2d", { willReadFrequently: true });
   if (!ctx) return null;
   ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
   ctx.fillRect(0, 0, 1, 1);
   const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
   return a === 255 ? [r, g, b] : null;
}

const reveal = () =>
   void invoke("reveal_window").catch((e) => console.error("reveal window failed", e));

let last: string | undefined;

/**
 * Gives the native window the theme's background, so it is what shows until the webview paints
 * (never the webview's default white). With `show`, the hidden window goes on screen transparent
 * once that is set (a webview only renders on screen) and turns opaque after the page has painted.
 */
export function syncWindowBackground(show = false) {
   // The Quick overlay stays transparent and is shown by its shortcut (`overlay.rs`).
   if (!inTauri() || document.documentElement.classList.contains("overlay")) return;
   const rgb = backgroundRgb();
   const key = String(rgb);
   if (!show && key === last) return;
   last = key;
   void invoke("set_window_background", { rgb, show })
      .then(() => {
         if (show) requestAnimationFrame(() => requestAnimationFrame(reveal));
      })
      .catch((e) => console.error("set window background failed", e));
}
