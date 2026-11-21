import type { Browser } from "@playwright/test";

/** Transparent room around the window for its shadow (CSS px). */
const MARGIN = 36;
/** Window corner radius (CSS px), like a macOS window. */
const RADIUS = 10;
/**
 * The traffic lights: Tauri's `trafficLightPosition` (x 18, y 26, `crates/harness-tauri/tauri.conf.json`) puts
 * the close button's left edge at x 18 and the row's center at y 26. 12 px dots, 20 px apart.
 */
const LIGHTS = { x: 18, cy: 26, size: 12, gap: 20 };
const LIGHT_COLORS = [
   ["#ff5f57", "#e0443e"],
   ["#febc2e", "#dea123"],
   ["#28c840", "#1aab29"],
];

/**
 * Draws a raw screenshot (taken at `scale`) as a macOS window: rounded corners, a thin border, a soft shadow on a
 * transparent background and, for a main window, the traffic lights. Rendered by WebKit itself, so no image library.
 */
export async function frameShot(
   browser: Browser,
   raw: Buffer,
   o: { width: number; height: number; scale: number; lights: boolean },
): Promise<Buffer> {
   const page = await browser.newPage({
      viewport: { width: o.width + 2 * MARGIN, height: o.height + 2 * MARGIN },
      deviceScaleFactor: o.scale,
   });
   const lights = o.lights
      ? LIGHT_COLORS.map(
           ([fill, edge], i) =>
              `<i style="left:${LIGHTS.x + i * LIGHTS.gap}px;top:${LIGHTS.cy - LIGHTS.size / 2}px;background:${fill};box-shadow:inset 0 0 0 0.5px ${edge}"></i>`,
        ).join("")
      : "";
   // A dark outer edge and a faint light inner one, like a dark macOS window.
   const edge = "0 0 0 1px rgba(0,0,0,.85), inset 0 0 0 1px rgba(255,255,255,.14)";
   await page.setContent(`<!doctype html>
<style>
   html, body { margin: 0; background: transparent; }
   .win { position: absolute; left: ${MARGIN}px; top: ${MARGIN}px; width: ${o.width}px; height: ${o.height}px;
      border-radius: ${RADIUS}px; overflow: hidden;
      box-shadow: 0 12px 24px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3); }
   .win img { display: block; width: 100%; height: 100%; }
   .edge { position: absolute; inset: 0; border-radius: ${RADIUS}px; box-shadow: ${edge}; pointer-events: none; }
   i { position: absolute; width: ${LIGHTS.size}px; height: ${LIGHTS.size}px; border-radius: 50%; }
</style>
<div class="win"><img src="data:image/png;base64,${raw.toString("base64")}">${lights}<div class="edge"></div></div>`);
   await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
   const png = await page.screenshot({ omitBackground: true });
   await page.close();
   return png;
}
