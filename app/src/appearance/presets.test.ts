import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, loadPresets, resolveVars, THEMES } from "./appearance";
import { importPresets, PRESET_INDEX, THEME_TOKENS, type ThemePreset } from "./presets";
import data from "./presets.json";

const presets = data as unknown as Record<string, ThemePreset>;
beforeAll(() => loadPresets());

describe("preset data", () => {
   it("the index (ids, names, order) and the token names match the data", () => {
      expect(PRESET_INDEX.map(([id, label]) => [id, label])).toEqual(
         Object.entries(presets).map(([id, p]) => [id, p.label]),
      );
      expect(THEME_TOKENS).toEqual([
         ...new Set(
            Object.values(presets).flatMap((p) => [
               ...Object.keys(p.light),
               ...Object.keys(p.dark),
            ]),
         ),
      ]);
      expect(THEMES.map((t) => t.id)).toEqual(["default", ...Object.keys(presets)]);
   });

   it("loads the same data as the file", async () => {
      expect(await importPresets()).toEqual(presets);
   });

   // Recorded from the presets as TS (before they became data): every preset's resolved vars, both modes, with the theme's
   // own fonts and with explicit font choices. Changing a value, a name's order or the resolving breaks it.
   it("resolves to the same CSS vars as the presets did as code", () => {
      const entries: [string, Record<string, string>, Record<string, string>][] = [];
      for (const id of Object.keys(presets)) {
         for (const font of ["theme", "inter"]) {
            const a = {
               ...DEFAULT_APPEARANCE,
               theme: id,
               font,
               mono: font === "theme" ? "theme" : "jetbrains-mono",
            };
            entries.push([`${id}|${font}`, resolveVars(a, false), resolveVars(a, true)]);
         }
      }
      expect(entries).toHaveLength(84);
      expect(createHash("sha256").update(JSON.stringify(entries)).digest("hex")).toBe(
         "b4fd53ba7fb176934bf527f036f10add56d56417dedfed91438692f5df2e778e",
      );
   });
});
