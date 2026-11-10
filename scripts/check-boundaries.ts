// Frontends may import only their own files, @harness/api, @harness/ui, react and the deps their
// own package.json declares (so they stay portable to another host), and must not read raw Agent
// payloads or name Agents (ADR 0012).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { importSpecs, importViolation, leaks } from "./boundaries";

/**
 * Frontend files allowed to touch raw payloads, with the reason. Everything else goes through
 * the typed Event fields or `@harness/api` helpers.
 */
const RAW_ALLOWED: Record<string, string> = {
   "frontend-chat/src/reducer.ts":
      "folds Events: stores raw_input/raw_output for the raw JSON view, and hands raw_input to the @harness/api fallback for old logs",
};

let bad = 0;

function walk(dir: string): string[] {
   return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === "node_modules" || f === "fixtures" ? [] : walk(p);
      return /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
   });
}

for (const pkg of readdirSync("packages").filter((d) => d.startsWith("frontend-"))) {
   const root = resolve("packages", pkg);
   const json = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
   const declared = new Set([
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
   ]);
   for (const file of walk(join(root, "src"))) {
      const src = readFileSync(file, "utf8");
      // Tests are not shipped: they may use vitest and read raw payloads.
      if (/\.test\.tsx?$/.test(file)) continue;
      for (const spec of importSpecs(src)) {
         const why = importViolation(spec, file, root, declared);
         if (why) {
            console.error(`${file}: forbidden import "${spec}": ${why}`);
            bad++;
         }
      }
      if (relative(resolve("packages"), file) in RAW_ALLOWED) continue;
      for (const [line, why] of leaks(src)) {
         console.error(
            `${file}:${line}: ${why}; use the typed Event fields or an @harness/api helper`,
         );
         bad++;
      }
   }
}
if (bad) process.exit(1);
console.log("frontend import boundaries ok");
