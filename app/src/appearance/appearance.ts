import type { HarnessClient } from "@harness/api";
import { PRESETS, type ThemePreset } from "./presets";
import type { ImportedTheme } from "./importTheme";

export const MODES = ["light", "dark", "system"] as const;
export type Mode = (typeof MODES)[number];

export type Appearance = {
  /** "default", a preset id or an imported theme's id (`user-…`). */
  theme: string;
  mode: Mode;
  /** "theme" (the theme's font), "system", "custom" or a bundled font id. */
  font: string;
  mono: string;
  /** CSS font-family used when font / mono is "custom". */
  customFont: string;
  customMono: string;
  /** Base text size in px. */
  fontSize: number;
  /** Chat message text (typeset): size in px, leading and flow ids. */
  chatFontSize: number;
  leading: string;
  flow: string;
};

export type RhythmOption = { id: string; label: string; value: string };
/** Typeset leading (line height) and flow (space between blocks): a few steps, not free values. */
export const LEADINGS: RhythmOption[] = [
  { id: "tight", label: "Tight", value: "1.6" },
  { id: "regular", label: "Regular", value: "1.75" },
  { id: "loose", label: "Loose", value: "1.9" },
];
export const FLOWS: RhythmOption[] = [
  { id: "compact", label: "Compact", value: "1em" },
  { id: "regular", label: "Regular", value: "1.25em" },
  { id: "airy", label: "Airy", value: "2em" },
];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "default", mode: "system", font: "theme", mono: "theme", customFont: "", customMono: "", fontSize: 14,
  chatFontSize: 14, leading: "tight", flow: "regular",
};
export const CUSTOM_FONT_MAX = 200;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 18;
export const STORAGE_KEY = "harness.appearance";
/** Imported themes, cached here so the first paint has them; the core's `themes.json` is the truth. */
export const THEMES_KEY = "harness.themes";
const USER_ID = /^user-[a-z0-9-]{1,60}$/;

export type FontOption = { id: string; label: string; family: string };

/** Fonts bundled via @fontsource-variable (imported in main.tsx). `family` is the CSS family the package registers. */
export const SANS_FONTS: FontOption[] = [
  { id: "inter", label: "Inter", family: "Inter Variable" },
  { id: "geist", label: "Geist", family: "Geist Variable" },
  { id: "dm-sans", label: "DM Sans", family: "DM Sans Variable" },
  { id: "plus-jakarta-sans", label: "Plus Jakarta Sans", family: "Plus Jakarta Sans Variable" },
  { id: "outfit", label: "Outfit", family: "Outfit Variable" },
  { id: "montserrat", label: "Montserrat", family: "Montserrat Variable" },
];
export const MONO_FONTS: FontOption[] = [
  { id: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono Variable" },
  { id: "geist-mono", label: "Geist Mono", family: "Geist Mono Variable" },
];

export const SYSTEM_SANS = "ui-sans-serif, system-ui, -apple-system, sans-serif";
export const SYSTEM_MONO = "ui-monospace, monospace";

/** Preset font name -> bundled family, so presets naming a bundled font render with it. */
const BUNDLED = new Map([...SANS_FONTS, ...MONO_FONTS].map((f) => [f.label.toLowerCase(), f.family]));

/** Inserts the bundled variable family before each family name we bundle: `Inter, sans-serif` -> `"Inter Variable", Inter, sans-serif`. */
export function mapFontStack(stack: string): string {
  return stack
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      const b = BUNDLED.get(s.replace(/^["']|["']$/g, "").toLowerCase());
      return b ? [`"${b}"`, s] : [s];
    })
    .join(", ");
}

/** Keys tweakcn reuses from light when dark omits them (fonts, radius, shadows, spacing). */
const SHARED_KEY = /^(font-|radius$|shadow-|letter-spacing$|spacing$)/;
/** Keys we never apply: `--spacing` would rescale every Tailwind spacing utility. */
const SKIP = new Set(["spacing"]);

/** A preset's tokens for one mode, with the light fallback for shared keys. */
export function modeVars(p: ThemePreset, isDark: boolean): Record<string, string> {
  if (!isDark) return p.light;
  const shared = Object.fromEntries(Object.entries(p.light).filter(([k]) => SHARED_KEY.test(k)));
  return { ...shared, ...p.dark };
}

export const clampFontSize = (n: number) => Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));

/** Strips characters that could break out of a CSS value and limits length. Does not trim, so typing a space works. */
export const cleanFont = (s: string) => s.replace(/[;{}]/g, "").slice(0, CUSTOM_FONT_MAX);

export function normalize(raw: unknown): Appearance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  const pick = (v: unknown, ok: (s: string) => boolean, def: string) => (typeof v === "string" && ok(v) ? v : def);
  const fontOk = (list: FontOption[]) => (s: string) => s === "theme" || s === "system" || s === "custom" || list.some((f) => f.id === s);
  return {
    // An imported theme id stays even before the themes load; an unknown one looks like default.
    theme: pick(r.theme, (s) => s === "default" || Object.hasOwn(PRESETS, s) || USER_ID.test(s), d.theme),
    mode: pick(r.mode, (s) => (MODES as readonly string[]).includes(s), d.mode) as Mode,
    font: pick(r.font, fontOk(SANS_FONTS), d.font),
    mono: pick(r.mono, fontOk(MONO_FONTS), d.mono),
    customFont: typeof r.customFont === "string" ? cleanFont(r.customFont).trim() : d.customFont,
    customMono: typeof r.customMono === "string" ? cleanFont(r.customMono).trim() : d.customMono,
    fontSize: typeof r.fontSize === "number" && Number.isFinite(r.fontSize) ? clampFontSize(r.fontSize) : d.fontSize,
    chatFontSize: typeof r.chatFontSize === "number" && Number.isFinite(r.chatFontSize) ? clampFontSize(r.chatFontSize) : d.chatFontSize,
    leading: pick(r.leading, (s) => LEADINGS.some((o) => o.id === s), d.leading),
    flow: pick(r.flow, (s) => FLOWS.some((o) => o.id === s), d.flow),
  };
}

export function loadAppearance(storage: Pick<Storage, "getItem">): Appearance {
  try {
    return normalize(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(storage: Pick<Storage, "setItem">, a: Appearance) {
  storage.setItem(STORAGE_KEY, JSON.stringify(normalize(a)));
}

function fontVar(choice: string, custom: string, list: FontOption[], system: string): string | null {
  if (choice === "system") return system;
  if (choice === "custom") {
    const c = cleanFont(custom).trim();
    return c ? `${mapFontStack(c)}, ${system}` : null;
  }
  const f = list.find((o) => o.id === choice);
  return f ? `"${f.family}", ${system}` : null;
}

/** CSS custom properties to set on <html>: preset tokens for the mode, font overrides, base size, chat text. */
export function resolveVars(a: Appearance, isDark: boolean): Record<string, string> {
  const vars: Record<string, string> = {};
  const p = themeById(a.theme);
  if (p) {
    for (const [k, v] of Object.entries(modeVars(p, isDark))) {
      if (!SKIP.has(k)) vars[`--${k}`] = k.startsWith("font-") ? mapFontStack(v) : v;
    }
  }
  const sans = fontVar(a.font, a.customFont, SANS_FONTS, SYSTEM_SANS);
  const mono = fontVar(a.mono, a.customMono, MONO_FONTS, SYSTEM_MONO);
  if (sans) vars["--font-sans"] = sans;
  if (mono) vars["--font-mono"] = mono;
  vars["--app-font-size"] = `${a.fontSize}px`;
  vars["--chat-font-size"] = `${a.chatFontSize}px`;
  vars["--chat-leading"] = (LEADINGS.find((o) => o.id === a.leading) ?? LEADINGS[0]!).value;
  vars["--chat-flow"] = (FLOWS.find((o) => o.id === a.flow) ?? FLOWS[1]!).value;
  return vars;
}

/** Default theme tokens (packages/ui/src/styles.css), for the theme card preview. */
const DEFAULT_SWATCH = {
  light: { primary: "oklch(0.205 0 0)", secondary: "oklch(0.97 0 0)", accent: "oklch(0.95 0 0)", background: "oklch(1 0 0)" },
  dark: { primary: "oklch(0.92 0 0)", secondary: "oklch(0.27 0 0)", accent: "oklch(0.3 0 0)", background: "oklch(0.16 0 0)" },
};

/** Primary, secondary, accent and background of a theme for the mode. */
export function swatch(theme: string, isDark: boolean): string[] {
  const p = themeById(theme);
  const v: Record<string, string | undefined> = p ? modeVars(p, isDark) : DEFAULT_SWATCH[isDark ? "dark" : "light"];
  return ["primary", "secondary", "accent", "background"].map((k) => v[k] ?? "transparent");
}

export type ThemeOption = { id: string; label: string; imported?: boolean };
export const THEMES: ThemeOption[] = [{ id: "default", label: "Default" }, ...Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }))];

let imported: Record<string, ImportedTheme> = {};
let themeList: ThemeOption[] = THEMES;
const themeListeners = new Set<() => void>();

const themeById = (id: string): ThemePreset | undefined => (Object.hasOwn(imported, id) ? imported[id] : Object.hasOwn(PRESETS, id) ? PRESETS[id] : undefined);

/** Imported themes by id. */
export const getImportedThemes = () => imported;
/** Imported themes first, then default and the presets. */
export const getThemes = () => themeList;
export function onThemesChange(fn: () => void) {
  themeListeners.add(fn);
  return () => void themeListeners.delete(fn);
}

/** Keeps the entries that look like themes (the file is the user's to edit). */
export function normalizeThemes(raw: unknown): Record<string, ImportedTheme> {
  const out: Record<string, ImportedTheme> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, t] of Object.entries(raw as Record<string, Partial<ImportedTheme>>)) {
    if (!USER_ID.test(id) || !t || typeof t.label !== "string" || typeof t.light !== "object" || typeof t.dark !== "object" || !t.light || !t.dark) continue;
    out[id] = { label: t.label, light: t.light, dark: t.dark, ...(typeof t.source === "string" ? { source: t.source } : {}) };
  }
  return out;
}

function loadThemes(next: Record<string, ImportedTheme>) {
  imported = next;
  const mine = Object.entries(next).map(([id, t]) => ({ id, label: t.label, imported: true })).sort((x, y) => x.label.localeCompare(y.label));
  themeList = [...mine, ...THEMES];
  for (const l of themeListeners) l();
}

export function filterThemes(themes: ThemeOption[], query: string): ThemeOption[] {
  const q = query.trim().toLowerCase();
  return themes.filter((t) => !q || t.label.toLowerCase().includes(q) || t.id.includes(q));
}

/** Next index for list keyboard nav: ArrowUp/Down step by one and clamp, Home/End jump. -1 when the list is empty. */
export function stepIndex(i: number, key: string, len: number): number {
  if (len === 0) return -1;
  const n = key === "Home" ? 0 : key === "End" ? len - 1 : key === "ArrowDown" ? i + 1 : key === "ArrowUp" ? i - 1 : i;
  return Math.min(len - 1, Math.max(0, n));
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

type Win = { matchMedia?: (q: string) => { matches: boolean } };
export function isDarkMode(mode: Mode, win: Win | null | undefined): boolean {
  return mode === "dark" || (mode === "system" && !!win?.matchMedia?.(DARK_QUERY).matches);
}

type Doc = {
  documentElement: { classList: { toggle(c: string, force: boolean): unknown }; style: { setProperty(k: string, v: string): void; removeProperty(k: string): unknown } };
  defaultView?: Win | null;
};
const applied = new WeakMap<object, string[]>();

/** Sets the `dark` class and the resolved CSS vars on <html>, removing vars set by the previous call. */
export function applyAppearance(a: Appearance, doc: Doc = document) {
  const root = doc.documentElement;
  const isDark = isDarkMode(a.mode, doc.defaultView);
  root.classList.toggle("dark", isDark);
  const vars = resolveVars(a, isDark);
  for (const k of applied.get(root) ?? []) if (!(k in vars)) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  applied.set(root, Object.keys(vars));
}

let current = DEFAULT_APPEARANCE;
let client: HarnessClient | null = null;

function cache(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* the core keeps the truth */ }
}

export const getAppearance = () => current;

/** Saves and applies in this window; other windows follow via the `storage` event. */
export function setAppearance(a: Appearance) {
  current = normalize(a);
  saveAppearance(localStorage, current);
  applyAppearance(current);
  void client?.setAppSetting("appearance", current);
}

/** Saves the imported themes (all windows follow), then applies: the current theme may have changed. */
export async function setImportedThemes(next: Record<string, ImportedTheme>) {
  loadThemes(normalizeThemes(next));
  cache(THEMES_KEY, imported);
  applyAppearance(current);
  await client?.setAppSetting("themes", imported);
}

/**
 * Loads appearance and imported themes from the core (`appearance.json`, `themes.json` in the
 * data dir) once the window has a client; the local copies only paint the first frame. Settings
 * from before the core kept them move there.
 */
export async function syncAppearance(c: HarnessClient) {
  client = c;
  const [a, t] = await Promise.all([c.getAppSetting("appearance"), c.getAppSetting("themes")]);
  if (t != null) {
    loadThemes(normalizeThemes(t));
    cache(THEMES_KEY, imported);
  } else if (Object.keys(imported).length) await c.setAppSetting("themes", imported);
  if (a != null) {
    current = normalize(a);
    saveAppearance(localStorage, current);
  } else await c.setAppSetting("appearance", current);
  applyAppearance(current);
}

/** Applies in this window without saving or changing the current appearance (theme picker preview). */
export function previewAppearance(a: Appearance) {
  applyAppearance(normalize(a));
}

/** Undoes a preview: applies the saved appearance again. */
export function revertPreview() {
  applyAppearance(current);
}

/** Call once per window before the first render. */
export function initAppearance() {
  try {
    loadThemes(normalizeThemes(JSON.parse(localStorage.getItem(THEMES_KEY) ?? "null")));
  } catch { /* none cached */ }
  current = loadAppearance(localStorage);
  applyAppearance(current);
  window.matchMedia(DARK_QUERY).addEventListener("change", () => current.mode === "system" && applyAppearance(current));
  window.addEventListener("storage", (e) => {
    if (e.key === THEMES_KEY || e.key === null) {
      try {
        loadThemes(normalizeThemes(JSON.parse(localStorage.getItem(THEMES_KEY) ?? "null")));
      } catch { /* keep */ }
    }
    if (e.key !== STORAGE_KEY && e.key !== THEMES_KEY && e.key !== null) return;
    current = loadAppearance(localStorage);
    applyAppearance(current);
  });
}
