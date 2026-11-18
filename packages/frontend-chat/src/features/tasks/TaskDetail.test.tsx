import { HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetail } from "./TaskDetail";

afterEach(cleanup);

async function setup(id: string) {
   const mock = new MockTransport([], []);
   const api = new HarnessClient(mock).sessionApi("mock-1");
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
            onBack={onClose}
            onClose={onClose}
            onOpen={onOpen}
         />
      </TooltipProvider>,
   );
   const title = await waitFor(() => screen.getByRole("textbox", { name: "Task title" }));
   return { onClose, onOpen, title };
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
