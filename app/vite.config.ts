import { readdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Connect, Plugin } from "vite";
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

// Dev server only, browser mock: `?scan` loads react-scan (highlights React renders) before React starts.
const reactScan: Plugin = {
   name: "react-scan",
   apply: "serve",
   transformIndexHtml: () => [
      {
         tag: "script",
         injectTo: "head-prepend",
         children:
            'if (new URLSearchParams(location.search).has("scan") && !("__TAURI_INTERNALS__" in window)) document.write(\'<script src="https://unpkg.com/react-scan@0.5.7/dist/auto.global.js"><\\/script>\')',
      },
   ],
};

// Dev and preview servers only: serves a Session Log (and its panel files) from this machine's data folders for `?replay=<id>`
// (app/src/mock/replay.ts). Listens on 127.0.0.1 only.
const sessionLog: Connect.NextHandleFunction = async (req, res, next) => {
   const m = /^\/__harness\/session-(log|panels)\/([0-9a-f-]{36})$/.exec(req.url ?? "");
   if (!m) return next();
   for (const home of new Set([homedir(), userInfo().homedir]))
      for (const dir of [".harness", ".harness-dev"]) {
         const session = `${home}/${dir}/sessions/${m[2]}`;
         try {
            if (m[1] === "log") {
               const log = await readFile(`${session}/log.jsonl`);
               res.setHeader("Content-Type", "application/x-ndjson");
               return res.end(log);
            }
            // The Session's panel source files (top level), as `{ name: content }`.
            const names = (await readdir(`${session}/panels`)).filter((n) =>
               /\.(md|html|json)$/.test(n),
            );
            const files = Object.fromEntries(
               await Promise.all(
                  names.map(async (n) => [n, await readFile(`${session}/panels/${n}`, "utf8")]),
               ),
            );
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(files));
         } catch {}
      }
   res.statusCode = 404;
   res.end();
};
const replayLogs: Plugin = {
   name: "replay-logs",
   configureServer: (s) => void s.middlewares.use(sessionLog),
   configurePreviewServer: (s) => void s.middlewares.use(sessionLog),
};

// Under `bun run dev` (scripts/dev.ts) Tauri's devUrl points at HARNESS_DEV_PORT, so it must be exactly that.
// Alone (browser + mock transport) any free port from 1420 will do.
const tauriPort = process.env.HARNESS_DEV_PORT;
export default defineConfig({
   plugins: [react(), tailwindcss(), lowlightCommon, reactScan, replayLogs],
   clearScreen: false,
   server: {
      port: tauriPort ? Number(tauriPort) : 1420,
      strictPort: !!tauriPort,
      host: "127.0.0.1",
      // Lets the page sample its own JS (`new Profiler(...)`, JS Self-Profiling API) when profiling the browser mock.
      headers: { "Document-Policy": "js-profiling" },
   },
});
