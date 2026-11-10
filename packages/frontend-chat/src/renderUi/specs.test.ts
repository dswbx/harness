import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The reducer and the manifest read the render_ui catalog (`tools.ts` and the `*.spec.ts` files).
// They must stay pure: importing a renderer from there pulls React components into the reducer and
// makes an import cycle (reducer -> tools -> renderer -> ToolCard -> reducer) that breaks the app at load.
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

   it("tools.ts reads only the specs, never a renderer", () => {
      for (const spec of importsOf(join(dir, "..", "tools.ts"))) {
         if (spec.startsWith("./renderUi/"))
            expect(spec, "tools.ts must import ./renderUi/<group>.spec").toMatch(
               /^\.\/renderUi\/(\w+\.spec|shared)$/,
            );
      }
   });
});
