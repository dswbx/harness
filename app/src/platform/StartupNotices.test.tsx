import type { AppEvent, StartupNotice } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const revealPath = vi.fn(async () => {});
vi.mock("@harness/api", async (orig) => ({ ...(await orig<object>()), revealPath }));

const { StartupNotices } = await import("./StartupNotices");
const { ToastProvider } = await import("./toast");

const notice = (file: string): StartupNotice => ({
   file,
   kind: "unreadable",
   path: `/data/${file}`,
   copy: `/data/${file}.unreadable-1`,
   message: `${file} was reset.`,
});

afterEach(() => {
   cleanup();
   revealPath.mockClear();
});

function setup(notices: StartupNotice[]) {
   const transport = new MockTransport([], []);
   transport.notices = notices;
   render(
      <ToastProvider>
         <StartupNotices transport={transport} />
      </ToastProvider>,
   );
   return transport;
}

describe("StartupNotices", () => {
   it("shows each notice once, sticky, and reveals the kept copy", async () => {
      const t = setup([notice("permissions.json")]);
      await screen.findByText("permissions.json was reset.");
      // A NoticesChanged with nothing new shows nothing again.
      await act(async () => {
         (t as unknown as { emitApp(e: AppEvent): void }).emitApp({ type: "NoticesChanged" });
      });
      expect(screen.getAllByText("permissions.json was reset.")).toHaveLength(1);
      fireEvent.click(screen.getByText("Show file"));
      expect(revealPath).toHaveBeenCalledWith("/data/permissions.json.unreadable-1");
   });

   it("a file read later is shown when announced", async () => {
      const t = setup([]);
      await waitFor(() => expect(t.notices).toEqual([]));
      t.notices = [notice("editor.json")];
      await act(async () => {
         (t as unknown as { emitApp(e: AppEvent): void }).emitApp({ type: "NoticesChanged" });
      });
      await screen.findByText("editor.json was reset.");
   });

   it("is dismissible", async () => {
      setup([notice("mcp.json")]);
      await screen.findByText("mcp.json was reset.");
      fireEvent.click(screen.getByLabelText("Dismiss"));
      expect(screen.queryByText("mcp.json was reset.")).toBeNull();
   });
});
