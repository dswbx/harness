import { HarnessClient, type SessionApi } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelBodyProps, PanelCtx, PanelSelf } from "../../panels/contract";
import { initialState } from "../../state/reducer";
import { type TasksModel, tasksPanel } from "./panel";

afterEach(cleanup);

const Body = tasksPanel.Body as ComponentType<PanelBodyProps<TasksModel, string>>;

function setup() {
   const mock = new MockTransport([], []);
   const api: SessionApi = new HarnessClient(mock).sessionApi("mock-1");
   const ctx: PanelCtx = {
      api,
      state: initialState(),
      variant: "full",
      open: vi.fn(),
      hide: vi.fn(),
      isOpen: () => true,
      chat: null,
      host: {},
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
});
