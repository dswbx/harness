import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemePreset } from "./presets";
import data from "./presets.json";

// Spy on the data chunk's loader: a first paint from the cache must never call it.
vi.mock("./presets", async (orig) => {
   const m = await orig<typeof import("./presets")>();
   return { ...m, importPresets: vi.fn(m.importPresets) };
});

const presets = data as unknown as Record<string, ThemePreset>;
const theme = presets.claude!;
const bg = () => document.documentElement.style.getPropertyValue("--background");
const flush = () => new Promise((r) => setTimeout(r, 0));

let systemDark = false;
let onSystemChange: (() => void) | null = null;

/** A fresh window: new module state, same localStorage (what a second start sees). */
async function boot() {
   vi.resetModules();
   const mod = await import("./appearance");
   const { importPresets } = await import("./presets");
   vi.mocked(importPresets).mockClear();
   mod.initAppearance();
   return { mod, loads: () => vi.mocked(importPresets).mock.calls.length };
}

const setStored = (patch: Record<string, unknown>) =>
   localStorage.setItem("harness.appearance", JSON.stringify({ theme: "claude", ...patch }));

beforeEach(() => {
   const m = new Map<string, string>();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
   });
   document.documentElement.removeAttribute("style");
   document.documentElement.classList.remove("dark");
   systemDark = false;
   onSystemChange = null;
   window.matchMedia = ((q: string) => ({
      matches: q.includes("dark") && systemDark,
      addEventListener: (_: string, fn: () => void) => void (onSystemChange = fn),
   })) as unknown as typeof window.matchMedia;
});

describe("theme vars cache", () => {
   it("miss: loads the data, applies, and caches both modes", async () => {
      setStored({ mode: "light" });
      const { mod, loads } = await boot();
      expect(loads()).toBe(1);
      expect(bg()).toBe(""); // nothing yet: the window stays hidden until the data is applied
      await flush();
      expect(bg()).toBe(theme.light.background);
      const c = JSON.parse(localStorage.getItem(mod.VARS_KEY)!);
      expect(c.v).toBe(mod.VARS_VERSION);
      expect(c.light["--background"]).toBe(theme.light.background);
      expect(c.dark["--background"]).toBe(theme.dark.background);
   });

   it("hit: paints at once and never loads the data", async () => {
      setStored({ mode: "dark" });
      await boot();
      await flush();
      document.documentElement.removeAttribute("style");
      const { loads } = await boot();
      expect(bg()).toBe(theme.dark.background);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      await flush();
      expect(loads()).toBe(0);
   });

   it("system light/dark switch uses the cached other mode, no load", async () => {
      setStored({ mode: "system" });
      await boot();
      await flush();
      const { loads } = await boot();
      expect(bg()).toBe(theme.light.background);
      systemDark = true;
      onSystemChange!();
      expect(bg()).toBe(theme.dark.background);
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      await flush();
      expect(loads()).toBe(0);
   });

   it("a version bump invalidates: loads again and caches the new version", async () => {
      setStored({ mode: "light" });
      const first = await boot();
      await flush();
      const c = JSON.parse(localStorage.getItem(first.mod.VARS_KEY)!);
      localStorage.setItem(first.mod.VARS_KEY, JSON.stringify({ ...c, v: "an older build" }));
      document.documentElement.removeAttribute("style");
      const { mod, loads } = await boot();
      expect(bg()).toBe("");
      expect(loads()).toBe(1);
      await flush();
      expect(bg()).toBe(theme.light.background);
      expect(JSON.parse(localStorage.getItem(mod.VARS_KEY)!).v).toBe(mod.VARS_VERSION);
   });

   it("another appearance (a font choice) is a miss too", async () => {
      setStored({ mode: "light" });
      await boot();
      await flush();
      setStored({ mode: "light", font: "outfit" });
      const { loads } = await boot();
      expect(loads()).toBe(1);
      await flush();
      expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain("Outfit");
   });

   it("default and imported themes need no data", async () => {
      localStorage.setItem("harness.appearance", JSON.stringify({ theme: "default" }));
      const { loads } = await boot();
      await flush();
      expect(loads()).toBe(0);
      localStorage.setItem(
         "harness.themes",
         JSON.stringify({
            "user-mine": { label: "Mine", light: { background: "#111111" }, dark: {} },
         }),
      );
      localStorage.setItem("harness.appearance", JSON.stringify({ theme: "user-mine" }));
      const again = await boot();
      expect(bg()).toBe("#111111");
      expect(again.loads()).toBe(0);
   });
});
