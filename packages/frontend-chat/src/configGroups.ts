import type { ConfigOption } from "./reducer";

export type ConfigGroups = {
  mode?: ConfigOption;
  model?: ConfigOption;
  effort?: ConfigOption;
  /** On/off options shown as switch rows in the model chip. */
  chipToggles: ConfigOption[];
  /** Other `model_config` options shown as submenus in the model chip. */
  chipSubmenus: ConfigOption[];
  /** Everything else, shown in the "More options" menu (effort and chip parts too when there is no model option). */
  more: ConfigOption[];
};

const PAIRS: [off: string, on: string][] = [
  ["off", "on"],
  ["false", "true"],
  ["disabled", "enabled"],
];

/** Two-valued on/off option: returns the `on` and `off` values, else null. Matches values or names, case-insensitive. */
export function isToggle(o: ConfigOption): { on: string; off: string } | null {
  if (o.options.length !== 2) return null;
  const [a, b] = o.options as [ConfigOption["options"][number], ConfigOption["options"][number]];
  for (const key of ["value", "name"] as const) {
    const x = a[key].toLowerCase();
    const y = b[key].toLowerCase();
    for (const [off, on] of PAIRS) {
      if (x === off && y === on) return { off: a.value, on: b.value };
      if (x === on && y === off) return { off: b.value, on: a.value };
    }
  }
  return null;
}

const FAST = /fast/i;
const THINK = /think/i;
const matches = (o: ConfigOption, re: RegExp) => re.test(o.id) || re.test(o.name);

/** Which icon a chip toggle gets. */
export function toggleKind(o: ConfigOption): "fast" | "think" | null {
  if (matches(o, FAST)) return "fast";
  if (matches(o, THINK)) return "think";
  return null;
}

export function groupConfigOptions(options: ConfigOption[]): ConfigGroups {
  const g: ConfigGroups = { chipToggles: [], chipSubmenus: [], more: [] };
  const chipParts: ConfigOption[] = [];
  for (const o of options) {
    if (o.type !== "select") continue;
    if (o.category === "mode" && !g.mode) g.mode = o;
    else if (o.category === "model" && !g.model) g.model = o;
    else if (o.category === "thought_level" && !g.effort) g.effort = o;
    else if (isToggle(o) && (o.category === "model_config" || matches(o, FAST) || matches(o, THINK))) {
      g.chipToggles.push(o);
      chipParts.push(o);
    } else if (o.category === "model_config") {
      g.chipSubmenus.push(o);
      chipParts.push(o);
    } else g.more.push(o);
  }
  if (!g.model) {
    // No chip: its parts go to the "More options" menu, in their original order.
    const moved = new Set<ConfigOption>([...chipParts, ...(g.effort ? [g.effort] : [])]);
    g.more = options.filter((o) => moved.has(o) || g.more.includes(o));
    g.effort = undefined;
    g.chipToggles = [];
    g.chipSubmenus = [];
  }
  return g;
}

export const valueName = (o: ConfigOption) => o.options.find((v) => v.value === o.currentValue)?.name ?? o.currentValue;

/** `<model> · <effort>`, or null when there is no model option. */
export function chipLabel(g: ConfigGroups): string | null {
  if (!g.model) return null;
  return g.effort ? `${valueName(g.model)} · ${valueName(g.effort)}` : valueName(g.model);
}

/** True when a "fast" chip toggle is on (the chip shows a Zap icon). */
export function fastOn(g: ConfigGroups): boolean {
  return g.chipToggles.some((o) => toggleKind(o) === "fast" && isToggle(o)?.on === o.currentValue);
}
