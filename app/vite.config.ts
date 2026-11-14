import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

// git-diff-view's highlighter registers all ~190 highlight.js languages (~1 MB minified). Lowlight's `common` set (~37) is enough.
const lowlightCommon: Plugin = {
   name: "lowlight-common",
   transform(code, id) {
      if (!id.includes("@git-diff-view/lowlight") || !code.includes("createLowlight(all)")) return;
      return code
         .replace("{ createLowlight, all }", "{ createLowlight, common }")
         .replace("createLowlight(all)", "createLowlight(common)");
   },
};

// The cached theme vars (appearance.ts) are keyed on the files that produce them.
const themeVarsVersion = createHash("sha1")
   .update(readFileSync(new URL("./src/appearance/presets.json", import.meta.url)))
   .update(readFileSync(new URL("./src/appearance/appearance.ts", import.meta.url)))
   .digest("hex")
   .slice(0, 12);

// Under `bun run dev` (scripts/dev.ts) Tauri's devUrl points at HARNESS_DEV_PORT, so it must be exactly that.
// Alone (browser + mock transport) any free port from 1420 will do.
const tauriPort = process.env.HARNESS_DEV_PORT;
export default defineConfig({
   plugins: [react(), tailwindcss(), lowlightCommon],
   define: { __THEME_VARS_VERSION__: JSON.stringify(themeVarsVersion) },
   clearScreen: false,
   server: {
      port: tauriPort ? Number(tauriPort) : 1420,
      strictPort: !!tauriPort,
      host: "127.0.0.1",
   },
});
