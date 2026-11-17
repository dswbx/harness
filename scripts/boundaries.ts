// Pure checks for the Frontend boundary (ADR 0012, ADR 0001), used by check-boundaries.ts.
import { dirname, resolve } from "node:path";

/** Imports every Frontend may use besides its own files and the deps its package.json declares. */
const ALWAYS = new Set(["@harness/api", "@harness/ui", "react", "react-dom", "react/jsx-runtime"]);

/** The package name of a bare import: `@a/b/c` -> `@a/b`, `a/b` -> `a`. */
function packageName(spec: string): string {
   const parts = spec.split("/");
   return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Why `spec`, imported by `file` in the package at `root`, is not allowed; null when it is. */
export function importViolation(
   spec: string,
   file: string,
   root: string,
   declared: ReadonlySet<string>,
): string | null {
   if (spec.startsWith(".")) {
      return resolve(dirname(file), spec).startsWith(`${root}/`)
         ? null
         : "relative import leaves the package";
   }
   if (spec.startsWith("@harness/api/"))
      return "@harness/api subpaths (the mock) are for tests only";
   if (ALWAYS.has(spec) || ALWAYS.has(packageName(spec))) return null;
   if (declared.has(packageName(spec))) return null;
   return "not @harness/api, @harness/ui, react or a dependency declared in this package.json";
}

/** Source without `//` and block comments (strings are not parsed: good enough for a guard). */
export function stripComments(src: string): string {
   return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Reads of raw Agent payloads and Agent names (ADR 0012). Frontends use the typed Event fields,
 * or the `@harness/api` helpers for logs recorded before them.
 */
const LEAKS: [RegExp, string][] = [
   // Any read: a property (`x.rawInput`, also through a cast or as an argument) or a bare
   // identifier. Not a definition (`rawInput: unknown`, `{ rawInput, .. }`, `rawInput?:`).
   [/\.rawInput\b|(?<![\w$.])rawInput\b(?!\s*[:,}?])/, "reads rawInput"],
   [/\braw_input\b/, "reads raw_input"],
   [/\.rawOutput\b|(?<![\w$.])rawOutput\b(?!\s*[:,}?])/, "reads rawOutput"],
   [/\braw_output\b/, "reads raw_output"],
   [/mcp__/, "parses an Agent's MCP tool-title convention"],
   [/claude|codex/i, "names an Agent"],
];

/** Line-level leaks in `src` (comments ignored): `[line, reason]`. */
export function leaks(src: string): [number, string][] {
   const out: [number, string][] = [];
   stripComments(src)
      .split("\n")
      .forEach((line, i) => {
         for (const [re, why] of LEAKS) if (re.test(line)) out.push([i + 1, why]);
      });
   return out;
}

/** The module specifiers a source file imports (static, side-effect, re-export and dynamic). */
export function importSpecs(src: string): string[] {
   const code = stripComments(src);
   const re =
      /(?:^|\n)[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)[ \t]*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
   return [...code.matchAll(re)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}

/** Why a file in `packages/ui/src` may not import `spec`; null when it may. The UI kit knows no host API and no Frontend. */
export function uiViolation(spec: string): string | null {
   if (spec === "@harness/api" || spec.startsWith("@harness/api/"))
      return "@harness/ui must not depend on @harness/api";
   if (spec.startsWith("@harness/frontend-")) return "@harness/ui must not import a Frontend";
   return null;
}

/** localStorage / sessionStorage used as an API (not a word in a string list). */
const STORAGE_USE = /(?<![\w|])(?:local|session)Storage\b(?!\s*\|)/;

/** Whether `src` (comments ignored) touches web storage directly: only `@harness/api`'s storage helper may. */
export const usesWebStorage = (src: string): boolean => STORAGE_USE.test(stripComments(src));

/** Why the `@harness/api` entry may not import `spec`; null when it may. The browser mock stays out of the production bundle. */
export function apiEntryViolation(spec: string): string | null {
   return /^\.\/mock(\/|$)/.test(spec)
      ? "the entry must not import the mock (use @harness/api/mock)"
      : null;
}

/**
 * What a static import or re-export takes from its module: `[spec, names]`, with the exported
 * names (`default` for a default import, `*` for a namespace or `export *`), `[]` for a bare
 * `import "x"`. Dynamic imports are `[spec, null]` (any name).
 */
export function importedNames(src: string): [string, string[] | null][] {
   const code = stripComments(src);
   const out: [string, string[] | null][] = [];
   const re =
      /(?:^|\n)[ \t]*(?:import|export)\b([^'"`;]*?)\bfrom\s*["']([^"']+)["']|(?:^|\n)[ \t]*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
   for (const m of code.matchAll(re)) {
      if (m[2] !== undefined) out.push([m[2], clauseNames(m[1]!)]);
      else if (m[3] !== undefined) out.push([m[3], []]);
      else out.push([m[4]!, null]);
   }
   return out;
}

/** The exported names an import/export clause (`type { a as b }`, `X, * as ns`) takes. */
function clauseNames(clause: string): string[] {
   const names: string[] = [];
   const braces = clause.match(/\{([^}]*)\}/);
   for (const part of braces?.[1]?.split(",") ?? []) {
      const name = part
         .trim()
         .replace(/^type\s+/, "")
         .split(/\s+as\s+/)[0]!
         .trim();
      if (name) names.push(name);
   }
   const rest = clause.replace(/\{[^}]*\}/, "").replace(/^\s*type\s+/, "");
   if (/\*/.test(rest)) names.push("*");
   else if (/[\w$]/.test(rest)) names.push("default");
   return names;
}

/** The one name the app may take from a Frontend package. */
const FRONTEND_EXPORT = "frontend";

/**
 * Why a file in `app/src` (at `file`, repo at `repoRoot`) may not import `spec` taking `names`
 * (see `importedNames`); null when it may. A Frontend package is reached through its root entry
 * only and only for its `frontend` object (the Frontend contract), never by a path into it.
 */
export function appViolation(
   spec: string,
   names: readonly string[] | null,
   file: string,
   repoRoot: string,
): string | null {
   if (spec.startsWith(".")) {
      return resolve(dirname(file), spec).startsWith(`${repoRoot}/packages/`)
         ? "relative path into packages/"
         : null;
   }
   const pkg = packageName(spec);
   if (!pkg.startsWith("@harness/frontend-")) return null;
   if (spec !== pkg) return "deep import into a Frontend package, use its root entry";
   if (names === null || names.some((n) => n !== FRONTEND_EXPORT))
      return `takes more than \`${FRONTEND_EXPORT}\` from a Frontend package`;
   return null;
}

/**
 * Layering inside `frontend-chat/src`: `features/`, `state/`, `panels/` and `lib/` are what another
 * Frontend could reuse, `shell/` is the chat arrangement. `file` and `target` are paths relative to
 * `src` (target without extension). Why the import is not allowed; null when it is.
 */
export function layerViolation(file: string, target: string): string | null {
   const from = file.split("/")[0] ?? "";
   const to = target.split("/")[0];
   if (to === "shell" && ["features", "state", "panels", "lib"].includes(from))
      return `${from}/ must not import shell/`;
   if (to === "features" && ["state", "panels", "lib"].includes(from))
      return `${from}/ must not import features/`;
   return null;
}

/**
 * Pure chat modules that could move to `@harness/api` when a second Frontend lands (paths relative
 * to `frontend-chat/src`): no React, nothing from `state/`. Only the files where this holds.
 */
export const PORTABLE_FILES = [
   "features/prRefs/prMenu.ts",
   "features/prRefs/prChip.ts",
   "features/prompt/commands.ts",
];

/** Why a `PORTABLE_FILES` file (relative to `src`) may not import `spec`; null when it may. */
export function portableViolation(file: string, spec: string): string | null {
   if (spec === "react" || spec === "react-dom" || spec.startsWith("react/"))
      return "portable module must stay React-free";
   if (spec.startsWith(".") && resolve("/src", dirname(file), spec).startsWith("/src/state/"))
      return "portable module must not import state/";
   return null;
}

/** Helpers that have one home; a second definition elsewhere is a diverging copy. `[name pattern, home file, use instead]`. */
const HOMES: [RegExp, string, string][] = [
   [/^base_?name$/i, "packages/api/src/derive/paths.ts", "baseName"],
   [/^folderName$/, "packages/api/src/derive/paths.ts", "baseName"],
   [/^(?:formatAge|relativeTime|relTime|timeAgo)$/, "packages/api/src/derive/time.ts", "formatAge"],
   [/^(?:errText|errorMessage|errMsg)$/, "packages/api/src/errors.ts", "errText"],
   [/^openExternal(?:Url|Link)?$/, "packages/api/src/platform/window.ts", "openExternalUrl"],
   [/^plurali?z?e?$/, "packages/frontend-chat/src/lib/plural.ts", "plural"],
];

/** `catch (e) { x(e instanceof Error ? e.message : String(e)) }` and its variants. */
const INLINE_ERROR_TEXT = /\binstanceof\s+Error\s*\?\s*[\w$]+\.message\s*:/;
const DEFINITION = /\b(?:function\s+|(?:const|let|var)\s+)([\w$]+)\s*(?:[=(<:])/g;

/**
 * Known duplicates in `src` (comments ignored) of the file `rel` (repo-relative): the inline
 * error-text ternary, or a definition of a helper that lives elsewhere. `[line, reason]`.
 */
export function knownDuplicates(src: string, rel: string): [number, string][] {
   const out: [number, string][] = [];
   stripComments(src)
      .split("\n")
      .forEach((line, i) => {
         if (rel !== "packages/api/src/errors.ts" && INLINE_ERROR_TEXT.test(line))
            out.push([i + 1, "inline error text, use errText from @harness/api"]);
         for (const m of line.matchAll(DEFINITION)) {
            for (const [re, home, use] of HOMES) {
               if (re.test(m[1]!) && rel !== home)
                  out.push([i + 1, `defines ${m[1]}, use ${use} (${home})`]);
            }
         }
      });
   return out;
}
