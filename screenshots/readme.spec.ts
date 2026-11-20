import { mkdir, writeFile } from "node:fs/promises";
import { test } from "@playwright/test";
import { frameShot } from "./frame";
import { SHOTS } from "./shots";

const OUT = new URL("../docs/images/readme/", import.meta.url);
/** Every shot starts at the same time (then runs): the mock's relative times ("2d", "now") and dates stay put. */
const NOW = new Date("2026-11-20T10:00:00Z");
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 2;

// No motion, no caret, no scrollbars: the same pixels on every run.
const STILL_CSS = `
   *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
   ::-webkit-scrollbar { display: none !important; }
   [data-radix-scroll-area-scrollbar] { display: none !important; }
`;

for (const shot of SHOTS)
   for (const scheme of ["dark", "light"] as const)
      test(`${shot.name}-${scheme}`, async ({ browser, baseURL }) => {
         const viewport = shot.viewport ?? VIEWPORT;
         // A fresh context per shot: clean localStorage.
         const context = await browser.newContext({
            baseURL,
            viewport,
            deviceScaleFactor: SCALE,
            colorScheme: scheme,
            reducedMotion: "reduce",
            locale: "en-US",
            timezoneId: "UTC",
         });
         // The default appearance (Harness theme, following the system's light or dark).
         await context.addInitScript(() => {
            localStorage.setItem(
               "harness.appearance",
               JSON.stringify({ theme: "harness", mode: "system" }),
            );
         });
         const page = await context.newPage();
         await page.clock.install({ time: NOW });
         await page.goto(shot.path ?? "/");
         await page.addStyleTag({ content: STILL_CSS });
         await page.waitForLoadState("networkidle");
         await shot.setup?.(page);
         // Away from anything with a hover state, tooltip or focus ring.
         await page.mouse.move(4, 4);
         await settle(page);
         // After settling: some views take focus late (the Terminal), and a focused Terminal blinks its cursor.
         await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
         await page.waitForTimeout(300);
         const raw = await page.screenshot({ omitBackground: shot.frame === "none" });
         const png =
            shot.frame === "none"
               ? raw
               : await frameShot(browser, raw, {
                    ...viewport,
                    scale: SCALE,
                    dark: scheme === "dark",
                    lights: true,
                 });
         await mkdir(OUT, { recursive: true });
         await writeFile(new URL(`${shot.name}-${scheme}.png`, OUT), png);
         await context.close();
      });

/** Fonts loaded, network quiet, streamed replies done, two frames painted. */
async function settle(page: import("@playwright/test").Page) {
   await page.evaluate(() => document.fonts.ready);
   await page.waitForLoadState("networkidle");
   await page.waitForTimeout(1200);
   await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
   );
}
