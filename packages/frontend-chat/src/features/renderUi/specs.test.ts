import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { components, ORDER } from "./catalog";

const CATALOG = ["catalog", "errors", "frontendTools", "schema", "sources", "tools", "types"];

// The reducer and the manifest read the render_ui catalog (`CATALOG` below and the `*.spec.ts` files).
// They must stay pure: importing a renderer from there pulls React components into the reducer and
// makes an import cycle (reducer -> tools -> catalog -> renderer -> ToolCard -> reducer) that breaks the app at load.
const allowed = (spec: string) =>
   spec === "jsonv-ts" || spec === "./shared" || /^\.\/\w+\.spec$/.test(spec);

const importsOf = (file: string) =>
   [...readFileSync(file, "utf8").matchAll(/^(?:import|export)[^;]*?from\s+"([^"]+)"/gms)].map(
      (m) => m[1],
   );

describe("render_ui specs", () => {
   const dir = __dirname;
   const files = [
      ...readdirSync(dir)
         .filter((f) => f.endsWith(".spec.ts") || f === "shared.ts")
         .map((f) => join(dir, f)),
   ];

   it("import nothing but the schema library and each other", () => {
      for (const f of files) {
         for (const spec of importsOf(f)) expect(allowed(spec), `${f} imports ${spec}`).toBe(true);
      }
   });

   it("the catalog files read only the specs and each other, never a renderer", () => {
      for (const name of CATALOG) {
         for (const spec of importsOf(join(dir, `${name}.ts`))) {
            if (spec.startsWith("./"))
               expect(spec, `${name}.ts must import ./<group>.spec or a catalog file`).toMatch(
                  /^\.\/(\w+\.spec|shared|catalog|errors|frontendTools|schema|sources|tools|types)$/,
               );
         }
      }
   });

   it("ORDER names only components of the catalog", () => {
      for (const n of ORDER) expect(Object.keys(components), `ORDER has ${n}`).toContain(n);
   });
});
