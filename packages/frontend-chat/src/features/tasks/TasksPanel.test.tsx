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
   vi.restoreAllMocks();
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

/** A task row's box (it carries the selected state). */
const rowBox = (title: string) => row(title).closest<HTMLElement>(".group\\/task") as HTMLElement;
/** The title of the task open in the sheet. */
const title = () => screen.queryByRole("textbox", { name: "Task title" })?.textContent;

/** A nested row's indent (its wrapper's left padding); null: top level. */
const indent = (el: HTMLElement) =>
   el.closest<HTMLElement>("[style*='padding-left']")?.style.paddingLeft ?? null;

describe("Tasks panel", () => {
   it("lists the open tasks created here, with Done folded", async () => {
      setup();
      const created = await waitFor(() => group(/^Open · 4$/));
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
      const created = await waitFor(() => group(/^Open · 4$/));
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
      const after = await waitFor(() => group(/^Open · 3$/));
      expect(within(row("Truncate long branch names", after)).queryByText(/waits on/)).toBeNull();
   });

   it("quick add creates the task in this Session", async () => {
      const { mock } = setup();
      await waitFor(() => group(/^Open · 4$/));
      await typeAndEnter("Add task", "Profile the cold build");
      await waitFor(() => group(/^Open · 5$/));
      const added = [...mock.tasks.values()].find((t) => t.title === "Profile the cold build");
      expect(added?.origin_session_id).toBe("mock-1");
      expect(row("Profile the cold build", group(/^Open · /))).toBeTruthy();
   });

   it("opens a task in the sheet below the list, swaps it and closes it", async () => {
      setup();
      const created = await waitFor(() => group(/^Open · 4$/));
      fireEvent.click(row("Header polish", created));
      const sheet = await waitFor(() => screen.getByRole("region", { name: "Task" }));
      const subtasks = await waitFor(() => within(sheet).getByRole("region", { name: "Subtasks" }));
      expect(row("Align the session title baseline", subtasks)).toBeTruthy();
      expect(within(subtasks).getByText("Subtasks · 1/3")).toBeTruthy();
      await waitFor(() => expect(title()).toBe("Header polish"));
      // The list stays, the open row is selected, and the sheet comes after it, outside its scroll area.
      expect(group(/^Open · 4$/)).toBe(created);
      expect(rowBox("Header polish").getAttribute("aria-current")).toBe("true");
      expect(
         created.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(created.closest("[data-radix-scroll-area-viewport]")?.contains(sheet)).toBe(false);
      // The detail's own status chip comes first, before the subtask rows.
      expect(within(sheet).getAllByRole("button", { name: "Status: Todo" })[0]?.textContent).toBe(
         "Todo",
      );
      // No host callbacks: no "Start session" and no "Open in All tasks".
      expect(screen.queryByRole("button", { name: /Start session/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open in All tasks" })).toBeNull();
      // A subtask link opens in the sheet; so does another row of the list.
      fireEvent.click(row("Truncate long branch names", subtasks));
      await waitFor(() => expect(title()).toBe("Truncate long branch names"));
      expect(rowBox("Truncate long branch names").getAttribute("aria-current")).toBe("true");
      expect(rowBox("Header polish").getAttribute("aria-current")).toBeNull();
      fireEvent.click(row("Read the ACP registry RFC", created));
      await waitFor(() => expect(title()).toBe("Read the ACP registry RFC"));
      // X closes it.
      fireEvent.click(within(sheet).getByRole("button", { name: "Close preview" }));
      expect(screen.queryByRole("region", { name: "Task" })).toBeNull();
      expect(rowBox("Read the ACP registry RFC").getAttribute("aria-current")).toBeNull();
      // Esc in the sheet or in the panel closes it too.
      fireEvent.click(row("Header polish", created));
      const again = await waitFor(() => screen.getByRole("region", { name: "Task" }));
      fireEvent.keyDown(again, { key: "Escape" });
      expect(screen.queryByRole("region", { name: "Task" })).toBeNull();
      fireEvent.click(row("Header polish", created));
      await waitFor(() => screen.getByRole("region", { name: "Task" }));
      fireEvent.keyDown(row("Read the ACP registry RFC", created), { key: "Escape" });
      expect(screen.queryByRole("region", { name: "Task" })).toBeNull();
   });

   it("adds a subtask under the open task", async () => {
      const { mock } = setup();
      await waitFor(() => group(/^Open · 4$/));
      fireEvent.click(row("Read the ACP registry RFC"));
      await waitFor(() => expect(title()).toBe("Read the ACP registry RFC"));
      fireEvent.click(screen.getByRole("button", { name: "Add subtask" }));
      await typeAndEnter("New subtask", "Note the open questions");
      await waitFor(() => expect(row("Note the open questions", group(/^Subtasks/))).toBeTruthy());
      const added = [...mock.tasks.values()].find((t) => t.title === "Note the open questions");
      expect(added?.parent_id).toBe("t9");
   });

   it("nests subtasks under their parent in the same group, without a parent chip", async () => {
      setup();
      const created = await waitFor(() => group(/^Open · 4$/));
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
      const created = await waitFor(() => group(/^Open · 4$/));
      fireEvent.click(row("Align the session title baseline", created));
      await waitFor(() => expect(title()).toBe("Align the session title baseline"));
      expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
      const line = screen.getByText("Sub-task of").parentElement as HTMLElement;
      const parent = within(line).getByRole("button", { name: /Header polish/ });
      expect(parent.textContent).toContain("1/3");
      fireEvent.click(parent);
      await waitFor(() => expect(title()).toBe("Header polish"));
      // A top-level task has no Sub-task of line.
      expect(screen.queryByText("Sub-task of")).toBeNull();
   });

   it("condensed rows hide the facts under the title, and the choice is kept", async () => {
      setup();
      await waitFor(() => group(/^Open · 4$/));
      const detail = row("Read the ACP registry RFC");
      expect(within(detail).getByRole("img", { name: "Medium priority" })).toBeTruthy();
      const toggle = screen.getByRole("button", { name: "Condensed" });
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
      await waitFor(() => group(/^Open · 4$/));
      expect(screen.getByRole("button", { name: "Condensed" }).getAttribute("aria-pressed")).toBe(
         "true",
      );
      expect(
         within(row("Read the ACP registry RFC")).queryByRole("img", { name: "Medium priority" }),
      ).toBeNull();
   });

   it("hovering a row shows its summary on the left", async () => {
      setup();
      const created = await waitFor(() => group(/^Open · 4$/));
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
      const created = await waitFor(() => group(/^Open · 4$/));
      fireEvent.pointerMove(row("Align the session title baseline", created), {
         pointerType: "mouse",
      });
      const card = await screen.findByRole("tooltip", {}, { timeout: 2000 });
      expect(card.textContent).toContain("Sub-task ofHeader polish");
      cleanup();
      setup();
      fireEvent.pointerMove(
         row("Read the ACP registry RFC", await waitFor(() => group(/^Open · /))),
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
         expect(row("Header polish", group(/^Open · /)).textContent).toContain("Schema refs v2");
         fireEvent.click(row("Fix the updater signature check", group(/^Started from$/)));
         const list = await waitFor(() => screen.getByRole("region", { name: "Sessions" }));
         expect(within(list).getByText("Header v2")).toBeTruthy();
         expect(screen.queryByText(/Compact header layout/)).toBeNull();
      });

      it("shows the cached titles, not as deleted, without a Session list", async () => {
         setup({ edit: linkT5 });
         expect((await hoverPinned()).textContent).toContain("Created inCompact header layout");
         expect(row("Header polish", group(/^Open · /)).textContent).toContain("Schema refs");
         fireEvent.click(row("Fix the updater signature check", group(/^Started from$/)));
         const list = await waitFor(() => screen.getByRole("region", { name: "Sessions" }));
         expect(within(list).getByText("Compact header layout")).toBeTruthy();
         expect(screen.queryByText(/\(deleted\)/)).toBeNull();
      });
   });

   it("the Graph switch shows this Session's open tasks, outside blockers dashed; the choice is kept", async () => {
      const openTasks = vi.fn();
      setup({ openTasks });
      await waitFor(() => group(/^Open · 4$/));
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
      await waitFor(() => expect(title()).toBe("Truncate long branch names"));
      // The graph stays, the open card is selected; another card swaps the sheet.
      expect(card("t7")!.getAttribute("aria-current")).toBe("true");
      fireEvent.click(within(card("t9")!).getByRole("button"));
      await waitFor(() => expect(card("t9")!.getAttribute("aria-current")).toBe("true"));
      expect(card("t7")!.getAttribute("aria-current")).toBeNull();
      expect(openTasks).toHaveBeenCalledTimes(1);
      cleanup();
      // Kept for the window: a new panel opens in the graph.
      setup();
      await waitFor(() => expect(card("t3")).toBeTruthy());
      expect(screen.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected")).toBe("true");
   });

   describe("Options row", () => {
      const options = () => document.querySelector<HTMLElement>("[data-tasks-options]")!;
      const groupButton = () => within(options()).getByRole("button", { name: /^Group: / });
      const card = (id: string) => document.querySelector<HTMLElement>(`[data-graph-card="${id}"]`);
      /** The list's sections, top to bottom. */
      const sections = () =>
         [...document.querySelectorAll<HTMLElement>("[data-tasks-body] section[aria-label]")].map(
            (el) => el.getAttribute("aria-label"),
         );
      const pick = (name: RegExp) => {
         fireEvent.keyDown(groupButton(), { key: "Enter" });
         fireEvent.click(screen.getByRole("menuitemradio", { name }));
      };

      it("sits under Add task in both views, with the density toggle and the counts", async () => {
         setup();
         await waitFor(() => group(/^Open · 4$/));
         const add = screen.getByRole("textbox", { name: "Add task" });
         expect(
            add.compareDocumentPosition(options()) & Node.DOCUMENT_POSITION_FOLLOWING,
         ).toBeTruthy();
         // The header keeps only the panel's actions.
         const toggle = within(options()).getByRole("button", { name: "Condensed" });
         expect(screen.getByRole("tablist", { name: "View" }).parentElement?.contains(toggle)).toBe(
            false,
         );
         expect(groupButton().textContent).toBe("Group: Status");
         expect(options().textContent).toContain("5 open · 1 done");
         fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
         await waitFor(() => expect(card("t3")).toBeTruthy());
         expect(options().textContent).toContain("5 open · 1 outside");
         expect(groupButton().textContent).toBe("Group: Status");
         // The toggle sets the cards' density too, and is kept.
         expect(card("t5")!.style.height).toBe("64px");
         fireEvent.click(within(options()).getByRole("button", { name: "Condensed" }));
         expect(card("t5")!.style.height).toBe("48px");
         expect(localStorage.getItem("harness.tasks.panelDensity")).toBe("condensed");
      });

      it("leaves out no done and no outside tasks from the counts", async () => {
         setup({
            edit: (m) => {
               m.tasks.delete("t10");
               const t3 = m.tasks.get("t3");
               if (t3) t3.deps = [];
            },
         });
         await waitFor(() => group(/^Open · 4$/));
         expect(options().textContent).toMatch(/5 open$/);
         fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
         await waitFor(() => expect(card("t3")).toBeTruthy());
         expect(options().textContent).toMatch(/5 open$/);
      });

      it("the menu has the fields, then the prop keys in use with their number of values", async () => {
         setup();
         await waitFor(() => group(/^Open · 4$/));
         fireEvent.keyDown(groupButton(), { key: "Enter" });
         expect(screen.getAllByRole("menuitemradio").map((m) => m.textContent)).toEqual([
            "StatusOpen / Done",
            "Topic",
            "Session",
            "component2 values",
         ]);
      });

      it("by status: Started from, Open, then Done folded", async () => {
         setup();
         await waitFor(() => group(/^Open · 4$/));
         expect(sections()).toEqual(["Started from", "Open · 4", "Done · 1"]);
         expect(
            screen.getByRole("button", { name: "Done · 1" }).getAttribute("aria-expanded"),
         ).toBe("false");
      });

      it("by a prop key: a section per value with counts, No <key> last, then Done; kept", async () => {
         setup();
         await waitFor(() => group(/^Open · 4$/));
         pick(/^component/);
         await waitFor(() => group(/^console · 2$/));
         expect(sections()).toEqual([
            "Started from",
            "console · 2",
            "docs · 1",
            "No component · 1",
            "Done · 1",
         ]);
         expect(row("Truncate long branch names", group(/^console · 2$/))).toBeTruthy();
         expect(row("Header polish", group(/^No component · 1$/))).toBeTruthy();
         expect(options().textContent).toContain("5 open · 1 done");
         expect(
            screen.getByRole("button", { name: "Done · 1" }).getAttribute("aria-expanded"),
         ).toBe("false");
         // A section folds.
         const head = screen.getByRole("button", { name: "console · 2" });
         fireEvent.click(head);
         expect(head.getAttribute("aria-expanded")).toBe("false");
         expect(
            within(group(/^console · 2$/)).queryByText("Truncate long branch names"),
         ).toBeNull();
         expect(localStorage.getItem("harness.tasks.panelGroupBy")).toBe("prop:component");
         cleanup();
         setup();
         await waitFor(() => group(/^console · 2$/));
      });

      it("is the panel's own: All tasks' group-by does not change it, nor it All tasks'", async () => {
         mem.set("harness.tasks.groupBy", "prop:team");
         setup();
         await waitFor(() => group(/^Open · 4$/));
         pick(/^Topic/);
         await waitFor(() => group(/^Header polish · 3$/));
         expect(localStorage.getItem("harness.tasks.panelGroupBy")).toBe("topic");
         expect(localStorage.getItem("harness.tasks.groupBy")).toBe("prop:team");
      });

      it("the graph by status: one lane per open status, in the status order", async () => {
         setup();
         await waitFor(() => group(/^Open · 4$/));
         fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
         await waitFor(() => expect(card("t3")).toBeTruthy());
         const lanes = [...document.querySelectorAll<HTMLElement>("[data-lane]")].map(
            (l) => l.dataset.lane,
         );
         expect(lanes).toEqual(["In progress", "In review", "Todo"]);
      });
   });

   it("docks the session note below the list, with a resize handle", async () => {
      setup();
      const created = await waitFor(() => group(/^Open · 4$/));
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

   describe("Session note bar", () => {
      const bar = () => screen.getByRole("button", { name: /^Session note/ });

      it("is open when the note has text, folds to a bar with its first line, and the choice is kept", async () => {
         setup();
         await waitFor(() => group(/^Open · 4$/));
         await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
         expect(bar().getAttribute("aria-expanded")).toBe("true");
         fireEvent.click(bar());
         expect(screen.queryByRole("textbox", { name: "Session note" })).toBeNull();
         const folded = bar();
         expect(folded.getAttribute("aria-expanded")).toBe("false");
         // The first line as plain text (no Markdown marks), and the save state.
         expect(folded.textContent).toBe("Session noteBuild timingsSaved");
         expect(localStorage.getItem("harness.tasks.noteOpen")).toBe("off");
         // The last row of the panel.
         const root = folded.parentElement as HTMLElement;
         expect(root.lastElementChild).toBe(folded);
         cleanup();
         setup();
         await waitFor(() => expect(bar().textContent).toContain("Build timings"));
         expect(bar().getAttribute("aria-expanded")).toBe("false");
         fireEvent.click(bar());
         await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
         expect(localStorage.getItem("harness.tasks.noteOpen")).toBe("on");
      });

      it("stays open when all its text is deleted", async () => {
         const { api } = setup();
         const editor = await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
         // As the autosave of an emptied note: written, then read again.
         await act(async () => {
            const note = await api.readNote();
            await api.writeNote("", note.hash);
            await new Promise((r) => setTimeout(r, 50));
         });
         expect(screen.getByRole("textbox", { name: "Session note" })).toBe(editor);
         expect(bar().getAttribute("aria-expanded")).toBe("true");
      });

      it("is folded by default when the note is empty", async () => {
         setup({ edit: (m) => m.notes.delete("mock-1") });
         await waitFor(() => group(/^Open · 4$/));
         expect(bar().getAttribute("aria-expanded")).toBe("false");
         expect(bar().textContent).toBe("Session note");
         expect(screen.queryByRole("textbox", { name: "Session note" })).toBeNull();
      });

      it("folds while a task is open and comes back as it was when it closes", async () => {
         setup();
         const created = await waitFor(() => group(/^Open · 4$/));
         await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
         fireEvent.click(row("Header polish", created));
         await waitFor(() => screen.getByRole("region", { name: "Task" }));
         expect(bar().getAttribute("aria-expanded")).toBe("false");
         // Not kept: the stored choice is unchanged.
         expect(localStorage.getItem("harness.tasks.noteOpen")).toBeNull();
         fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
         await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
         // Folded by the user: it stays folded after the task closes.
         fireEvent.click(bar());
         fireEvent.click(row("Header polish", created));
         await waitFor(() => screen.getByRole("region", { name: "Task" }));
         fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
         expect(bar().getAttribute("aria-expanded")).toBe("false");
         // Opening the note while a task is open closes the task.
         fireEvent.click(row("Header polish", created));
         await waitFor(() => screen.getByRole("region", { name: "Task" }));
         fireEvent.click(bar());
         expect(screen.queryByRole("region", { name: "Task" })).toBeNull();
         await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
         expect(localStorage.getItem("harness.tasks.noteOpen")).toBe("on");
      });
   });

   describe("Task sheet height", () => {
      /** The space under the toolbar is `px` high (jsdom does no layout). */
      const room = (px: number) =>
         vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
            this: HTMLElement,
         ) {
            return this.hasAttribute("data-tasks-body") ? px : 0;
         });
      const open = async () => {
         const created = await waitFor(() => group(/^Open · 4$/));
         fireEvent.click(row("Header polish", created));
         const sheet = await waitFor(() => screen.getByRole("region", { name: "Task" }));
         return { sheet, handle: within(sheet).getByRole("separator", { name: "Resize task" }) };
      };

      it("starts at half the space, resizes by keyboard and drag, and is kept", async () => {
         room(600);
         setup();
         const { sheet, handle } = await open();
         expect(sheet.style.height).toBe("300px");
         expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
         fireEvent.keyDown(handle, { key: "ArrowUp" });
         expect(sheet.style.height).toBe("316px");
         expect(localStorage.getItem("harness.tasks.sheetHeight")).toBe("316");
         fireEvent.keyDown(handle, { key: "ArrowDown" });
         fireEvent.keyDown(handle, { key: "ArrowDown" });
         expect(sheet.style.height).toBe("284px");
         // Esc on the handle closes the sheet; the height stays for the next task.
         fireEvent.keyDown(handle, { key: "Escape" });
         expect(screen.queryByRole("region", { name: "Task" })).toBeNull();
         const next = await open();
         expect(next.sheet.style.height).toBe("284px");
         // Dragging the handle up makes it taller.
         fireEvent.pointerDown(next.handle, { clientY: 500, pointerId: 1 });
         fireEvent.pointerMove(window, { clientY: 400, pointerId: 1 });
         fireEvent.pointerUp(window, { pointerId: 1 });
         expect(next.sheet.style.height).toBe("384px");
         expect(localStorage.getItem("harness.tasks.sheetHeight")).toBe("384");
         // Double-click resets to half.
         fireEvent.doubleClick(next.handle);
         expect(next.sheet.style.height).toBe("300px");
         expect(localStorage.getItem("harness.tasks.sheetHeight")).toBeNull();
      });

      /** The scroll area holding `el`: its root (the sheet's space as `--sheet-space`) and its viewport. */
      const scrollOf = (el: Element) => {
         const viewport = el.closest<HTMLElement>("[data-radix-scroll-area-viewport]")!;
         return {
            viewport,
            space: viewport.parentElement!.style.getPropertyValue("--sheet-space"),
         };
      };
      const spacer = () => document.querySelector<HTMLElement>("[data-sheet-spacer]");

      it("floats over the list, which keeps the sheet's space free at its end", async () => {
         room(600);
         setup();
         const { sheet, handle } = await open();
         // Over the bottom of the tasks area, not after the list in the flow.
         expect(sheet.className).toContain("absolute");
         expect(sheet.className).toContain("bottom-2");
         expect(sheet.parentElement?.hasAttribute("data-tasks-body")).toBe(true);
         // 300 px sheet + 8 px below it + 8 px air.
         await waitFor(() => expect(spacer()?.style.height).toBe("316px"));
         const list = scrollOf(spacer()!);
         expect(list.space).toBe("316px");
         expect(list.viewport.className).toContain("scroll-pb-(--sheet-space)");
         expect(list.viewport.contains(rowBox("Header polish"))).toBe(true);
         // The spacer follows the sheet height.
         fireEvent.keyDown(handle, { key: "ArrowUp" });
         expect(spacer()?.style.height).toBe("332px");
         expect(scrollOf(spacer()!).space).toBe("332px");
         // Closed: the usual 8 px end, no space kept.
         fireEvent.click(within(sheet).getByRole("button", { name: "Close preview" }));
         expect(spacer()?.style.height).toBe("8px");
         expect(scrollOf(spacer()!).space).toBe("0px");
      });

      it("brings the open task into view above the sheet, in the list and the graph", async () => {
         const scrolled: Element[] = [];
         const scrollIntoView = vi.fn(function (this: Element) {
            scrolled.push(this);
         });
         Object.defineProperty(Element.prototype, "scrollIntoView", {
            value: scrollIntoView,
            configurable: true,
            writable: true,
         });
         try {
            room(600);
            setup();
            await open();
            const selected = rowBox("Header polish");
            await waitFor(() => expect(scrolled).toContain(selected));
            expect(scrollIntoView).toHaveBeenLastCalledWith({
               block: "nearest",
               inline: "nearest",
            });
            // Scrolled with the scroll area's padding: the sheet's space at the bottom.
            expect(scrollOf(selected).space).toBe("316px");
            expect(scrollOf(selected).viewport.className).toContain("scroll-pb-(--sheet-space)");
            fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
            const card = await waitFor(() => {
               const c = document.querySelector<HTMLElement>(
                  '[data-graph-card][aria-current="true"]',
               );
               expect(c).toBeTruthy();
               return c!;
            });
            await waitFor(() => expect(scrolled).toContain(card));
            const graph = scrollOf(card);
            expect(graph.space).toBe("316px");
            expect(graph.viewport.className).toContain("scroll-pb-(--sheet-space)");
            expect(spacer()?.style.height).toBe("316px");
            expect(graph.viewport.contains(spacer())).toBe(true);
            // Back in the list: its row again.
            fireEvent.click(screen.getByRole("tab", { name: "List" }));
            await waitFor(() => expect(scrolled).toContain(rowBox("Header polish")));
         } finally {
            delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
         }
      });

      it("is clamped: at least 160 px, and 120 px always left for the tasks", async () => {
         localStorage.setItem("harness.tasks.sheetHeight", "1000");
         room(600);
         setup();
         const { sheet, handle } = await open();
         // 600 - 120 for the tasks - 8 margin.
         expect(sheet.style.height).toBe("472px");
         fireEvent.keyDown(handle, { key: "ArrowUp" });
         expect(sheet.style.height).toBe("472px");
         for (let i = 0; i < 30; i++) fireEvent.keyDown(handle, { key: "ArrowDown" });
         expect(sheet.style.height).toBe("160px");
      });
   });
});
