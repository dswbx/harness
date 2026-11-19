import { HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./ListView";
import { TaskDetail } from "./TaskDetail";

afterEach(() => {
   cleanup();
   vi.restoreAllMocks();
});

/** Puts `text` in the Lexical editor `el` (as typing would). */
async function typeIn(el: HTMLElement, text: string) {
   const editor = (el as unknown as { __lexicalEditor: LexicalEditor }).__lexicalEditor;
   await act(async () => {
      editor.update(
         () => {
            const p = $createParagraphNode().append($createTextNode(text));
            $getRoot().clear().append(p);
            p.selectEnd();
         },
         { discrete: true },
      );
   });
}

async function setup(
   id: string,
   o: { session?: string; sessions?: ReadonlyMap<string, SessionInfo> } = {},
) {
   const mock = new MockTransport([], []);
   const api = new HarnessClient(mock).sessionApi(o.session ?? "mock-1");
   const tasks = await api.listTasks();
   const onClose = vi.fn();
   const onOpen = vi.fn();
   render(
      <TooltipProvider>
         <TaskDetail
            api={api}
            id={id}
            tasks={tasks}
            host={{}}
            sessions={o.sessions}
            onBack={onClose}
            onClose={onClose}
            onOpen={onOpen}
         />
      </TooltipProvider>,
   );
   const title = await waitFor(() => screen.getByRole("textbox", { name: "Task title" }));
   return { mock, api, onClose, onOpen, title };
}

describe("Task preview header", () => {
   it("puts the menu and close on the title row, and the parent on a Sub-task of line", async () => {
      const { onClose, onOpen, title } = await setup("t12");
      // No header bar or breadcrumb above the title.
      expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Back to tasks" })).toBeNull();
      const titleRow = title.closest(".flex.items-start");
      const close = screen.getByRole("button", { name: "Close preview" });
      expect(titleRow?.contains(close)).toBe(true);
      expect(titleRow?.contains(screen.getByRole("button", { name: "Task options" }))).toBe(true);
      // The direct parent only (not "Worktree reliability"'s own parent), with its progress.
      const line = screen.getByText("Sub-task of").parentElement as HTMLElement;
      const parent = within(line).getByRole("button", { name: /Worktree reliability/ });
      expect(parent.textContent).toContain("0/4");
      fireEvent.click(parent);
      expect(onOpen).toHaveBeenCalledWith("t11");
      fireEvent.click(close);
      expect(onClose).toHaveBeenCalled();
   });

   it("has no Sub-task of line for a top-level task", async () => {
      await setup("t11");
      expect(screen.queryByText("Sub-task of")).toBeNull();
   });
});

describe("Session titles", () => {
   it("shows live titles of renamed Sessions, and a deleted one as deleted", async () => {
      const sessions = new Map<string, SessionInfo>([
         ["mock-s1", { title: "Header v2" }],
         ["mock-1", { title: "Fixture replay, renamed" }],
      ]);
      await setup("t3", { session: "mock-other", sessions });
      // Created in, the Sessions list and the Activity: live titles, not the cached ones.
      expect(screen.getAllByText("Header v2").length).toBe(2);
      const list = screen.getByRole("region", { name: "Sessions" });
      expect(within(list).getByText("Fixture replay, renamed")).toBeTruthy();
      expect(screen.getByText(/started a Session from it: Fixture replay, renamed/)).toBeTruthy();
      expect(screen.queryByText(/Compact header layout/)).toBeNull();
      expect(screen.queryByText(/Mock session \(fixture replay\)/)).toBeNull();
      cleanup();
      await setup("t18", { session: "mock-other", sessions });
      expect(screen.getAllByText("Old worktree cleanup (deleted)").length).toBeGreaterThan(0);
   });

   it("uses the cached titles without a Session list (the panel)", async () => {
      await setup("t3", { session: "mock-other" });
      expect(screen.getAllByText("Compact header layout").length).toBe(2);
   });
});

describe("Title editor", () => {
   it("keeps a title whose save failed, and saves it on the next blur", async () => {
      const { api, title } = await setup("t11");
      const update = vi.spyOn(api, "updateTask").mockRejectedValueOnce(new Error("disk full"));
      fireEvent.focusIn(title);
      await typeIn(title, "Worktree reliability v2");
      await act(async () => fireEvent.focusOut(title));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("disk full"));
      expect(title.textContent).toBe("Worktree reliability v2");
      // The next blur tries again.
      fireEvent.focusIn(title);
      await act(async () => fireEvent.focusOut(title));
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      expect(update.mock.calls[1]?.[1]).toEqual({ title: "Worktree reliability v2" });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
   });

   it("loads a title changed elsewhere while focused once it loses focus", async () => {
      const { api, title } = await setup("t11");
      fireEvent.focusIn(title);
      await act(async () => {
         await api.updateTask("t11", { title: "Renamed elsewhere" });
         // The changed task is read again while the title has focus.
         await new Promise((r) => setTimeout(r, 50));
      });
      expect(title.textContent).toBe("Worktree reliability");
      await act(async () => fireEvent.focusOut(title));
      await waitFor(() => expect(title.textContent).toBe("Renamed elsewhere"));
   });
});

describe("Description", () => {
   it("saves on blur, checked against the body it loaded", async () => {
      const { api } = await setup("t1");
      const update = vi.spyOn(api, "updateTask");
      const loaded = (await api.readTask("t1")).body_updated_ms;
      const body = screen.getByRole("textbox", { name: "Task description" });
      await waitFor(() => expect(body.textContent).toContain("Ship the December release."));
      await typeIn(body, "Ship it.");
      await act(async () => fireEvent.focusOut(body));
      await waitFor(() => expect(update).toHaveBeenCalledWith("t1", { body: "Ship it." }, loaded));
      await waitFor(async () => expect((await api.readTask("t1")).body).toBe("Ship it."));
   });
});
