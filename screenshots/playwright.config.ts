import { defineConfig } from "@playwright/test";

/** Port of the production build of the browser mock that the README screenshots use. */
export const PORT = 1434;

// README screenshots (`bun run screenshots`): the browser mock app (fixture Sessions, no Rust core) in WebKit, like Tauri on macOS.
export default defineConfig({
   testDir: ".",
   outputDir: "../test-results",
   fullyParallel: true,
   reporter: "list",
   timeout: 60_000,
   use: { baseURL: `http://127.0.0.1:${PORT}` },
   projects: [{ name: "webkit", use: { browserName: "webkit" } }],
   webServer: {
      // A production build: no DEV badge.
      command: `bunx vite build && bunx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
      cwd: "../app",
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
   },
});
