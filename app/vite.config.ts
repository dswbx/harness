import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// git-diff-view's highlighter registers all ~190 highlight.js languages (~1 MB minified). Lowlight's `common` set (~37) is enough.
const lowlightCommon: Plugin = {
  name: "lowlight-common",
  transform(code, id) {
    if (!id.includes("@git-diff-view/lowlight") || !code.includes("createLowlight(all)")) return;
    return code.replace("{ createLowlight, all }", "{ createLowlight, common }").replace("createLowlight(all)", "createLowlight(common)");
  },
};

// Under `bun run dev` (scripts/dev.ts) Tauri's devUrl points at HARNESS_DEV_PORT, so it must be exactly that.
// Alone (browser + mock transport) any free port from 1420 will do.
const tauriPort = process.env.HARNESS_DEV_PORT;
export default defineConfig({
  plugins: [react(), tailwindcss(), lowlightCommon],
  clearScreen: false,
  server: { port: tauriPort ? Number(tauriPort) : 1420, strictPort: !!tauriPort, host: "127.0.0.1" },
});
