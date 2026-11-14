// Theme presets from tweakcn (https://github.com/jnsahaj/tweakcn), utils/theme-presets.ts. Apache-2.0.
// The values are data: `presets.json` (id -> tokens, verbatim), loaded on demand as its own chunk, so a window's first
// paint does not parse them (the active theme's resolved vars are cached, see `appearance.ts`). This file keeps what
// is needed before that: the ids, names and order, and the token names. `presets.test.ts` pins both to the data.

export type ThemePreset = {
   label: string;
   light: Record<string, string>;
   dark: Record<string, string>;
};

/** Every preset's id and name, in picker order. */
export const PRESET_INDEX: readonly (readonly [id: string, label: string])[] = [
   ["modern-minimal", "Modern Minimal"],
   ["violet-bloom", "Violet Bloom"],
   ["t3-chat", "T3 Chat"],
   ["twitter", "Twitter"],
   ["mocha-mousse", "Mocha Mousse"],
   ["bubblegum", "Bubblegum"],
   ["amethyst-haze", "Amethyst Haze"],
   ["notebook", "Notebook"],
   ["doom-64", "Doom 64"],
   ["catppuccin", "Catppuccin"],
   ["graphite", "Graphite"],
   ["perpetuity", "Perpetuity"],
   ["kodama-grove", "Kodama Grove"],
   ["cosmic-night", "Cosmic Night"],
   ["tangerine", "Tangerine"],
   ["quantum-rose", "Quantum Rose"],
   ["nature", "Nature"],
   ["bold-tech", "Bold Tech"],
   ["elegant-luxury", "Elegant Luxury"],
   ["amber-minimal", "Amber Minimal"],
   ["supabase", "Supabase"],
   ["neo-brutalism", "Neo Brutalism"],
   ["solar-dusk", "Solar Dusk"],
   ["claymorphism", "Claymorphism"],
   ["cyberpunk", "Cyberpunk"],
   ["pastel-dreams", "Pastel Dreams"],
   ["clean-slate", "Clean Slate"],
   ["caffeine", "Caffeine"],
   ["ocean-breeze", "Ocean Breeze"],
   ["retro-arcade", "Retro Arcade"],
   ["midnight-bloom", "Midnight Bloom"],
   ["candyland", "Candyland"],
   ["northern-lights", "Northern Lights"],
   ["vintage-paper", "Vintage Paper"],
   ["sunset-horizon", "Sunset Horizon"],
   ["starry-night", "Starry Night"],
   ["claude", "Claude"],
   ["vercel", "Vercel"],
   ["darkmatter", "Darkmatter"],
   ["mono", "Mono"],
   ["soft-pop", "Soft Pop"],
   ["sage-garden", "Sage Garden"],
];

/** Token names a theme may set: those the presets use, in first-use order. */
export const THEME_TOKENS: readonly string[] = [
   "background",
   "foreground",
   "card",
   "card-foreground",
   "popover",
   "popover-foreground",
   "primary",
   "primary-foreground",
   "secondary",
   "secondary-foreground",
   "muted",
   "muted-foreground",
   "accent",
   "accent-foreground",
   "destructive",
   "destructive-foreground",
   "border",
   "input",
   "ring",
   "chart-1",
   "chart-2",
   "chart-3",
   "chart-4",
   "chart-5",
   "radius",
   "sidebar",
   "sidebar-foreground",
   "sidebar-primary",
   "sidebar-primary-foreground",
   "sidebar-accent",
   "sidebar-accent-foreground",
   "sidebar-border",
   "sidebar-ring",
   "font-sans",
   "font-serif",
   "font-mono",
   "shadow-color",
   "shadow-opacity",
   "shadow-blur",
   "shadow-spread",
   "shadow-offset-x",
   "shadow-offset-y",
   "letter-spacing",
   "spacing",
];

/** The presets, id -> tokens (a separate chunk). */
export const importPresets = async () =>
   (await import("./presets.json")).default as unknown as Record<string, ThemePreset>;
