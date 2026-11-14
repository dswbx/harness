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
   layerViolation,
   leaks,
   uiViolation,
} from "./boundaries";

/**
 * Frontend files allowed to touch raw payloads, with the reason. Everything else goes through
 * the typed Event fields or `@harness/api` helpers.
 */
const RAW_ALLOWED: Record<string, string> = {
   "frontend-chat/src/state/slices/timeline.ts":
      "folds Events: stores raw_input/raw_output for the raw JSON view, and hands raw_input to the @harness/api fallback for old logs",
   "frontend-chat/src/features/toolDisplay/label.ts":
      "known leak: reads rawInput/rawOutput and the mcp__server__tool title convention for step labels; to be replaced by typed core tool fields",
   "frontend-chat/src/features/toolDisplay/fence.ts":
      "known leak: reads rawInput.command to show an execute call's command line; to be replaced by a typed core tool field",
   "frontend-chat/src/features/toolDisplay/TraceDisplay.tsx":
      "known leak: reads rawInput/rawOutput (memo deps, presence checks, the raw JSON view) and the mcp__ title prefix; the raw JSON view may stay, the rest moves to typed core tool fields",
   "frontend-chat/src/features/toolDisplay/ToolCard.tsx":
      "known leak: passes rawInput to commandOf and shows rawInput/rawOutput in the raw JSON view; the command moves to a typed core tool field, the raw JSON view may stay",
};

/** frontend-chat layering edges (`file -> target`, relative to its src/) that break the layer rule today. New ones must not. */
const LAYER_ALLOWED: Record<string, string> = {
   "features/sideChats/SidePanel.tsx -> shell/panelLayout":
      "known: to be cut when the panel contract lands",
   "panels/PanelHeader.tsx -> shell/panelLayout": "known: to be cut when the panel contract lands",
   "state/slices/timeline.ts -> features/prompt/configGroups":
      "known: to be cut when the panel contract lands",
   "state/slices/timeline.ts -> features/renderUi/tools":
      "known: to be cut when the panel contract lands",
   "state/types.ts -> features/renderUi/tools": "known: to be cut when the panel contract lands",
   "state/slices/plans.ts -> features/review/reviewComments":
      "known: to be cut when the panel contract lands",
};

/** App files that break the Frontend-package rule today, with the reason. New files must not. */
const APP_ALLOWED: Record<string, string> = {
   "app/src/mock/events.ts":
      "known: to move behind the Frontend contract (imports a Frontend's fixture by relative path)",
   "app/src/App.tsx":
      "known: to move behind the Frontend contract (imports more than `frontend` from a Frontend package)",
   "app/src/settings/SettingsDialog.tsx":
      "known: to move behind the Frontend contract (imports more than `frontend` from a Frontend package)",
   "app/src/appearance/AppearancePanel.tsx":
      "known: to move behind the Frontend contract (imports more than `frontend` from a Frontend package)",
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
if (bad) process.exit(1);
console.log("import boundaries ok");
