import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE, STORAGE_KEY, THEMES, applyAppearance, cleanFont, filterThemes, loadAppearance, mapFontStack, modeVars, normalize, resolveVars,
  saveAppearance, stepIndex, swatch, type Appearance,
} from "./appearance";
import { PRESETS } from "./presets";

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const a = (p: Partial<Appearance>): Appearance => ({ ...DEFAULT_APPEARANCE, ...p });

describe("load / save", () => {
  it("defaults when empty or bad JSON", () => {
    expect(loadAppearance(store())).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(store({ [STORAGE_KEY]: "{nope" }))).toEqual(DEFAULT_APPEARANCE);
    expect(loadAppearance(store({ [STORAGE_KEY]: "42" }))).toEqual(DEFAULT_APPEARANCE);
  });

  it("round-trips", () => {
    const s = store();
    const v = a({ theme: "claude", mode: "dark", font: "inter", mono: "geist-mono", fontSize: 16, chatFontSize: 15, leading: "loose", flow: "airy" });
    saveAppearance(s, v);
    expect(loadAppearance(s)).toEqual(v);
  });

  it("falls back per field and clamps size", () => {
    expect(normalize({ theme: "nope", mode: "dim", font: "comic", mono: "inter", fontSize: 40 })).toEqual(a({ fontSize: 18 }));
    expect(normalize({ theme: "toString", fontSize: 3 })).toEqual(a({ fontSize: 12 }));
    expect(normalize({ fontSize: 15.6, font: "system" })).toEqual(a({ fontSize: 16, font: "system" }));
    expect(normalize({ fontSize: "16" }).fontSize).toBe(14);
    expect(normalize({ chatFontSize: 99, leading: "huge", flow: 2 })).toEqual(a({ chatFontSize: 18 }));
  });

  it("custom fonts: trimmed, stripped, limited", () => {
    expect(normalize({ font: "custom", mono: "custom", customFont: "  Berkeley Mono, monospace ", customMono: 42 })).toEqual(
      a({ font: "custom", mono: "custom", customFont: "Berkeley Mono, monospace" }),
    );
    expect(normalize({ customFont: "x; } body { color: red" }).customFont).toBe("x  body  color: red");
    expect(normalize({ customFont: "a".repeat(500) }).customFont).toHaveLength(200);
    expect(cleanFont("Foo ")).toBe("Foo ");
  });
});

describe("resolveVars", () => {
  it("default theme sets only sizes and chat rhythm", () => {
    const chat = { "--chat-font-size": "14px", "--chat-leading": "1.6", "--chat-flow": "1.25em" };
    expect(resolveVars(DEFAULT_APPEARANCE, false)).toEqual({ "--app-font-size": "14px", ...chat });
    expect(resolveVars(a({ font: "geist", mono: "system", fontSize: 13 }), true)).toEqual({
      "--font-sans": '"Geist Variable", ui-sans-serif, system-ui, -apple-system, sans-serif',
      "--font-mono": "ui-monospace, monospace",
      "--app-font-size": "13px",
      ...chat,
    });
    expect(resolveVars(a({ chatFontSize: 16, leading: "regular", flow: "airy" }), false)).toMatchObject({
      "--chat-font-size": "16px", "--chat-leading": "1.75", "--chat-flow": "2em",
    });
  });

  it("preset vars per mode, theme fonts mapped to bundled families", () => {
    const light = resolveVars(a({ theme: "modern-minimal" }), false);
    expect(light["--background"]).toBe("#ffffff");
    expect(light["--font-sans"]).toBe('"Inter Variable", Inter, sans-serif');
    expect(light["--font-mono"]).toBe('"JetBrains Mono Variable", JetBrains Mono, monospace');
    const dark = resolveVars(a({ theme: "modern-minimal" }), true);
    expect(dark["--background"]).toBe("#171717");
    // dark omits fonts: falls back to light
    expect(dark["--font-sans"]).toBe('"Inter Variable", Inter, sans-serif');
  });

  it("explicit font overrides the theme font; spacing is skipped", () => {
    const v = resolveVars(a({ theme: "modern-minimal", font: "outfit" }), false);
    expect(v["--font-sans"]).toBe('"Outfit Variable", ui-sans-serif, system-ui, -apple-system, sans-serif');
    expect(Object.values(PRESETS).some((p) => "spacing" in p.light)).toBe(true);
    for (const id of Object.keys(PRESETS)) expect(resolveVars(a({ theme: id }), false)).not.toHaveProperty("--spacing");
  });
});

describe("custom font vars", () => {
  it("uses the text with system fallback, maps bundled names; empty = theme default", () => {
    expect(resolveVars(a({ font: "custom", customFont: "Inter, Arial" }), false)["--font-sans"]).toBe(
      '"Inter Variable", Inter, Arial, ui-sans-serif, system-ui, -apple-system, sans-serif',
    );
    expect(resolveVars(a({ mono: "custom", customMono: "Berkeley Mono" }), false)["--font-mono"]).toBe("Berkeley Mono, ui-monospace, monospace");
    expect(resolveVars(a({ font: "custom", customFont: "  " }), false)).not.toHaveProperty("--font-sans");
    const mm = resolveVars(a({ theme: "modern-minimal", font: "custom" }), false);
    expect(mm["--font-sans"]).toBe('"Inter Variable", Inter, sans-serif');
  });
});

describe("stepIndex", () => {
  it("steps, clamps, jumps", () => {
    expect(stepIndex(0, "ArrowDown", 3)).toBe(1);
    expect(stepIndex(2, "ArrowDown", 3)).toBe(2);
    expect(stepIndex(0, "ArrowUp", 3)).toBe(0);
    expect(stepIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(stepIndex(1, "Home", 3)).toBe(0);
    expect(stepIndex(0, "End", 3)).toBe(2);
    expect(stepIndex(0, "ArrowDown", 0)).toBe(-1);
  });
});

describe("mapFontStack", () => {
  it("inserts bundled families, keeps others", () => {
    expect(mapFontStack('"Geist Mono", ui-monospace, monospace')).toBe('"Geist Mono Variable", "Geist Mono", ui-monospace, monospace');
    expect(mapFontStack("dm sans, sans-serif")).toBe('"DM Sans Variable", dm sans, sans-serif');
    expect(mapFontStack("Poppins, sans-serif")).toBe("Poppins, sans-serif");
  });
});

describe("presets", () => {
  it("has all 42 tweakcn presets with core colors in both modes", () => {
    expect(Object.keys(PRESETS)).toHaveLength(42);
    expect(THEMES).toHaveLength(43);
    for (const p of Object.values(PRESETS)) {
      for (const isDark of [false, true]) {
        const v = modeVars(p, isDark);
        expect(v.background).toBeTruthy();
        expect(v.foreground).toBeTruthy();
      }
    }
  });

  it("swatch and filter", () => {
    expect(swatch("default", true)).toHaveLength(4);
    expect(swatch("modern-minimal", false)).toEqual(["#3b82f6", "#f3f4f6", "#e0f2fe", "#ffffff"]);
    expect(filterThemes(THEMES, "  CYBER ").map((t) => t.id)).toEqual(["cyberpunk"]);
    expect(filterThemes(THEMES, "")).toHaveLength(43);
  });
});

describe("applyAppearance", () => {
  const fakeDoc = (systemDark: boolean) => {
    const classes = new Set<string>();
    const props = new Map<string, string>();
    return {
      classes, props,
      documentElement: {
        classList: { toggle: (c: string, f: boolean) => (f ? classes.add(c) : classes.delete(c)) },
        style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => props.delete(k) },
      },
      defaultView: { matchMedia: () => ({ matches: systemDark }) },
    };
  };

  it("sets dark class from mode / system and clears stale vars", () => {
    const d = fakeDoc(true);
    applyAppearance(a({ theme: "claude" }), d);
    expect(d.classes.has("dark")).toBe(true);
    expect(d.props.get("--background")).toBe(PRESETS.claude!.dark.background);
    applyAppearance(a({ mode: "light" }), d);
    expect(d.classes.has("dark")).toBe(false);
    expect([...d.props.keys()]).toEqual(["--app-font-size", "--chat-font-size", "--chat-leading", "--chat-flow"]);
  });
});
