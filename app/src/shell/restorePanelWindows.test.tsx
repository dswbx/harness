import type { PanelWindow } from "@harness/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
   popPanel: vi.fn(async (_s: string, _p: string, _o: unknown) => {}),
   dockPanel: vi.fn(),
   inTauri: vi.fn(() => true),
   listDisplays: vi.fn(async () => ({
      all: [{ x: 0, y: 0, width: 1440, height: 900 }],
      current: { x: 0, y: 0, width: 1440, height: 900 },
   })),
}));
vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   ...api,
}));

import { planRestore } from "./restorePanelWindows";

const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      get length() {
         return mem.size;
      },
      key: (i: number) => [...mem.keys()][i] ?? null,
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
   });
   for (const f of Object.values(api)) f.mockClear();
   vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const w = (session: string, panel: string): PanelWindow => ({ session, panel });
const s = (id: string, archived = false) => ({ id, archived, title: `Title ${id}` });

describe("planRestore", () => {
   const entries = [w("a", "plan"), w("a", "tasks"), w("b", "plan"), w("gone", "plan")];
   it.each([
      {
         name: "normal: open all",
         entries: [w("a", "plan")],
         sessions: [s("a")],
         reopen: true,
         open: [w("a", "plan")],
         drop: [],
      },
      {
         name: "missing Session: drop",
         entries: [w("gone", "plan")],
         sessions: [s("a")],
         reopen: true,
         open: [],
         drop: [w("gone", "plan")],
      },
      {
         name: "archived Session: drop",
         entries: [w("a", "plan")],
         sessions: [s("a", true)],
         reopen: true,
         open: [],
         drop: [w("a", "plan")],
      },
      {
         name: "setting off: drop all",
         entries,
         sessions: [s("a"), s("b")],
         reopen: false,
         open: [],
         drop: entries,
      },
      {
         name: "several Sessions",
         entries,
         sessions: [s("a"), s("b", true)],
         reopen: true,
         open: [w("a", "plan"), w("a", "tasks")],
         drop: [w("b", "plan"), w("gone", "plan")],
      },
      { name: "no entries", entries: [], sessions: [s("a")], reopen: true, open: [], drop: [] },
   ])("$name", (c) => {
      expect(planRestore(c.entries, c.sessions, c.reopen)).toEqual({ open: c.open, drop: c.drop });
   });
});

const entry = (session: string, panel: string, at: number) =>
   mem.set(`harness.panelWindow.${session}#${panel}`, JSON.stringify({ v: 1, at }));

describe("restorePanelWindows", () => {
   it("old data (no keys): opens and docks nothing", async () => {
      mem.set("harness.sidebarOpen", "1");
      const { restorePanelWindows } = await import("./restorePanelWindows");
      await restorePanelWindows([s("a")]);
      expect(api.popPanel).not.toHaveBeenCalled();
      expect(api.dockPanel).not.toHaveBeenCalled();
   });

   it("docks the drops, reopens the rest quietly at a fitted frame, once", async () => {
      entry("a", "plan", 1);
      entry("b", "plan", 2);
      entry("gone", "tasks", 3);
      mem.set(
         "harness.panelWindowFrame.a#plan",
         JSON.stringify({ x: 5000, y: 5000, width: 600, height: 700 }),
      );
      const { restorePanelWindows } = await import("./restorePanelWindows");
      const sessions = [s("a"), s("b", true)];
      await restorePanelWindows(sessions);
      await restorePanelWindows(sessions);
      expect(api.dockPanel.mock.calls).toEqual([
         ["b", "plan"],
         ["gone", "tasks"],
      ]);
      expect(api.popPanel).toHaveBeenCalledTimes(1);
      expect(api.popPanel).toHaveBeenCalledWith("a", "plan", {
         title: "Plan · Title a",
         quiet: true,
         // Off screen: moved to the main display, centered.
         frame: { x: 420, y: 100, width: 600, height: 700 },
      });
   });

   it("no saved frame: opens without one", async () => {
      entry("a", "plan", 1);
      const { restorePanelWindows } = await import("./restorePanelWindows");
      await restorePanelWindows([s("a")]);
      expect(api.popPanel).toHaveBeenCalledWith("a", "plan", {
         title: "Plan · Title a",
         quiet: true,
      });
   });

   it("setting off: docks all, opens none", async () => {
      entry("a", "plan", 1);
      mem.set("harness.panelWindows.reopen", "off");
      const { restorePanelWindows } = await import("./restorePanelWindows");
      await restorePanelWindows([s("a")]);
      expect(api.dockPanel).toHaveBeenCalledWith("a", "plan");
      expect(api.popPanel).not.toHaveBeenCalled();
   });

   it("outside Tauri: only the drops run", async () => {
      api.inTauri.mockReturnValueOnce(false);
      entry("a", "plan", 1);
      entry("gone", "plan", 2);
      const { restorePanelWindows } = await import("./restorePanelWindows");
      await restorePanelWindows([s("a")]);
      expect(api.dockPanel).toHaveBeenCalledWith("gone", "plan");
      expect(api.popPanel).not.toHaveBeenCalled();
   });
});
