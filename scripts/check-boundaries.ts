// Frontends may import only their own files, @harness/api, @harness/ui, react and the deps their
// own package.json declares (so they stay portable to another host), and must not read raw Agent
// payloads or name Agents (ADR 0012).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
   apiEntryViolation,
   appViolation,
   importedNames,
   importSpecs,
   importViolation,
   knownDuplicates,
   layerViolation,
   leaks,
   PORTABLE_FILES,
   portableViolation,
   uiViolation,
   usesWebStorage,
} from "./boundaries";

/**
 * Frontend files allowed to touch raw payloads, with the reason. Everything else goes through
 * the typed Event fields or `@harness/api` helpers.
 */
const RAW_ALLOWED: Record<string, string> = {
   "frontend-chat/src/state/slices/timeline.ts":
      "folds Events: stores raw_input/raw_output for the raw JSON view, and hands raw_input to the @harness/api fallback for old logs",
   "frontend-chat/src/state/syntheticLog.ts":
      "test helper (builds a synthetic log for the reducer benchmark and equivalence tests), not shipped",
   "frontend-chat/src/features/toolDisplay/raw.ts":
      "the raw JSON viewers (a call's Input and Output folds) read rawInput/rawOutput as the Agent sent them",
};

/** frontend-chat layering edges (`file -> target`, relative to its src/) that break the layer rule today. New ones must not. */
const LAYER_ALLOWED: Record<string, string> = {};

/** App files that break the Frontend-package rule today, with the reason. New files must not. */
const APP_ALLOWED: Record<string, string> = {
   "app/src/mock/events.ts":
      "known: to move behind the Frontend contract (imports a Frontend's fixture by relative path)",
};

/**
 * The only files that may use localStorage/sessionStorage directly (paths from the repo root), with
 * the reason. Everything else goes through `storedValue` and the `STORAGE_KEYS` registry.
 */
const STORAGE_ALLOWED: Record<string, string> = {
   "packages/api/src/platform/storage.ts": "the helper itself",
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
      if (pkg === "frontend-chat") {
         const src = resolve(root, "src");
         for (const spec of importSpecs(readFileSync(file, "utf8"))) {
            if (!spec.startsWith(".")) continue;
            const from = relative(src, file);
            const to = relative(src, resolve(dirname(file), spec));
            const why = layerViolation(from, to);
            if (why && !(`${from} -> ${to}` in LAYER_ALLOWED)) {
               console.error(`${from} -> ${to}: ${why}`);
               bad++;
            }
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

// Pure chat modules meant to move to @harness/api later stay React-free and state-free.
for (const f of PORTABLE_FILES) {
   for (const spec of importSpecs(readFileSync(resolve("packages/frontend-chat/src", f), "utf8"))) {
      const why = portableViolation(f, spec);
      if (why) {
         console.error(`${f}: forbidden import "${spec}": ${why}`);
         bad++;
      }
   }
}

// The UI kit knows neither the host API nor a Frontend.
for (const file of walk(resolve("packages/ui/src"))) {
   if (/\.test\.tsx?$/.test(file)) continue;
   for (const spec of importSpecs(readFileSync(file, "utf8"))) {
      const why = uiViolation(spec);
      if (why) {
         console.error(`${file}: forbidden import "${spec}": ${why}`);
         bad++;
      }
   }
}

// The API entry stays free of the mock.
for (const spec of importSpecs(readFileSync("packages/api/src/index.ts", "utf8"))) {
   const why = apiEntryViolation(spec);
   if (why) {
      console.error(`packages/api/src/index.ts: forbidden import "${spec}": ${why}`);
      bad++;
   }
}

// The app reaches a Frontend only through its root entry and its `frontend` object.
for (const file of walk(resolve("app/src"))) {
   if (/\.test\.tsx?$/.test(file)) continue;
   if (relative(resolve("."), file) in APP_ALLOWED) continue;
   for (const [spec, names] of importedNames(readFileSync(file, "utf8"))) {
      const why = appViolation(spec, names, file, resolve("."));
      if (why) {
         console.error(`${file}: forbidden import "${spec}": ${why}`);
         bad++;
      }
   }
}

// Web storage goes through the helper, so keys stay declared and writes report failures.
for (const root of ["app/src", ...readdirSync("packages").map((p) => `packages/${p}/src`)]) {
   let files: string[];
   try {
      files = walk(resolve(root));
   } catch {
      continue;
   }
   for (const file of files) {
      const rel = relative(resolve("."), file);
      if (/\.test\.tsx?$/.test(file) || rel in STORAGE_ALLOWED) continue;
      if (usesWebStorage(readFileSync(file, "utf8"))) {
         console.error(`${rel}: uses localStorage/sessionStorage directly, use storedValue`);
         bad++;
      }
   }
}

/** Files that may keep a duplicate of a helper that has a home, with the reason. Keep empty. */
const DUPLICATES_ALLOWED: Record<string, string> = {};

// One implementation per small helper (error text, basename, age, external links).
for (const root of ["app/src", ...readdirSync("packages").map((p) => `packages/${p}/src`)]) {
   let files: string[];
   try {
      files = walk(resolve(root));
   } catch {
      continue;
   }
   for (const file of files) {
      const rel = relative(resolve("."), file);
      if (/\.test\.tsx?$/.test(file) || rel in DUPLICATES_ALLOWED || rel.endsWith("/generated.ts"))
         continue;
      for (const [line, why] of knownDuplicates(readFileSync(file, "utf8"), rel)) {
         console.error(`${rel}:${line}: ${why}`);
         bad++;
      }
   }
}
if (bad) process.exit(1);
console.log("import boundaries ok");
