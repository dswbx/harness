import type { SubagentRow } from "@harness/api";
import { describe, expect, test } from "vitest";
import type { PanelStatus } from "../panels/contract";
import { defaultLayout } from "./dock/model";
import { FAMILIES, PANELS, zoneOfHint } from "./panels";
import { availablePanels } from "./viewState";

describe("persisted ids", () => {
   // These ids are stored in every Session's layout: renaming one loses the user's place for it.
   test("the registered panel ids and the family prefixes never change", () => {
      expect(PANELS.map((p) => p.id)).toEqual([
         "changes",
         "files",
         "side",
         "plan",
         "artifacts",
         "references",
         "terminal",
         "events",
         "subagents",
         "tasks",
      ]);
      expect(FAMILIES.map((f) => f.prefix)).toEqual(["slot"]);
   });
});

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
const panelDef = (id: string) => PANELS.find((p) => p.id === id);
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
            side: { open: [], count: 0 },
            subagents: {
               rows: f.subagents ?? [],
               running: (f.subagents ?? []).filter((r) => r.state === "running").length,
            },
         };
         return [p.id, p.status(models[p.id] ?? null)];
      }),
   );
const none = { overlay: false };
/** The status a render_ui panel has: always ready. */
const slotStatus = new Map<string, PanelStatus>([["slot:a", { presence: "ready" }]]);
const withSlot = (m: Map<string, PanelStatus>) => new Map([...m, ...slotStatus]);

describe("registry", () => {
   test("lists the panels in default order", () => {
      expect(PANELS.map((p) => p.id)).toEqual([
         "changes",
         "files",
         "side",
         "plan",
         "artifacts",
         "references",
         "terminal",
         "events",
         "subagents",
         "tasks",
      ]);
      expect(panelDef("subagents")?.label).toBe("Subagents");
      expect(panelDef("side")?.label).toBe("Side chats");
   });

   test("yields the default layout (Side chats sits before Plan)", () => {
      expect(defaultLayout().zones).toEqual({
         leftTop: ["artifacts"],
         leftBottom: ["references", "subagents"],
         bottomLeft: ["terminal"],
         bottomRight: ["events"],
         rightBottom: [],
         rightTop: ["changes", "files", "side", "plan", "tasks"],
      });
   });

   test("labels and placements are what the stripes always showed", () => {
      expect(PANELS.map((p) => [p.id, p.label, zoneOfHint(p.placement)])).toEqual([
         ["changes", "Changes", "rightTop"],
         ["files", "Files", "rightTop"],
         ["side", "Side chats", "rightTop"],
         ["plan", "Plan", "rightTop"],
         ["artifacts", "Artifacts", "leftTop"],
         ["references", "References", "leftBottom"],
         ["terminal", "Terminal", "bottomLeft"],
         ["events", "Events", "bottomRight"],
         ["subagents", "Subagents", "leftBottom"],
         ["tasks", "Tasks & Notes", "rightTop"],
      ]);
   });

   test("the Terminal and Tasks & Notes stay mounted once opened, Side chats while it has tabs; Events can expand", () => {
      const mounts: Record<string, string> = {
         terminal: "afterFirstOpen",
         tasks: "afterFirstOpen",
         side: "whileReady",
      };
      for (const p of PANELS) expect(p.mount ?? "whenOpen").toBe(mounts[p.id] ?? "whenOpen");
      expect(PANELS.filter((p) => p.expandable).map((p) => p.id)).toEqual(["events"]);
   });

   test("the Quick overlay shows no registered panel (Side chats included), only render_ui panels", () => {
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

describe("Side chats status", () => {
   test("has an icon always, and shows once a tab has something to show", () => {
      expect(statusOf("side", { open: [], count: 0, unread: 0, inlineCount: null })).toEqual({
         presence: "icon",
         badge: 0,
         dot: false,
         tip: "Side chats (⇧⌘B new)",
      });
      expect(statusOf("side", { open: ["a"], count: 3, unread: 1, inlineCount: null })).toEqual({
         presence: "ready",
         badge: 3,
         dot: true,
         tip: "Side chats (⇧⌘B new)",
      });
      // The Inline tab alone has something to show.
      expect(statusOf("side", { open: [], count: 1, unread: 0, inlineCount: 0 }).presence).toBe(
         "ready",
      );
   });
   test("has no shortcut of the generic kind: its key starts a new chat", () => {
      expect(panelDef("side")!.shortcut).toBeUndefined();
   });
});

describe("availablePanels", () => {
   test("base panels without git, plans or subagents", () => {
      expect([...availablePanels({ ...none, statuses: registered() })].sort()).toEqual(
         ["artifacts", "events", "files", "references", "side", "tasks", "terminal"].sort(),
      );
   });
   test("git, plans and subagents each add one", () => {
      const a = (f: Facts) => availablePanels({ ...none, statuses: registered(f) });
      expect(a({ git: true }).has("changes")).toBe(true);
      expect(a({ plans: true }).has("plan")).toBe(true);
      expect(a({ subagents: [row("done")] }).has("subagents")).toBe(true);
      expect(a({}).has("changes")).toBe(false);
      expect(a({}).has("plan")).toBe(false);
      expect(a({}).has("subagents")).toBe(false);
   });
   test("slot panels are always available", () => {
      const a = availablePanels({ ...none, statuses: withSlot(registered()) });
      expect(a.has("slot:a")).toBe(true);
   });
   test("the overlay shows only slot panels, whatever else is set", () => {
      const a = availablePanels({
         overlay: true,
         statuses: withSlot(registered({ git: true, plans: true, subagents: [row("running")] })),
         overlayPanels: new Set([...PANELS.filter((p) => p.overlay).map((p) => p.id), "slot:a"]),
      });
      expect([...a]).toEqual(["slot:a"]);
   });
   test("the overlay also shows a registered panel marked for it", () => {
      const a = availablePanels({
         overlay: true,
         statuses: registered({ git: true }),
         overlayPanels: new Set(["changes", "plan"]),
      });
      expect([...a]).toEqual(["changes"]);
   });
});
