// Frontends may import only @harness/api, @harness/ui, react, their own deps and files inside their own package.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const forbidden = [/^@tauri-apps\//, /^@harness\/app$/, /^@harness\/frontend-/];
let bad = 0;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" ? [] : walk(p);
    return /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
  });
}

for (const pkg of readdirSync("packages").filter((d) => d.startsWith("frontend-"))) {
  const root = resolve("packages", pkg);
  for (const file of walk(join(root, "src"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      const escapes = spec.startsWith(".") && !resolve(dirname(file), spec).startsWith(root + "/");
      if (escapes || forbidden.some((r) => r.test(spec))) {
        console.error(`${file}: forbidden import "${spec}"`);
        bad++;
      }
    }
  }
}
if (bad) process.exit(1);
console.log("frontend import boundaries ok");
