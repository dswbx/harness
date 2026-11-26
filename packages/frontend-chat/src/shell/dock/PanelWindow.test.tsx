import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelHeader } from "../../panels/PanelHeader";
import type { HostedPanel } from "../usePanelHost";
import { PanelWindow, projectOf } from "./PanelWindow";

const api = vi.hoisted(() => ({
   dockPanel: vi.fn(),
   closeCurrentWindow: vi.fn(async () => {}),
   showSession: vi.fn(async () => {}),
   popped: [{ session: "s1", panel: "plan" }] as { session: string; panel: string }[],
}));
vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   dockPanel: api.dockPanel,
   closeCurrentWindow: api.closeCurrentWindow,
   showSession: api.showSession,
   usePanelWindows: (session?: string) => api.popped.filter((w) => w.session === session),
}));

beforeEach(() => {
   vi.clearAllMocks();
   api.popped = [{ session: "s1", panel: "plan" }];
});
afterEach(cleanup);

const plan: HostedPanel = {
   id: "plan",
   label: "Plan",
   placement: { edge: "right" },
   overlay: false,
   mount: "whenOpen",
   self: { id: "plan", open: true, opened: true, target: null, show: () => {}, hide: () => {} },
   Body: () => (
      <>
         <PanelHeader title="Plan" />
         <div data-testid="plan-body" />
      </>
   ),
   props: {},
};

function setup(o: { entry?: HostedPanel; loaded?: boolean; archived?: boolean; panel?: string }) {
   return render(
      <TooltipProvider>
         <PanelWindow
            sessionId="s1"
            panelId={o.panel ?? "plan"}
            entry={o.entry}
            loaded={o.loaded ?? true}
            archived={o.archived ?? false}
            sessionTitle="Fix the parser"
            project="demo-app"
         />
      </TooltipProvider>,
   );
}

describe("PanelWindow", () => {
   it("shows the panel with the window header and sets the title", () => {
      setup({ entry: plan });
      expect(screen.getByTestId("plan-body")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Show session Fix the parser" })).toBeTruthy();
      expect(document.title).toBe("Plan · Fix the parser");
      expect(api.dockPanel).not.toHaveBeenCalled();
      expect(api.closeCurrentWindow).not.toHaveBeenCalled();
   });

   it("an unknown panel id once loaded: docks back and closes", () => {
      api.popped = [{ session: "s1", panel: "nope" }];
      setup({ panel: "nope" });
      expect(api.dockPanel).toHaveBeenCalledWith("s1", "nope");
      expect(api.closeCurrentWindow).toHaveBeenCalledTimes(1);
   });

   it("waits for the log before it calls a panel unknown", () => {
      setup({ loaded: false });
      expect(api.dockPanel).not.toHaveBeenCalled();
      expect(api.closeCurrentWindow).not.toHaveBeenCalled();
   });

   it("closes when its key is gone (docked from elsewhere)", () => {
      api.popped = [];
      setup({ entry: plan });
      expect(api.closeCurrentWindow).toHaveBeenCalledTimes(1);
      expect(api.dockPanel).not.toHaveBeenCalled();
   });

   it("archived: a notice with Dock back", () => {
      setup({ entry: plan, archived: true });
      expect(screen.getByRole("status").textContent).toContain(
         "Session archived. This panel is read-only.",
      );
      const buttons = screen.getAllByRole("button", { name: "Dock back" });
      fireEvent.click(buttons[buttons.length - 1]!);
      expect(api.dockPanel).toHaveBeenCalledWith("s1", "plan");
      expect(api.closeCurrentWindow).toHaveBeenCalledTimes(1);
   });

   it("the session chip shows the Session in the main window", () => {
      setup({ entry: plan });
      fireEvent.click(screen.getByRole("button", { name: "Show session Fix the parser" }));
      expect(api.showSession).toHaveBeenCalledWith("s1");
   });

   it("in a browser, leaving the page docks back", () => {
      setup({ entry: plan });
      window.dispatchEvent(new Event("pagehide"));
      expect(api.dockPanel).toHaveBeenCalledWith("s1", "plan");
   });
});

describe("projectOf", () => {
   it("names the folder, or Quick", () => {
      expect(projectOf({ folder: "/home/me/demo-app/" })).toBe("demo-app");
      expect(projectOf({ folder: "/tmp/q1", quick: true })).toBe("Quick");
      expect(projectOf(undefined)).toBeUndefined();
   });
});
