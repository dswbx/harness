import { HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "./TasksView";

afterEach(cleanup);

function setup(first: string | null = null) {
   const mock = new MockTransport([], []);
   const client = new HarnessClient(mock);
   const onSelect = vi.fn();
   const onOpenSession = vi.fn();
   function Host() {
      const [selected, setSelected] = useState(first);
      return (
         <TasksView
            client={client}
            selected={selected}
            onSelect={(id) => {
               onSelect(id);
               setSelected(id);
            }}
            sessions={[{ id: "mock-1", title: "Mock session (fixture replay)", status: "idle" }]}
            onOpenSession={onOpenSession}
         />
      );
   }
   render(
      <TooltipProvider>
         <Host />
      </TooltipProvider>,
   );
   return { mock, client, onSelect, onOpenSession };
}

/** A row's title button (its name is the title). */
const title = (text: string) => screen.getByRole("button", { name: text });
const topic = (name: string) => screen.getByRole("region", { name: `Topic ${name}` });

describe("All tasks view", () => {
   it("groups the open tasks by topic, then No topic, with the closed ones folded", async () => {
      setup();
      const release = await waitFor(() => topic("Release v2026.12"));
      expect(
         within(release).getByRole("button", { name: "Tag and publish the build" }),
      ).toBeTruthy();
      // Done subtasks are not in their topic; they wait in the folded group.
      expect(within(release).queryByText("Write the changelog")).toBeNull();
      const loose = screen.getByRole("region", { name: "No topic" });
      expect(within(loose).getByRole("button", { name: "Read the ACP registry RFC" })).toBeTruthy();
      const closed = screen.getByRole("button", { name: /^Done and cancelled · \d+$/ });
      expect(closed.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(closed);
      expect(title("Write the changelog")).toBeTruthy();
   });

   it("opens the preview beside the list and closes it", async () => {
      const { onSelect } = setup();
      await waitFor(() => topic("Header polish"));
      expect(screen.queryByRole("complementary", { name: "Task preview" })).toBeNull();
      fireEvent.click(title("Header polish"));
      expect(onSelect).toHaveBeenLastCalledWith("t5");
      const preview = screen.getByRole("complementary", { name: "Task preview" });
      // Docked: a column of its own width next to the list, which takes the rest.
      expect(preview.style.width).toBe("400px");
      expect(preview.parentElement?.contains(topic("Header polish"))).toBe(true);
      await waitFor(() =>
         expect(within(preview).getByRole("textbox", { name: "Task title" }).textContent).toBe(
            "Header polish",
         ),
      );
      expect(within(preview).queryByRole("button", { name: "Back to tasks" })).toBeNull();
      fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
      expect(onSelect).toHaveBeenLastCalledWith(null);
      expect(screen.queryByRole("complementary", { name: "Task preview" })).toBeNull();
   });

   it("opened at a nested task, unfolds its parent", async () => {
      setup("t14");
      const row = await waitFor(() =>
         screen.getByRole("button", { name: "Shared CARGO_TARGET_DIR in the dev script" }),
      );
      expect(row.closest("[data-task-row]")?.getAttribute("aria-current")).toBe("true");
   });

   it("Move under puts the task under the topic", async () => {
      const { mock, client } = setup();
      const move = vi.spyOn(client, "moveTask");
      await waitFor(() => title("Read the ACP registry RFC"));
      fireEvent.keyDown(
         screen.getByRole("button", { name: "Actions for Read the ACP registry RFC" }),
         { key: "Enter" },
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "Release v2026.12" }));
      expect(move).toHaveBeenCalledWith("t9", "t1", undefined);
      await waitFor(() => expect(mock.tasks.get("t9")?.parent_id).toBe("t1"));
      await waitFor(() =>
         expect(
            within(topic("Release v2026.12")).getByRole("button", {
               name: "Read the ACP registry RFC",
            }),
         ).toBeTruthy(),
      );
   });

   it("filters by text and shows the topic of a match", async () => {
      setup();
      await waitFor(() => topic("Header polish"));
      fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
         target: { value: "branch names" },
      });
      expect(
         within(topic("Header polish")).getByRole("button", { name: "Truncate long branch names" }),
      ).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Topic Release v2026.12" })).toBeNull();
      expect(screen.queryByRole("region", { name: "No topic" })).toBeNull();
   });
});
