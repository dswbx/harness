import type { SessionSummary, Transport } from "@harness/api";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A panel window's URL; read when Solo loads.
vi.hoisted(() => window.history.replaceState({}, "", "/?session=s1&solo=1&pane=panel&panel=plan"));

const h = vi.hoisted(() => ({
   list: {
      sessions: [] as Pick<SessionSummary, "id" | "title" | "frontend_id">[],
      settled: false,
      loaded: false,
   },
   closeCurrentWindow: vi.fn(async () => {}),
   forgetPanelWindow: vi.fn(),
}));
vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   closeCurrentWindow: h.closeCurrentWindow,
   forgetPanelWindow: h.forgetPanelWindow,
   HarnessClient: class {},
}));
vi.mock("../sessions/useSessions", () => ({ useSessions: () => h.list }));
vi.mock("../sessions/useMarkSeen", () => ({ useMarkSeen: () => {} }));
vi.mock("../sessions/useTurnNotices", () => ({ useTurnNotices: () => {} }));
vi.mock("../platform/ViewHost", () => ({ ViewHost: () => <div data-testid="view" /> }));

import { Solo } from "./Solo";

beforeEach(() => {
   vi.clearAllMocks();
   h.list = { sessions: [], settled: false, loaded: false };
});
afterEach(cleanup);

const mount = () => render(<Solo transport={{} as Transport} sessionId="s1" />);

describe("Solo panel window", () => {
   it("a failed first Session load: does not close the window or remove its key", () => {
      h.list = { sessions: [], settled: true, loaded: false };
      const { container } = mount();
      expect(h.closeCurrentWindow).not.toHaveBeenCalled();
      expect(h.forgetPanelWindow).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Session not found");
   });

   it("a loaded list without the Session (deleted): removes its key and closes", () => {
      h.list = { sessions: [], settled: true, loaded: true };
      mount();
      expect(h.forgetPanelWindow).toHaveBeenCalledWith("s1", "plan");
      expect(h.closeCurrentWindow).toHaveBeenCalledTimes(1);
   });

   it("the Session is there: shows its View", () => {
      h.list = {
         sessions: [{ id: "s1", title: "Sample", frontend_id: "chat" }],
         settled: true,
         loaded: true,
      };
      const { getByTestId } = mount();
      expect(getByTestId("view")).toBeTruthy();
      expect(h.closeCurrentWindow).not.toHaveBeenCalled();
   });
});
