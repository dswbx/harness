// `bun run dev`: `tauri dev` on the first free port from 1420, so several checkouts (worktrees) can run at once.
// Vite gets the port from HARNESS_DEV_PORT (inherited through beforeDevCommand), Tauri via a devUrl override.
import { createServer } from "node:net";

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => s.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });

let port = 1420;
while (!(await free(port))) port++;
if (port !== 1420) console.log(`port 1420 taken, using ${port}`);

const config = JSON.stringify({ build: { devUrl: `http://localhost:${port}` } });
const proc = Bun.spawn(["tauri", "dev", "--config", config, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, HARNESS_DEV_PORT: String(port) },
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => proc.kill(sig));
process.exit(await proc.exited);
