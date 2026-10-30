import { describe, expect, it } from "vitest";
import { cleanValue, fromCss, fromRegistryItem, registryUrl, themeId } from "./importTheme";
import { normalize, normalizeThemes } from "./appearance";

const colors = { background: "oklch(0.92 0.02 88)", foreground: "oklch(0.235 0 0)", primary: "oklch(0.3 0 0)" };

describe("theme import", () => {
  it("turns tweakcn links into registry URLs", () => {
    expect(registryUrl("https://tweakcn.com/r/themes/cmlm03etv000204lh15608kec")).toBe("https://tweakcn.com/r/themes/cmlm03etv000204lh15608kec");
    expect(registryUrl(" https://tweakcn.com/themes/abc123 ")).toBe("https://tweakcn.com/r/themes/abc123");
    expect(registryUrl("https://tweakcn.com/r/themes/claude.json")).toBe("https://tweakcn.com/r/themes/claude");
    expect(registryUrl("https://tweakcn.com/editor/theme?theme=claude")).toBe("https://tweakcn.com/r/themes/claude");
    expect(registryUrl("https://example.com/r/theme.json")).toBe("https://example.com/r/theme.json");
    expect(registryUrl(":root { --background: red; }")).toBeNull();
    expect(() => registryUrl("http://tweakcn.com/r/themes/x")).toThrow("https");
    expect(() => registryUrl("https://tweakcn.com/editor/theme")).toThrow("tweakcn");
  });
  it("reads a registry item: shared theme vars in light, unknown keys and unsafe values dropped", () => {
    const t = fromRegistryItem({
      name: "Zen Inspired Theme",
      cssVars: {
        theme: { "font-sans": "\"Inter\", sans-serif", radius: "0.5rem", "tracking-wide": "calc(var(--tracking-normal) + 0.025em)" },
        light: { ...colors, card: "url(https://evil)", "made-up": "1" },
        dark: { background: "oklch(0.2 0 0)", foreground: "x; } body { display:none" },
      },
    }, "https://tweakcn.com/r/themes/x");
    expect(t).toEqual({
      label: "Zen Inspired Theme",
      light: { "font-sans": "\"Inter\", sans-serif", radius: "0.5rem", ...colors },
      dark: { background: "oklch(0.2 0 0)" },
      source: "https://tweakcn.com/r/themes/x",
    });
    expect(() => fromRegistryItem({ name: "x", cssVars: { light: {} } })).toThrow("No theme colors");
    expect(() => fromRegistryItem({ name: "x" })).toThrow("cssVars");
  });
  it("reads theme CSS as tweakcn prints it", () => {
    const css = `@import "tailwindcss";\n@custom-variant dark (&:is(.dark *));\n/* light */\n:root {\n  --background: ${colors.background};\n  --foreground: ${colors.foreground};\n  --primary: ${colors.primary};\n  --radius: 0.5rem;\n}\n.dark {\n  --background: oklch(0.2 0 0);\n}\n@theme inline {\n  --color-background: var(--background);\n}`;
    expect(fromCss(css, " Zen ")).toEqual({ label: "Zen", light: { ...colors, radius: "0.5rem" }, dark: { background: "oklch(0.2 0 0)" } });
    expect(() => fromCss("body { color: red }", "x")).toThrow("No theme colors");
  });
  it("cleans values, makes unique ids, keeps imported theme ids", () => {
    expect(cleanValue(" #fff ")).toBe("#fff");
    for (const bad of ["a;b", "}", "url(x)", "@import x", "a\\b", "x".repeat(201), 3]) expect(cleanValue(bad)).toBeNull();
    const taken = new Set(["user-zen"]);
    expect(themeId("Zen!", (id) => taken.has(id))).toBe("user-zen-2");
    expect(themeId("???", () => false)).toBe("user-theme");
    expect(normalize({ theme: "user-zen" }).theme).toBe("user-zen");
    expect(normalize({ theme: "user-" }).theme).toBe("default");
    expect(normalizeThemes({ "user-zen": { label: "Zen", light: colors, dark: {} }, bad: { label: "B", light: {}, dark: {} }, "user-x": { label: 1 } })).toEqual({ "user-zen": { label: "Zen", light: colors, dark: {} } });
  });
});
