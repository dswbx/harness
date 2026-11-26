import { beforeEach, describe, expect, it, vi } from "vitest";
import {
   closePanel,
   dockPanel,
   fitFrame,
   listClosedPanelWindows,
   listPanelWindows,
   panelWindowLabel,
   panelWindowUrl,
   parsePanelWindow,
   popPanel,
} from "./panelWindows";

class MemStorage {
   m = new Map<string, string>();
   get length() {
      return this.m.size;
   }
   key = (i: number) => [...this.m.keys()][i] ?? null;
   getItem = (k: string) => this.m.get(k) ?? null;
   setItem = (k: string, v: string) => void this.m.set(k, v);
   removeItem = (k: string) => void this.m.delete(k);
}

let mem: MemStorage;
const open = vi.fn();
beforeEach(() => {
   mem = new MemStorage();
   open.mockReset();
   vi.stubGlobal("localStorage", mem);
   vi.stubGlobal("window", Object.assign(new EventTarget(), { open }));
});

describe("panelWindowLabel", () => {
   it("holds only label chars and keeps a prefix", () => {
      const l = panelWindowLabel("s-1", "slot:a b/ü😀");
      expect(l).toMatch(/^panel-[a-zA-Z0-9\-/:_]+$/);
   });

   it("is injective", () => {
      const pairs: [string, string][] = [
         ["s1", "slot:a b"],
         ["s1", "slot:a_20b"],
         ["s1", "slot:a_u000020b"],
         ["s1:slot", "a b"],
         ["s1", "plan"],
         ["s1_", "plan"],
         ["s1", "_plan"],
         ["s1", "😀"],
         ["s1", "_u01f600"],
      ];
      const labels = pairs.map(([s, p]) => panelWindowLabel(s, p));
      expect(new Set(labels).size).toBe(labels.length);
   });

   it("leaves plain ids readable", () => {
      expect(panelWindowLabel("ab-12", "plan")).toBe("panel-ab-12:plan");
   });
});

describe("storage", () => {
   it("parses only v1 entries", () => {
      expect(parsePanelWindow(null)).toBeNull();
      expect(parsePanelWindow("{bad")).toBeNull();
      expect(parsePanelWindow('{"v":2,"at":1}')).toBeNull();
      expect(parsePanelWindow('{"v":1}')).toBeNull();
      expect(parsePanelWindow('{"v":1,"at":"x"}')).toBeNull();
      expect(parsePanelWindow("null")).toBeNull();
      expect(parsePanelWindow('{"v":1,"at":5}')).toEqual({ v: 1, at: 5 });
   });

   it("parses old entries (no closed) and closed ones", () => {
      expect(parsePanelWindow('{"v":1,"at":5,"closed":true}')).toEqual({
         v: 1,
         at: 5,
         closed: true,
      });
      expect(parsePanelWindow('{"v":1,"at":5,"closed":false}')).toEqual({ v: 1, at: 5 });
   });

   it("closed entries are not popped; they are listed apart", () => {
      mem.setItem("harness.panelWindow.s1#plan", '{"v":1,"at":2}');
      mem.setItem("harness.panelWindow.s1#tasks", '{"v":1,"at":1,"closed":true}');
      expect(listPanelWindows()).toEqual([{ session: "s1", panel: "plan" }]);
      expect(listClosedPanelWindows()).toEqual([{ session: "s1", panel: "tasks" }]);
   });

   it("close marks a popped key closed; on a docked panel it does nothing", async () => {
      await popPanel("s1", "plan", { title: "Plan" });
      closePanel("s1", "plan");
      expect(JSON.parse(mem.getItem("harness.panelWindow.s1#plan")!)).toMatchObject({
         v: 1,
         closed: true,
      });
      expect(listPanelWindows()).toEqual([]);
      expect(listClosedPanelWindows()).toEqual([{ session: "s1", panel: "plan" }]);
      closePanel("s1", "tasks");
      expect(mem.getItem("harness.panelWindow.s1#tasks")).toBeNull();
      // Popping again clears the mark.
      await popPanel("s1", "plan", { title: "Plan" });
      expect(listPanelWindows()).toEqual([{ session: "s1", panel: "plan" }]);
   });

   it("lists popped panels oldest first; bad data is absent and removed", () => {
      mem.setItem("harness.panelWindow.s1#plan", '{"v":1,"at":2}');
      mem.setItem("harness.panelWindow.s2#slot:a b", '{"v":1,"at":1}');
      mem.setItem("harness.panelWindow.s1#tasks", "garbage");
      mem.setItem("harness.panelWindowFrame.s1#plan", '{"x":0,"y":0,"width":1,"height":1}');
      expect(listPanelWindows()).toEqual([
         { session: "s2", panel: "slot:a b" },
         { session: "s1", panel: "plan" },
      ]);
      expect(mem.getItem("harness.panelWindow.s1#tasks")).toBeNull();
      expect(mem.getItem("harness.panelWindowFrame.s1#plan")).not.toBeNull();
   });

   it("no keys (old data): nothing popped", () => {
      mem.setItem("harness.chat.layout.s1", "{}");
      expect(listPanelWindows()).toEqual([]);
   });

   it("pop writes the key and opens the window; dock removes the key only", async () => {
      await popPanel("s1", "slot:a b", { title: "Plan · Demo" });
      expect(JSON.parse(mem.getItem("harness.panelWindow.s1#slot:a b")!)).toMatchObject({ v: 1 });
      expect(open).toHaveBeenCalledWith(
         panelWindowUrl("s1", "slot:a b"),
         panelWindowLabel("s1", "slot:a b"),
      );
      expect(panelWindowUrl("s1", "slot:a b")).toBe(
         "/?session=s1&solo=1&pane=panel&panel=slot%3Aa%20b",
      );
      mem.setItem("harness.panelWindowFrame.s1#slot:a b", "{}");
      dockPanel("s1", "slot:a b");
      expect(listPanelWindows()).toEqual([]);
      expect(mem.getItem("harness.panelWindowFrame.s1#slot:a b")).toBe("{}");
   });

   it("a quiet pop marks the URL", async () => {
      await popPanel("s1", "plan", { title: "Plan", quiet: true });
      expect(open.mock.calls[0]?.[0]).toBe("/?session=s1&solo=1&pane=panel&panel=plan&quiet=1");
   });
});

describe("fitFrame", () => {
   const main = { x: 0, y: 0, width: 1440, height: 900 };
   const right = { x: 1440, y: 0, width: 1920, height: 1080 };

   it("keeps a frame on a display", () => {
      const f = { x: 1600, y: 100, width: 600, height: 700 };
      expect(fitFrame(f, [main, right], main)).toBe(f);
   });

   it("keeps a frame that is partly off screen but has its title bar visible", () => {
      const f = { x: 1300, y: 50, width: 600, height: 700 };
      expect(fitFrame(f, [main], main)).toBe(f);
   });

   it("moves a frame of a removed display onto the fallback, centered", () => {
      const f = { x: 1600, y: 100, width: 600, height: 700 };
      expect(fitFrame(f, [main], main)).toEqual({ x: 420, y: 100, width: 600, height: 700 });
   });

   it("moves a frame whose title bar is above every display, and shrinks it to fit", () => {
      const f = { x: 100, y: -2000, width: 2000, height: 1200 };
      expect(fitFrame(f, [main], main)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
   });

   it("moves a frame with only a sliver on screen", () => {
      const f = { x: 1400, y: 100, width: 600, height: 700 };
      expect(fitFrame(f, [main], main).x).toBe(420);
   });

   it("no displays known: the fallback", () => {
      const f = { x: 10, y: 10, width: 300, height: 300 };
      expect(fitFrame(f, [], main)).toEqual({ x: 570, y: 300, width: 300, height: 300 });
   });
});
