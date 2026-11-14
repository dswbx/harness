import type { SubagentRow } from "@harness/api";
import { describe, expect, test } from "vitest";
import type { PanelStatus } from "../panels/contract";
import { defaultLayout, type PanelId, slotPanel } from "./panelLayout";
import { PANELS, panelDef, zoneOfHint } from "./panels";
import { availablePanels } from "./viewState";

const row = (state: SubagentRow["state"]): SubagentRow => ({
   id: state,
   title: "t",
   type: null,
   model: null,
   modelInherited: false,
   effort: null,
   calls: 0,
   state,
   startedAt: null,
   endedAt: null,
});
const statusOf = (id: string, model: unknown): PanelStatus => panelDef(id)!.status(model);

/** The status of every registered panel, from the models they would have. */
type Facts = { git?: boolean; plans?: boolean; subagents?: SubagentRow[]; artifacts?: number };
const registered = (f: Facts = {}) =>
   new Map<string, PanelStatus>(
      PANELS.map((p) => {
         const models: Record<string, unknown> = {
            changes: { git: !!f.git },
            plan: { hasPlans: !!f.plans },
            artifacts: { artifacts: Array.from({ length: f.artifacts ?? 0 }) },
            references: { count: undefined },
            subagents: {
               rows: f.subagents ?? [],
               running: (f.subagents ?? []).filter((r) => r.state === "running").length,
            },
         };
         return [p.id, p.status(models[p.id] ?? null)];
      }),
   );
const none = { overlay: false, slotPanels: [] as PanelId[] };

describe("registry", () => {
   test("lists the panels in default order", () => {
      expect(PANELS.map((p) => p.id)).toEqual([
         "changes",
         "files",
         "plan",
         "artifacts",
         "references",
         "terminal",
         "events",
         "subagents",
      ]);
      expect(panelDef("subagents")?.label).toBe("Subagents");
      expect(panelDef("side")).toBeUndefined();
   });

   test("yields the default layout (Side chats sits before Plan)", () => {
      expect(defaultLayout().zones).toEqual({
         leftTop: ["artifacts"],
         leftBottom: ["references", "subagents"],
         bottomLeft: ["terminal"],
         bottomRight: ["events"],
         rightBottom: [],
         rightTop: ["changes", "files", "side", "plan"],
      });
   });

   test("labels and placements are what the stripes always showed", () => {
      expect(PANELS.map((p) => [p.id, p.label, zoneOfHint(p.placement)])).toEqual([
         ["changes", "Changes", "rightTop"],
         ["files", "Files", "rightTop"],
         ["plan", "Plan", "rightTop"],
         ["artifacts", "Artifacts", "leftTop"],
         ["references", "References", "leftBottom"],
         ["terminal", "Terminal", "bottomLeft"],
         ["events", "Events", "bottomRight"],
         ["subagents", "Subagents", "leftBottom"],
      ]);
   });

   test("only the Terminal stays mounted once opened; Events can expand", () => {
      for (const p of PANELS)
         expect(p.mount ?? "whenOpen").toBe(p.id === "terminal" ? "afterFirstOpen" : "whenOpen");
      expect(PANELS.filter((p) => p.expandable).map((p) => p.id)).toEqual(["events"]);
   });

   test("the Quick overlay shows no registered panel, only render_ui panels", () => {
      expect(PANELS.filter((p) => p.overlay)).toEqual([]);
   });

   test("Cmd+J is the Terminal's shortcut, and only Cmd+J", () => {
      const sc = panelDef("terminal")!.shortcut!;
      const key = (o: Partial<KeyboardEvent>) =>
         ({
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            code: "KeyJ",
            ...o,
         }) as KeyboardEvent;
      expect(sc.keys).toEqual(["⌘", "J"]);
      expect(sc.match(key({ metaKey: true }))).toBe(true);
      expect(sc.match(key({ metaKey: true, shiftKey: true }))).toBe(false);
      expect(sc.match(key({ ctrlKey: true }))).toBe(false);
      expect(sc.match(key({ metaKey: true, code: "KeyK" }))).toBe(false);
      expect(PANELS.filter((p) => p.shortcut).map((p) => p.id)).toEqual(["terminal"]);
   });
});

describe("zoneOfHint", () => {
   test.each([
      [{ edge: "left" }, "leftTop"],
      [{ edge: "left", end: true }, "leftBottom"],
      [{ edge: "bottom" }, "bottomLeft"],
      [{ edge: "bottom", end: true }, "bottomRight"],
      [{ edge: "right" }, "rightTop"],
      [{ edge: "right", end: true }, "rightBottom"],
   ] as const)("%j starts in %s", (hint, zone) => {
      expect(zoneOfHint(hint)).toBe(zone);
   });

   test("Events and Subagents start where they always did", () => {
      expect(zoneOfHint(panelDef("events")!.placement)).toBe("bottomRight");
      expect(zoneOfHint(panelDef("subagents")!.placement)).toBe("leftBottom");
   });
});

describe("Events status", () => {
   test("is always ready, without a badge", () => {
      expect(statusOf("events", null)).toEqual({ presence: "ready" });
   });
});

describe("Subagents status", () => {
   test("is absent without subagents", () => {
      expect(statusOf("subagents", { rows: [], running: 0 }).presence).toBe("absent");
   });
   test("is ready with some, badged by the running ones", () => {
      expect(statusOf("subagents", { rows: [row("running"), row("done")], running: 1 })).toEqual({
         presence: "ready",
         badge: 1,
      });
   });
   test("has no badge when none runs", () => {
      expect(statusOf("subagents", { rows: [row("done")], running: 0 }).badge).toBeUndefined();
   });
});

describe("Artifacts status", () => {
   test("is always ready, badged by the artifact count (0 too)", () => {
      expect(statusOf("artifacts", { artifacts: [] })).toEqual({ presence: "ready", badge: 0 });
      expect(statusOf("artifacts", { artifacts: [1, 2] })).toEqual({ presence: "ready", badge: 2 });
   });
});

describe("References status", () => {
   test("is always ready; the badge is the count once the lookups are done", () => {
      expect(statusOf("references", { count: undefined })).toEqual({
         presence: "ready",
         badge: undefined,
      });
      expect(statusOf("references", { count: 5 })).toEqual({ presence: "ready", badge: 5 });
   });
});

describe("Files and Terminal status", () => {
   test("are always ready, without a badge", () => {
      expect(statusOf("files", {})).toEqual({ presence: "ready" });
      expect(statusOf("terminal", null)).toEqual({ presence: "ready" });
   });
});

describe("Changes status", () => {
   test("is absent until the Workspace is a git repository", () => {
      expect(statusOf("changes", { git: false }).presence).toBe("absent");
      expect(statusOf("changes", { git: true }).presence).toBe("ready");
   });
});

describe("Plan status", () => {
   test("is absent until the Agent made a plan", () => {
      expect(statusOf("plan", { hasPlans: false }).presence).toBe("absent");
      expect(statusOf("plan", { hasPlans: true }).presence).toBe("ready");
   });
});

describe("availablePanels", () => {
   test("base panels without git, plans or subagents", () => {
      expect([...availablePanels({ ...none, registered: registered() })].sort()).toEqual(
         ["artifacts", "events", "files", "references", "side", "terminal"].sort(),
      );
   });
   test("git, plans and subagents each add one", () => {
      const a = (f: Facts) => availablePanels({ ...none, registered: registered(f) });
      expect(a({ git: true }).has("changes")).toBe(true);
      expect(a({ plans: true }).has("plan")).toBe(true);
      expect(a({ subagents: [row("done")] }).has("subagents")).toBe(true);
      expect(a({}).has("changes")).toBe(false);
      expect(a({}).has("plan")).toBe(false);
      expect(a({}).has("subagents")).toBe(false);
   });
   test("slot panels are always available", () => {
      const a = availablePanels({
         ...none,
         slotPanels: [slotPanel("a")],
         registered: registered(),
      });
      expect(a.has("slot:a")).toBe(true);
   });
   test("the overlay shows only slot panels, whatever else is set", () => {
      const a = availablePanels({
         overlay: true,
         slotPanels: [slotPanel("a")],
         registered: registered({ git: true, plans: true, subagents: [row("running")] }),
         overlayPanels: new Set(PANELS.filter((p) => p.overlay).map((p) => p.id)),
      });
      expect([...a]).toEqual(["slot:a"]);
   });
   test("the overlay also shows a registered panel marked for it", () => {
      const a = availablePanels({
         overlay: true,
         slotPanels: [],
         registered: registered({ git: true }),
         overlayPanels: new Set(["changes", "plan"]),
      });
      expect([...a]).toEqual(["changes"]);
   });
});
