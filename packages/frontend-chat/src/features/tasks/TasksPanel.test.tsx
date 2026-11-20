import { HarnessClient, type SessionApi } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelBodyProps, PanelCtx, PanelSelf } from "../../panels/contract";
import { initialState } from "../../state/reducer";
import type { SessionInfo } from "./ListView";
import { type TasksModel, tasksPanel } from "./panel";

// The row density and the note height are stored values: give them a storage.
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

const Body = tasksPanel.Body as ComponentType<PanelBodyProps<TasksModel, string>>;

function setup(
   o: {
      sessions?: ReadonlyMap<string, SessionInfo>;
      edit?: (mock: MockTransport) => void;
      openTasks?: (id?: string) => void;
   } = {},
) {
   const mock = new MockTransport([], []);
   o.edit?.(mock);
   const api: SessionApi = new HarnessClient(mock).sessionApi("mock-1");
   const ctx: PanelCtx = {
      api,
      state: initialState(),
      variant: "full",
      open: vi.fn(),
      hide: vi.fn(),
      isOpen: () => true,
      chat: null,
      host: { sessions: o.sessions, openTasks: o.openTasks },
   };
   const self: PanelSelf<string> = {
      id: "tasks",
      open: true,
      opened: true,
      show: () => {},
      hide: () => {},
      target: null,
   };
   function Panel() {
      const model = tasksPanel.useModel(ctx, self);
      return <Body model={model} ctx={ctx} self={self} />;
   }
   render(
      <TooltipProvider>
         <Panel />
      </TooltipProvider>,
   );
   return { mock, api };
}

/** Types `text` into the Lexical editor labelled `label` and presses Enter. */
async function typeAndEnter(label: string, text: string) {
   const el = screen.getByRole("textbox", { name: label });
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
   await act(async () => {
      fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
   });
}

const group = (name: RegExp) => screen.getByRole("region", { name });
/** A task row's open button: its name starts with the title (then its meta, e.g. a parent chip). */
const row = (title: string, within_: HTMLElement = document.body) =>
   within(within_).getByRole("button", { name: new RegExp(`^${title}`) });

/** A nested row's indent (its wrapper's left padding); null: top level. */
const indent = (el: HTMLElement) =>
   el.closest<HTMLElement>("[style*='padding-left']")?.style.paddingLeft ?? null;

describe("Tasks panel", () => {
   it("lists the open tasks created here, with Done folded", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      expect(row("Header polish", created)).toBeTruthy();
      expect(within(created).queryByText("Measure the header render time")).toBeNull();
      // t3 was started in this Session: pinned, not in the list.
      expect(row("Fix the updater signature check", group(/^Started from$/))).toBeTruthy();
      const done = screen.getByRole("button", { name: "Done · 1" });
      expect(done.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Measure the header render time")).toBeNull();
      fireEvent.click(done);
      expect(screen.getByText("Measure the header render time")).toBeTruthy();
   });

   it("shows waits on N under a row with open blockers", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      // t7 waits on t6, which is open; t5 waits on nothing.
      expect(
         within(row("Truncate long branch names", created)).getByText("waits on 1"),
      ).toBeTruthy();
      expect(within(row("Header polish", created)).queryByText(/waits on/)).toBeNull();
      cleanup();
      setup({
         edit: (m) => {
            const t6 = m.tasks.get("t6");
            if (t6) t6.status = "done";
         },
      });
      const after = await waitFor(() => group(/^Created here · 3$/));
      expect(within(row("Truncate long branch names", after)).queryByText(/waits on/)).toBeNull();
   });

   it("quick add creates the task in this Session", async () => {
      const { mock } = setup();
      await waitFor(() => group(/^Created here · 4$/));
      await typeAndEnter("Add task", "Profile the cold build");
      await waitFor(() => group(/^Created here · 5$/));
      const added = [...mock.tasks.values()].find((t) => t.title === "Profile the cold build");
      expect(added?.origin_session_id).toBe("mock-1");
      expect(row("Profile the cold build", group(/^Created here/))).toBeTruthy();
   });

   it("opens a task in full and goes back", async () => {
      setup();
      await waitFor(() => group(/^Created here · 4$/));
      fireEvent.click(row("Header polish"));
      const subtasks = await waitFor(() => group(/^Subtasks$/));
      expect(row("Align the session title baseline", subtasks)).toBeTruthy();
      expect(within(subtasks).getByText("Subtasks · 1/3")).toBeTruthy();
      await waitFor(() =>
         expect(screen.getByRole("textbox", { name: "Task title" }).textContent).toBe(
            "Header polish",
         ),
      );
      // The detail's own status chip comes first, before the subtask rows.
      expect(screen.getAllByRole("button", { name: "Status: Todo" })[0]?.textContent).toBe("Todo");
      // No host callbacks: no "Start session" and no "Open in All tasks".
      expect(screen.queryByRole("button", { name: /Start session/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open in All tasks" })).toBeNull();
      // A subtask opens in place.
      fireEvent.click(row("Truncate long branch names", subtasks));
      await waitFor(() =>
         expect(screen.getByRole("textbox", { name: "Task title" }).textContent).toBe(
            "Truncate long branch names",
         ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
      await waitFor(() => group(/^Created here · 4$/));
   });

   it("adds a subtask under the open task", async () => {
      const { mock } = setup();
      await waitFor(() => group(/^Created here · 4$/));
      fireEvent.click(row("Read the ACP registry RFC"));
      await waitFor(() => group(/^Subtasks$/));
      fireEvent.click(screen.getByRole("button", { name: "Add subtask" }));
      await typeAndEnter("New subtask", "Note the open questions");
      await waitFor(() => expect(row("Note the open questions", group(/^Subtasks/))).toBeTruthy());
      const added = [...mock.tasks.values()].find((t) => t.title === "Note the open questions");
      expect(added?.parent_id).toBe("t9");
   });

   it("nests subtasks under their parent in the same group, without a parent chip", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      const kid = row("Align the session title baseline", created);
      // Nested under "Header polish": indented one level, no chip naming the parent.
      expect(kid.textContent).not.toContain("Header polish");
      expect(indent(kid)).toBe("18px");
      expect(indent(row("Truncate long branch names", created))).toBe("18px");
      // Subtasks follow their parent, in the usual order.
      const order = within(created)
         .getAllByRole("button", { name: /^(Header polish|Align|Truncate|Read)/ })
         .map((b) => b.textContent?.slice(0, 12));
      expect(order).toEqual(["Read the ACP", "Header polis", "Truncate lon", "Align the se"]);
      // The top-level parent has no indent.
      expect(indent(row("Header polish", created))).toBeNull();
      // The pinned task's parent is not in the panel: it keeps its parent chip.
      expect(row("Fix the updater signature check", group(/^Started from$/)).textContent).toContain(
         "Release v2026.12",
      );
      // A done subtask of an open parent goes to Done, at the top level, with its parent chip.
      fireEvent.click(screen.getByRole("button", { name: "Done · 1" }));
      const done = row("Measure the header render time", group(/^Done/));
      expect(done.textContent).toContain("Header polish");
      expect(indent(done)).toBeNull();
   });

   it("shows the task title once, with the parent as a Sub-task of line", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      fireEvent.click(row("Align the session title baseline", created));
      await waitFor(() =>
         expect(screen.getByRole("textbox", { name: "Task title" }).textContent).toBe(
            "Align the session title baseline",
         ),
      );
      // The panel header has Back, not the title or a breadcrumb.
      const back = screen.getByRole("button", { name: "Back to tasks" });
      const header = back.closest<HTMLElement>(".border-b");
      expect(header?.textContent).not.toContain("Align the session title baseline");
      expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
      const line = screen.getByText("Sub-task of").parentElement as HTMLElement;
      const parent = within(line).getByRole("button", { name: /Header polish/ });
      expect(parent.textContent).toContain("1/3");
      fireEvent.click(parent);
      await waitFor(() =>
         expect(screen.getByRole("textbox", { name: "Task title" }).textContent).toBe(
            "Header polish",
         ),
      );
      // A top-level task has no Sub-task of line.
      expect(screen.queryByText("Sub-task of")).toBeNull();
   });

   it("condensed rows hide the facts under the title, and the choice is kept", async () => {
      setup();
      await waitFor(() => group(/^Created here · 4$/));
      const detail = row("Read the ACP registry RFC");
      expect(within(detail).getByRole("img", { name: "Medium priority" })).toBeTruthy();
      const toggle = screen.getByRole("button", { name: "Condensed list" });
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      const line = row("Read the ACP registry RFC");
      expect(within(line).queryByRole("img", { name: "Medium priority" })).toBeNull();
      // Due today: only a calendar mark is left.
      expect(within(line).getByRole("img", { name: /^Due / })).toBeTruthy();
      // Nesting stays.
      expect(indent(row("Align the session title baseline"))).toBe("18px");
      expect(localStorage.getItem("harness.tasks.panelDensity")).toBe("condensed");
      // A new panel starts condensed.
      cleanup();
      setup();
      await waitFor(() => group(/^Created here · 4$/));
      expect(
         screen.getByRole("button", { name: "Condensed list" }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
         within(row("Read the ACP registry RFC")).queryByRole("img", { name: "Medium priority" }),
      ).toBeNull();
   });

   it("hovering a row shows its summary on the left", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      fireEvent.pointerMove(row("Header polish", created), { pointerType: "mouse" });
      const card = await screen.findByRole("tooltip", {}, { timeout: 2000 });
      expect(card.textContent).toContain("Header polish");
      expect(card.textContent).toContain("StatusTodo");
      expect(card.textContent).toContain("Subtasks1/3 done");
      expect(card.textContent).toContain("Created inThis Session");
      // The description is read when the card opens.
      await waitFor(() =>
         expect(screen.getByRole("tooltip").textContent).toContain(
            "Small fixes found while reviewing the header.",
         ),
      );
      const content = document.querySelector<HTMLElement>("[data-side]");
      expect(content?.getAttribute("data-side")).toBe("left");
   });

   it("shows a subtask's parent, priority and due date in its summary", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      fireEvent.pointerMove(row("Align the session title baseline", created), {
         pointerType: "mouse",
      });
      const card = await screen.findByRole("tooltip", {}, { timeout: 2000 });
      expect(card.textContent).toContain("Sub-task ofHeader polish");
      cleanup();
      setup();
      fireEvent.pointerMove(
         row("Read the ACP registry RFC", await waitFor(() => group(/^Created here/))),
         {
            pointerType: "mouse",
         },
      );
      const other = await screen.findByRole("tooltip", {}, { timeout: 2000 });
      expect(other.textContent).toContain("PriorityMedium");
      expect(other.textContent).toContain("Due");
   });

   describe("Session titles", () => {
      /** "Header polish" (t5) also started a Session in mock-s2, so its row shows a Session chip. */
      const linkT5 = (mock: MockTransport) => {
         const t5 = mock.tasks.get("t5");
         if (t5) t5.sessions = [{ session_id: "mock-s2", title: "Schema refs", started_ms: 0 }];
      };
      const hoverPinned = async () => {
         const pinned = await waitFor(() => group(/^Started from$/));
         fireEvent.pointerMove(row("Fix the updater signature check", pinned), {
            pointerType: "mouse",
         });
         return screen.findByRole("tooltip", {}, { timeout: 2000 });
      };

      it("shows live titles of renamed Sessions in rows, the hover card and the drill-in", async () => {
         const sessions = new Map<string, SessionInfo>([
            ["mock-1", { title: "Mock session (fixture replay)" }],
            ["mock-s1", { title: "Header v2" }],
            ["mock-s2", { title: "Schema refs v2" }],
         ]);
         setup({ sessions, edit: linkT5 });
         expect((await hoverPinned()).textContent).toContain("Created inHeader v2");
         expect(row("Header polish", group(/^Created here/)).textContent).toContain(
            "Schema refs v2",
         );
         fireEvent.click(row("Fix the updater signature check", group(/^Started from$/)));
         const list = await waitFor(() => screen.getByRole("region", { name: "Sessions" }));
         expect(within(list).getByText("Header v2")).toBeTruthy();
         expect(screen.queryByText(/Compact header layout/)).toBeNull();
      });

      it("shows the cached titles, not as deleted, without a Session list", async () => {
         setup({ edit: linkT5 });
         expect((await hoverPinned()).textContent).toContain("Created inCompact header layout");
         expect(row("Header polish", group(/^Created here/)).textContent).toContain("Schema refs");
         fireEvent.click(row("Fix the updater signature check", group(/^Started from$/)));
         const list = await waitFor(() => screen.getByRole("region", { name: "Sessions" }));
         expect(within(list).getByText("Compact header layout")).toBeTruthy();
         expect(screen.queryByText(/\(deleted\)/)).toBeNull();
      });
   });

   it("the Graph switch shows this Session's open tasks, outside blockers dashed; the choice is kept", async () => {
      const openTasks = vi.fn();
      setup({ openTasks });
      await waitFor(() => group(/^Created here · 4$/));
      fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
      expect(localStorage.getItem("harness.tasks.panelView")).toBe("graph");
      const card = (id: string) => document.querySelector<HTMLElement>(`[data-graph-card="${id}"]`);
      await waitFor(() => expect(card("t3")).toBeTruthy());
      // Pinned and created here, open only: not the done t10, not t4 (another Session's).
      const ids = [...document.querySelectorAll<HTMLElement>("[data-graph-card]")]
         .map((c) => c.dataset.graphCard)
         .sort();
      expect(ids).toEqual(["t14", "t3", "t5", "t6", "t7", "t9"]);
      expect(screen.getByText("5 open · 1 outside")).toBeTruthy();
      // t3 waits on t14, made in another Session: a dashed outside card with its line.
      const ext = card("t14")!;
      expect(ext.dataset.outside).toBe("true");
      expect(ext.className).toContain("border-dashed");
      expect(card("t3")!.dataset.outside).toBeUndefined();
      expect(document.querySelector('[data-line="t14>t3"]')).toBeTruthy();
      // A click on it opens All tasks at it; a click on a task of this Session opens it here.
      fireEvent.click(within(ext).getByRole("button"));
      expect(openTasks).toHaveBeenCalledWith("t14");
      fireEvent.click(within(card("t7")!).getByRole("button"));
      await waitFor(() => screen.getByRole("button", { name: "Back to tasks" }));
      cleanup();
      // Kept for the window: a new panel opens in the graph.
      setup();
      await waitFor(() => expect(card("t3")).toBeTruthy());
      expect(screen.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected")).toBe("true");
   });

   it("docks the session note below the list, with a resize handle", async () => {
      setup();
      const created = await waitFor(() => group(/^Created here · 4$/));
      const note = screen.getByRole("region", { name: "Session note" });
      const handle = screen.getByRole("separator", { name: "Resize session note" });
      // Below the list and outside its scroll area.
      expect(created.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
         created.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      const list = created.closest("[data-radix-scroll-area-viewport]");
      expect(list?.contains(note)).toBe(false);
      expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
      const dock = handle.parentElement as HTMLElement;
      expect(dock.contains(note)).toBe(true);
      expect(dock.style.height).toBe("300px");
      // Dragging the handle down makes the note shorter and remembers it.
      fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
      fireEvent.pointerMove(window, { clientY: 600, pointerId: 1 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(dock.style.height).toBe("200px");
      expect(localStorage.getItem("harness:tasks-note-height")).toBe("200");
      // Double-click resets.
      fireEvent.doubleClick(handle);
      expect(dock.style.height).toBe("300px");
   });
});
