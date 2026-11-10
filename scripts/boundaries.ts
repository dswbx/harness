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
   [/\brawInput\./, "reads rawInput"],
   [/\braw_input\b/, "reads raw_input"],
   [/\brawOutput\./, "reads rawOutput"],
   [/\braw_output\b/, "reads raw_output"],
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
