import { describe, expect, test } from "vitest";
import type { PanelStatus } from "../panels/contract";
import { defaultLayout, type PanelId } from "./panelLayout";
import { availablePanels, renderablePanels, stripeGroup } from "./viewState";

const st = (o: Record<string, PanelStatus["presence"]>) =>
   new Map<string, PanelStatus>(Object.entries(o).map(([id, presence]) => [id, { presence }]));

test("renderablePanels keeps the ready panels: an icon-only one has nothing to show", () => {
   const a = new Set<PanelId>(["side", "files", "slot:a"]);
   expect([
      ...renderablePanels(a, st({ side: "icon", files: "ready", "slot:a": "ready" })),
   ]).toEqual(["files", "slot:a"]);
   expect(renderablePanels(a, st({ side: "ready" })).has("side")).toBe(true);
   expect(a.has("side")).toBe(true);
});

test("availablePanels: every panel with an icon; the overlay only those marked for it", () => {
   const statuses = st({ side: "icon", files: "ready", plan: "absent", "slot:a": "ready" });
   expect([...availablePanels({ overlay: false, statuses })]).toEqual(["side", "files", "slot:a"]);
   expect([
      ...availablePanels({ overlay: true, statuses, overlayPanels: new Set(["slot:a", "plan"]) }),
   ]).toEqual(["slot:a"]);
});

describe("stripeGroup", () => {
   const lay = defaultLayout();
   const base = (over: Record<string, unknown> = {}) => ({
      zones: { ...lay.zones, rightTop: ["files", "changes", "plan"] as PanelId[] },
      openIn: "files" as PanelId | null,
      available: new Set<PanelId>(["files", "plan"]),
      dot: (_id: PanelId): boolean | undefined => undefined,
      label: (id: PanelId) => `L:${id}`,
      tip: (id: PanelId) => `T:${id}`,
      count: (id: PanelId) => (id === "plan" ? 4 : undefined),
      shortcut: (id: PanelId) => (id === "files" ? ["x"] : undefined),
      icon: (id: PanelId) => `I:${id}`,
      ...over,
   });
   test("lists available panels with their index in the full zone list", () => {
      const g = stripeGroup("rightTop", base());
      expect(g.zone).toBe("rightTop");
      expect(g.items.map((i) => [i.id, i.index, i.on])).toEqual([
         ["files", 0, true],
         ["plan", 2, false],
      ]);
      expect(g.items[1]).toMatchObject({
         label: "L:plan",
         tip: "T:plan",
         count: 4,
         icon: "I:plan",
      });
      expect(g.items[0]!.shortcut).toEqual(["x"]);
   });
   test("an empty zone has no items", () => {
      expect(stripeGroup("leftTop", base({ zones: { ...lay.zones, leftTop: [] } })).items).toEqual(
         [],
      );
   });
   test("the dot comes from the panel's status", () => {
      const o = base({ zones: { ...lay.zones, rightTop: ["files"] }, dot: () => true });
      expect(stripeGroup("rightTop", o).items[0]!.dot).toBe(true);
      expect(stripeGroup("rightTop", base()).items[0]!.dot).toBe(false);
   });
});
