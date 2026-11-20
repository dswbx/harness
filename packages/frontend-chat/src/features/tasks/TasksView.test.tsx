import { HarnessClient, type Task } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksView } from "./TasksView";

// happy-dom has no layout: give the list's scroll viewport a height (and room to scroll: the virtual list
// clamps a scroll to it) and each virtual row one, so the list renders the rows in view (all of the
// fixture's, a part of a large list).
const VIEWPORT = 800;
const ROW = 36;
const viewport = (el: HTMLElement) => el.hasAttribute("data-radix-scroll-area-viewport");
const SIZES: Record<string, (el: HTMLElement) => number> = {
   clientHeight: (el) => (viewport(el) ? VIEWPORT : 0),
   scrollHeight: (el) => (viewport(el) ? 100 * VIEWPORT : 0),
   offsetHeight: (el) => (el.hasAttribute("data-index") ? ROW : 0),
};
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
   for (const [key, size] of Object.entries(SIZES)) {
      saved.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
      Object.defineProperty(HTMLElement.prototype, key, {
         configurable: true,
         get(this: HTMLElement) {
            return size(this);
         },
      });
   }
});
afterEach(() => {
   cleanup();
   for (const [key, d] of saved) {
      if (d) Object.defineProperty(HTMLElement.prototype, key, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
   }
   vi.restoreAllMocks();
   vi.unstubAllGlobals();
});

function setup(first: string | null = null, seed?: (tasks: Map<string, Task>) => void) {
   const mock = new MockTransport([], []);
   seed?.(mock.tasks);
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
const row = (text: string) => title(text).closest<HTMLElement>("[data-task-row]") as HTMLElement;
/** The group a row is in: its topic's id, "none" (No topic), "closed" (Done and cancelled), ... */
const groupOf = (text: string) => row(text).dataset.group;
/** A topic's row (it heads its group). */
const topic = (name: string) => {
   const r = row(name);
   expect(r.dataset.group).toBe(r.dataset.taskRow);
   return r;
};
const noTopic = () => document.querySelector('[data-group-head="No topic"]');

describe("All tasks view", () => {
   it("groups the open tasks by topic, then No topic, with the closed ones folded", async () => {
      setup();
      const release = await waitFor(() => topic("Release v2026.12"));
      expect(groupOf("Tag and publish the build")).toBe(release.dataset.taskRow);
      // Done subtasks are not in their topic; they wait in the folded group.
      expect(screen.queryByText("Write the changelog")).toBeNull();
      expect(noTopic()).toBeTruthy();
      expect(groupOf("Read the ACP registry RFC")).toBe("none");
      const closed = screen.getByRole("button", { name: /^Done and cancelled · \d+$/ });
      expect(closed.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(closed);
      expect(groupOf("Write the changelog")).toBe("closed");
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

   it("a tasks change keeps the folded topic of the selected task folded", async () => {
      const { client } = setup("t14");
      const name = "Shared CARGO_TARGET_DIR in the dev script";
      await waitFor(() => screen.getByRole("button", { name }));
      fireEvent.click(screen.getByRole("button", { name: "Fold Worktree reliability" }));
      expect(screen.queryByRole("button", { name })).toBeNull();
      await client.updateTask("t9", { title: "Read the RFC" });
      await waitFor(() => title("Read the RFC"));
      expect(screen.queryByRole("button", { name })).toBeNull();
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
         expect(groupOf("Read the ACP registry RFC")).toBe(
            topic("Release v2026.12").dataset.taskRow,
         ),
      );
   });

   it("filters by text and shows the topic of a match", async () => {
      setup();
      await waitFor(() => topic("Header polish"));
      fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), {
         target: { value: "branch names" },
      });
      expect(groupOf("Truncate long branch names")).toBe(topic("Header polish").dataset.taskRow);
      expect(screen.queryByRole("button", { name: "Release v2026.12" })).toBeNull();
      expect(noTopic()).toBeNull();
   });

   it("a click anywhere on a row selects it; its controls do not", async () => {
      const { onSelect } = setup();
      await waitFor(() => title("Read the ACP registry RFC"));
      const r = row("Read the ACP registry RFC");
      // The due column, not the title.
      fireEvent.click(r.children[2] as HTMLElement);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenLastCalledWith("t9");
      expect(row("Read the ACP registry RFC").getAttribute("aria-current")).toBe("true");
      // The status menu, the row menu and a topic's fold button do their own thing.
      fireEvent.click(within(r).getByRole("button", { name: /^Status: / }));
      fireEvent.click(
         within(r).getByRole("button", { name: "Actions for Read the ACP registry RFC" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Fold Release v2026.12" }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      // The title (the row's button, for the keyboard) selects once: here it unselects.
      fireEvent.click(title("Read the ACP registry RFC"));
      expect(onSelect).toHaveBeenCalledTimes(2);
      expect(onSelect).toHaveBeenLastCalledWith(null);
   });

   it("renders only the rows in view of a large list, and scrolls to the selected one", async () => {
      const N = 1000;
      const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo");
      setup("big900", (tasks) => {
         const base = tasks.get("t9") as Task;
         for (let i = 0; i < N; i++)
            tasks.set(`big${i}`, {
               ...base,
               id: `big${i}`,
               title: `Bulk task ${i}`,
               order: 1000 + i,
            });
      });
      await waitFor(() => title("Bulk task 0"));
      // The list scrolls down to the selected row (happy-dom does not scroll: only the call shows).
      await waitFor(() =>
         expect(scrollTo).toHaveBeenCalledWith(
            expect.objectContaining({ top: expect.any(Number) }),
         ),
      );
      const top = (scrollTo.mock.lastCall?.[0] as ScrollToOptions | undefined)?.top ?? 0;
      expect(top).toBeGreaterThan(900 * ROW - VIEWPORT);
      const rendered = document.querySelectorAll("[data-task-row]").length;
      expect(rendered).toBeGreaterThan(VIEWPORT / ROW / 2);
      expect(rendered).toBeLessThan(100);
      expect(screen.queryByRole("button", { name: `Bulk task ${N - 1}` })).toBeNull();
   });

   it("groups by a prop key from the group menu, with No <key> last, and keeps the choice", async () => {
      // The group-by is a stored value: give it a storage.
      const mem = new Map<string, string>();
      vi.stubGlobal("localStorage", {
         getItem: (k: string) => mem.get(k) ?? null,
         setItem: (k: string, v: string) => void mem.set(k, String(v)),
         removeItem: (k: string) => void mem.delete(k),
      });
      setup();
      await waitFor(() => topic("Header polish"));
      fireEvent.keyDown(screen.getByRole("button", { name: "Topic" }), { key: "Enter" });
      // The fields, then the prop keys in use.
      expect(screen.getAllByRole("menuitemradio").map((m) => m.textContent)).toEqual([
         "Status",
         "Topic",
         "Session",
         "component",
         "team",
      ]);
      fireEvent.click(screen.getByRole("menuitemradio", { name: "component" }));
      await waitFor(() => expect(groupOf("Truncate long branch names")).toBe("=console"));
      const heads = [...document.querySelectorAll<HTMLElement>("[data-group-head]")].map(
         (h) => h.dataset.groupHead,
      );
      expect(heads).toEqual(["console", "docs", "engine", "engine-api", "No component"]);
      expect(groupOf("Try the new Biome rules")).toBe("none");
      expect(mem.get("harness.tasks.groupBy")).toBe("prop:component");
      cleanup();
      setup();
      await waitFor(() => expect(groupOf("Truncate long branch names")).toBe("=console"));
   });

   it("Graph: the filtered tasks in lanes of the group-by; a click selects and floats the preview", async () => {
      const mem = new Map<string, string>([["harness.tasks.groupBy", "prop:component"]]);
      vi.stubGlobal("localStorage", {
         getItem: (k: string) => mem.get(k) ?? null,
         setItem: (k: string, v: string) => void mem.set(k, String(v)),
         removeItem: (k: string) => void mem.delete(k),
      });
      const { onSelect } = setup();
      await waitFor(() => screen.getByRole("tab", { name: "Graph" }));
      fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
      expect(mem.get("harness.tasks.view")).toBe("graph");
      const card = (id: string) => document.querySelector<HTMLElement>(`[data-graph-card="${id}"]`);
      await waitFor(() => expect(card("t14")).toBeTruthy());
      const lanes = [...document.querySelectorAll<HTMLElement>("[data-lane]")].map(
         (l) => l.dataset.lane,
      );
      expect(lanes).toEqual(["console", "docs", "engine", "engine-api", "No component"]);
      // The status filter is open: the done t13 does not show.
      expect(card("t13")).toBeNull();
      expect(screen.getByRole("button", { name: "Lines: blocks, follow-ups" })).toBeTruthy();
      fireEvent.click(within(card("t14")!).getByRole("button"));
      expect(onSelect).toHaveBeenCalledWith("t14");
      await waitFor(() => screen.getByRole("complementary", { name: "Task preview" }));
      expect(card("t14")!.getAttribute("aria-current")).toBe("true");
      // Its chain stays (t3 waits on it), the rest fades.
      expect(card("t3")!.dataset.faded).toBeUndefined();
      expect(card("t9")!.dataset.faded).toBe("true");
   });
});
