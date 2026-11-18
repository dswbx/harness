import { HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "./TasksView";

// The List / Tree switch and the fold state are stored values: give them a storage.
const mem = new Map<string, string>();
beforeEach(() => {
   mem.clear();
   vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
   });
});
afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
});

async function setup(first: string | null = null) {
   const client = new HarnessClient(new MockTransport([], []));
   const onSelect = vi.fn();
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
            onOpenSession={() => {}}
         />
      );
   }
   render(
      <TooltipProvider>
         <Host />
      </TooltipProvider>,
   );
   fireEvent.click(screen.getByRole("tab", { name: "Tree" }));
   await waitFor(() => node("t1"));
   return { onSelect };
}

const node = (id: string) => {
   const el = document.querySelector<HTMLElement>(`[data-tree-node="${id}"]`);
   if (!el) throw new Error(`no node ${id}`);
   return el;
};
const shownIds = () =>
   [...document.querySelectorAll<HTMLElement>("[data-tree-node]")].map((n) => n.dataset.treeNode);
const boxes = () =>
   [...document.querySelectorAll<HTMLElement>("[data-tree-node]")].map((n) =>
      n.getAttribute("style"),
   );

describe("All tasks tree", () => {
   it("shows the topics with their subtasks; a note links to the list for the rest", async () => {
      await setup();
      // Topics and subtasks (closed ones too: the tree has Hide done), not the loose top-level tasks.
      expect(shownIds()).toContain("t2");
      expect(shownIds()).toContain("t14");
      expect(shownIds()).not.toContain("t9");
      expect(screen.getByText(/5 top-level tasks without subtasks hidden/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show in List" }));
      expect(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("region", { name: "No topic" })).toBeTruthy();
   });

   it("folds and unfolds, Collapse all, Expand all and Hide done", async () => {
      await setup();
      const fold = screen.getByRole("button", { name: "Collapse Release v2026.12" });
      fireEvent.click(fold);
      expect(shownIds()).not.toContain("t3");
      const unfold = screen.getByRole("button", { name: "Expand Release v2026.12" });
      expect(unfold.textContent).toBe("+3");
      fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
      expect(shownIds()).toContain("t3");
      fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
      expect(shownIds().sort()).toEqual(["t1", "t11", "t5"]);
      fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
      fireEvent.click(screen.getByRole("button", { name: "Hide done" }));
      expect(shownIds()).not.toContain("t2");
      expect(shownIds()).not.toContain("t13");
      expect(shownIds()).toContain("t3");
   });

   it("the preview floats over the tree area and the nodes do not move", async () => {
      const { onSelect } = await setup();
      const before = boxes();
      const area = document.querySelector("[data-tree-area]") as HTMLElement;
      expect(screen.queryByRole("complementary", { name: "Task preview" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Header polish" }));
      expect(onSelect).toHaveBeenLastCalledWith("t5");
      const preview = screen.getByRole("complementary", { name: "Task preview" });
      // Inside the tree area, absolute: not a column beside it.
      expect(preview.parentElement).toBe(area);
      expect(preview.className).toMatch(/\babsolute\b/);
      expect(preview.style.width).toBe("");
      expect(boxes()).toEqual(before);
      expect(node("t5").getAttribute("aria-current")).toBe("true");
      await waitFor(() =>
         expect(within(preview).getByRole("textbox", { name: "Task title" }).textContent).toBe(
            "Header polish",
         ),
      );
      fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
      expect(onSelect).toHaveBeenLastCalledWith(null);
      expect(screen.queryByRole("complementary", { name: "Task preview" })).toBeNull();
      expect(boxes()).toEqual(before);
   });

   it("keeps the selected task and unfolds to it", async () => {
      localStorage.setItem(
         "harness.tasks.tree",
         JSON.stringify({ collapsed: ["t11", "t12"], hideDone: false }),
      );
      await setup("t14");
      await waitFor(() => expect(node("t14").getAttribute("aria-current")).toBe("true"));
      expect(screen.getByRole("complementary", { name: "Task preview" })).toBeTruthy();
   });
});
