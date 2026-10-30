import { PRESETS, type ThemePreset } from "./presets";

/** A theme the user imported: same tokens as a preset, plus where it came from. */
export type ImportedTheme = ThemePreset & { source?: string };

/** Token names a theme may set: those the bundled presets use. Anything else is dropped. */
const KNOWN = new Set(Object.values(PRESETS).flatMap((p) => [...Object.keys(p.light), ...Object.keys(p.dark)]));
const MAX_VALUE = 200;

/** A token value, or null when it could break out of a CSS value or load something. */
export function cleanValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= MAX_VALUE && !/[;{}<>\\]|url\(|@import|expression\(/i.test(s) ? s : null;
}

function cleanVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.replace(/^--/, "");
    const value = cleanValue(v);
    if (KNOWN.has(key) && value) out[key] = value;
  }
  return out;
}

function checked(t: ImportedTheme): ImportedTheme {
  if (!t.light.background || !t.light.foreground || !t.light.primary) throw new Error("No theme colors found (background, foreground, primary).");
  return t;
}

/**
 * The registry URL for what the user pasted: a tweakcn theme or editor link becomes its
 * `/r/themes/<id>` item; another https URL stays as it is. null: not a URL (maybe CSS).
 */
export function registryUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") throw new Error("Only https URLs.");
  if (u.hostname === "tweakcn.com" || u.hostname === "www.tweakcn.com") {
    const id = /^\/(?:r\/)?themes\/([\w-]+?)(?:\.json)?\/?$/.exec(u.pathname)?.[1] ?? u.searchParams.get("theme");
    if (!id) throw new Error("Not a tweakcn theme link: open the theme and use Share or Code.");
    return `https://tweakcn.com/r/themes/${id}`;
  }
  return u.toString();
}

/** A shadcn registry item (tweakcn): `cssVars.theme` (fonts, radius) is shared by both modes. */
export function fromRegistryItem(json: unknown, source?: string): ImportedTheme {
  const item = (json && typeof json === "object" ? json : {}) as { name?: unknown; title?: unknown; cssVars?: { theme?: unknown; light?: unknown; dark?: unknown } };
  const vars = item.cssVars;
  if (!vars || typeof vars !== "object") throw new Error("Not a theme: no cssVars.");
  const label = [item.title, item.name].find((x): x is string => typeof x === "string" && !!x.trim())?.trim() ?? "Imported theme";
  return checked({ label: label.slice(0, 60), light: { ...cleanVars(vars.theme), ...cleanVars(vars.light) }, dark: cleanVars(vars.dark), ...(source ? { source } : {}) });
}

/** Theme CSS as tweakcn and shadcn print it: `:root { --x: … }` and `.dark { --x: … }`. */
export function fromCss(css: string, label: string): ImportedTheme {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Statements before a block (`@import …;`) end up in its selector match.
    const sel = selector!.split(";").pop()!.trim();
    // `@theme inline` maps Tailwind names to these vars; it holds no values of its own.
    const into = sel === ":root" ? light : sel === ".dark" || sel === ":root.dark" ? dark : null;
    if (!into) continue;
    for (const decl of body!.split(";")) {
      const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (m) Object.assign(into, cleanVars({ [m[1]!]: m[2] }));
    }
  }
  return checked({ label: label.trim().slice(0, 60) || "Imported theme", light, dark });
}

/** A new theme id from its label, unlike `taken`. */
export function themeId(label: string, taken: (id: string) => boolean): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "theme";
  let id = `user-${slug}`;
  for (let i = 2; taken(id); i++) id = `user-${slug}-${i}`;
  return id;
}
