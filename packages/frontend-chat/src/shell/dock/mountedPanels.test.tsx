import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedPanel } from "../usePanelHost";
import { mountedPanels } from "./mountedPanels";

const api = vi.hoisted(() => ({ focus: vi.fn(async () => true), dock: vi.fn() }));
vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   focusPanelWindow: api.focus,
   dockPanel: api.dock,
}));

const entry = (id: string, mount: HostedPanel["mount"], opened = false): HostedPanel => ({
   id,
   label: id,
   placement: { edge: "right" },
   overlay: false,
   mount,
   self: { id, open: false, opened, show() {}, hide() {}, target: null },
   Body: () => null,
   props: {},
});

describe("mountedPanels", () => {
   const entries = [
      entry("a", "whenOpen"),
      entry("b", "afterFirstOpen", true),
      entry("c", "afterFirstOpen", false),
      entry("d", "whileReady"),
   ];
   it("mounts by the panel's own rule: shown, once opened, or while it can render", () => {
      const ids = (shown: string[], renderable: string[]) =>
         mountedPanels(entries, (id) => shown.includes(id), new Set(renderable)).map((p) => p.id);
      expect(ids([], [])).toEqual(["b"]);
      expect(ids(["a", "c"], [])).toEqual(["a", "b"]);
      expect(ids([], ["d", "a"])).toEqual(["b", "d"]);
   });
   it("keeps the registry's order", () => {
      expect(mountedPanels(entries, () => true, new Set(["d"])).map((p) => p.id)).toEqual([
         "a",
         "b",
         "d",
      ]);
   });
});

describe("mountedPanels: popped panels", () => {
   afterEach(cleanup);
   const body = vi.fn(() => <div data-testid="body" />);
   const plan: HostedPanel = {
      ...entry("plan", "afterFirstOpen", true),
      label: "Plan",
      Body: body,
   };

   it("a shown popped panel gets its header and the placeholder, never the body", () => {
      const panels = mountedPanels([plan], () => true, new Set(), new Map(), {
         sessionId: "s1",
         ids: new Set(["plan"]),
      });
      expect(panels.map((p) => [p.id, p.popped])).toEqual([["plan", true]]);
      render(<TooltipProvider>{panels[0]!.children}</TooltipProvider>);
      expect(screen.getByText("Plan is open in its own window.")).toBeTruthy();
      expect(screen.queryByTestId("body")).toBeNull();
      expect(body).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Show window" }));
      expect(api.focus).toHaveBeenCalledWith("s1", "plan");
      fireEvent.click(screen.getByRole("button", { name: "Dock back" }));
      expect(api.dock).toHaveBeenCalledWith("s1", "plan");
   });

   it("a hidden popped panel is not mounted, even once opened", () => {
      const ids = mountedPanels([plan], () => false, new Set(), new Map(), {
         sessionId: "s1",
         ids: new Set(["plan"]),
      }).map((p) => p.id);
      expect(ids).toEqual([]);
   });

   it("a recorded (not loaded) popped panel shows the placeholder too", () => {
      const panels = mountedPanels([], () => true, new Set(), new Map([["slot:x", "Board"]]), {
         sessionId: "s1",
         ids: new Set(["slot:x"]),
      });
      render(<TooltipProvider>{panels[0]!.children}</TooltipProvider>);
      expect(screen.getByText("Board is open in its own window.")).toBeTruthy();
   });
});
