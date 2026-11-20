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

   it("uses the cached titles without a Session list", async () => {
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

describe("Properties", () => {
   it("adds, edits and removes a property, checking key and value first", async () => {
      const { api } = await setup("t8");
      const update = vi.spyOn(api, "updateTask");
      const props = screen.getByRole("region", { name: "Properties" });
      expect(within(props).getByRole("button", { name: "Edit team: tools" })).toBeTruthy();

      fireEvent.click(within(props).getByRole("button", { name: "Add property" }));
      const key = within(props).getByRole("textbox", { name: "Property key" });
      const value = within(props).getByRole("textbox", { name: "Property value" });
      // Upper case is not a valid key: refused here, nothing is sent.
      fireEvent.change(key, { target: { value: "Area" } });
      fireEvent.change(value, { target: { value: "build" } });
      fireEvent.keyDown(value, { key: "Enter" });
      expect(within(props).getByRole("alert").textContent).toContain("Key: 1 to 32");
      fireEvent.change(key, { target: { value: "team" } });
      fireEvent.keyDown(value, { key: "Enter" });
      expect(within(props).getByRole("alert").textContent).toContain("already has team");
      fireEvent.change(key, { target: { value: "area" } });
      fireEvent.change(value, { target: { value: "x".repeat(65) } });
      fireEvent.keyDown(value, { key: "Enter" });
      expect(within(props).getByRole("alert").textContent).toContain("Value: 1 to 64");
      expect(update).not.toHaveBeenCalled();
      fireEvent.change(value, { target: { value: " build " } });
      fireEvent.keyDown(value, { key: "Enter" });
      expect(update).toHaveBeenLastCalledWith("t8", { props: { team: "tools", area: "build" } });
      await waitFor(() =>
         expect(within(props).getByRole("button", { name: "Edit area: build" })).toBeTruthy(),
      );

      fireEvent.click(within(props).getByRole("button", { name: "Edit team: tools" }));
      const edit = within(props).getByRole("textbox", { name: "Value of team" });
      fireEvent.change(edit, { target: { value: "infra" } });
      fireEvent.keyDown(edit, { key: "Enter" });
      expect(update).toHaveBeenLastCalledWith("t8", { props: { team: "infra", area: "build" } });
      await waitFor(() =>
         expect(within(props).getByRole("button", { name: "Edit team: infra" })).toBeTruthy(),
      );

      fireEvent.click(within(props).getByRole("button", { name: "Remove area" }));
      expect(update).toHaveBeenLastCalledWith("t8", { props: { team: "infra" } });
      await waitFor(async () =>
         expect((await api.readTask("t8")).props).toEqual({ team: "infra" }),
      );
      await waitFor(() =>
         expect(within(props).queryByRole("button", { name: /^Edit area/ })).toBeNull(),
      );
      expect(update).toHaveBeenCalledTimes(3);
   });
});

describe("Dependencies", () => {
   it("lists Blocked by and Blocks, and a click opens the linked task", async () => {
      const { onOpen } = await setup("t14");
      const blockedBy = screen.getByRole("region", { name: "Blocked by" });
      expect(blockedBy.textContent).toContain("Blocked by · 1");
      expect(within(blockedBy).getByText("Measure cold vs warm build")).toBeTruthy();
      const blocks = screen.getByRole("region", { name: "Blocks" });
      expect(blocks.textContent).toContain("Blocks · 2");
      // No × on the other side: those deps belong to the waiting tasks.
      expect(within(blocks).queryByRole("button", { name: /^Remove link/ })).toBeNull();
      fireEvent.click(within(blocks).getByText("Fix the updater signature check"));
      expect(onOpen).toHaveBeenCalledWith("t3");
      // t13 is done: nothing open to wait on.
      expect(screen.queryByText(/waits on/)).toBeNull();
   });

   it("shows waits on N and the follow-ups of a task", async () => {
      await setup("t4");
      // t4 waits on t3 (open) and follows t2.
      expect(screen.getByText("waits on 1")).toBeTruthy();
      const follows = screen.getByRole("group", { name: "Follows" });
      expect(within(follows).getByText("Write the changelog")).toBeTruthy();
   });

   it("adds a dep from the picker, with loops disabled, and removes one", async () => {
      const { api } = await setup("t14");
      const update = vi.spyOn(api, "updateTask");
      fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
      const list = await waitFor(() => screen.getByRole("listbox", { name: "Tasks" }));
      // t4 waits on t3, which waits on t14: a dep on t4 would make a loop.
      const loop = within(list).getByRole("option", { name: /Tag and publish the build/ });
      expect(loop.getAttribute("aria-disabled")).toBe("true");
      expect(loop.textContent).toContain("would make a loop");
      fireEvent.click(loop);
      expect(update).not.toHaveBeenCalled();
      // Already linked: not listed. Itself: not listed.
      expect(within(list).queryByRole("option", { name: /Measure cold vs warm build/ })).toBeNull();
      expect(within(list).queryByRole("option", { name: /CARGO_TARGET_DIR/ })).toBeNull();

      fireEvent.click(screen.getByRole("radio", { name: "follow-up" }));
      fireEvent.click(within(list).getByRole("option", { name: /Check disk use after a week/ }));
      // t15 waits on t14: a loop too, so pick one that does not.
      expect(update).not.toHaveBeenCalled();
      fireEvent.click(within(list).getByRole("option", { name: /Try the new Biome rules/ }));
      expect(update).toHaveBeenLastCalledWith("t14", {
         deps: [
            { id: "t13", kind: "blocks" },
            { id: "t8", kind: "follow_up" },
         ],
      });
      const follows = await waitFor(() => screen.getByRole("group", { name: "Follows" }));
      expect(within(follows).getByText("Try the new Biome rules")).toBeTruthy();

      fireEvent.click(
         screen.getByRole("button", { name: "Remove link to Measure cold vs warm build" }),
      );
      expect(update).toHaveBeenLastCalledWith("t14", { deps: [{ id: "t8", kind: "follow_up" }] });
      await waitFor(async () =>
         expect((await api.readTask("t14")).deps).toEqual([{ id: "t8", kind: "follow_up" }]),
      );
   });
});
