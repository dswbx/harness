import { codec, storedValue } from "@harness/api";
import type { Rect } from "@harness/ui";

export const SETTINGS_SECTIONS = [
   "appearance",
   "editor",
   "git",
   "overlay",
   "permissions",
   "agents",
   "mcp",
   "components",
   "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const isSection = (v: unknown): v is SettingsSection =>
   (SETTINGS_SECTIONS as readonly unknown[]).includes(v);

/** The stored text to a section; unset or unknown is "appearance". */
export const parseSection = (raw: string | null): SettingsSection =>
   isSection(raw) ? raw : "appearance";

/** The last Settings section shown, so the next open lands there. */
export const sectionStore = storedValue<SettingsSection>({
   key: "harness.settings.section",
   scope: "app",
   parse: parseSection,
   serialize: String,
});

const isRect = (v: unknown): v is Rect => {
   if (typeof v !== "object" || v === null) return false;
   const r = v as Record<string, unknown>;
   return ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
};

/** The stored Settings dialog box; null when unset or bad. */
export const parseFrame = codec.json<Rect | null>((v): v is Rect | null => isRect(v), null);

/** Position and size of the Settings dialog. Per window: the main window owns it. */
export const frameStore = storedValue<Rect | null>({
   key: "harness.settings.frame",
   scope: "app",
   parse: parseFrame,
   sync: false,
});
