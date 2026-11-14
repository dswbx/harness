import { beforeEach, describe, expect, it, vi } from "vitest";
import { getImportedThemes, loadCachedThemes, setImportedThemes } from "./appearance/appearance";
import { PRESETS } from "./appearance/presets";
import { saveAgent, savedAgent } from "./quick/startSession";

// Users have data under these keys: the stored text of each non-JSON format is pinned.
const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
   });
});

describe("stored text formats", () => {
   it("overlay.agent is the raw Agent id", () => {
      saveAgent("claude-acp");
      expect(mem.get("harness.overlay.agent")).toBe("claude-acp");
      expect(savedAgent()).toBe("claude-acp");
   });
});

describe("imported themes cache", () => {
   it("unreadable text from another window keeps the themes in use", async () => {
      const t = { ...PRESETS.claude!, id: "user-x" } as never;
      await setImportedThemes({ "user-x": t });
      expect(Object.keys(getImportedThemes())).toEqual(["user-x"]);
      mem.set("harness.themes", "{nope");
      loadCachedThemes();
      expect(Object.keys(getImportedThemes())).toEqual(["user-x"]);
      mem.set("harness.themes", "{}");
      loadCachedThemes();
      expect(Object.keys(getImportedThemes())).toEqual([]);
   });
});
