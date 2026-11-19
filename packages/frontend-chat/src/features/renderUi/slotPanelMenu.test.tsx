import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PanelChrome, PanelContext } from "../../panels/PanelHeader";
import type { UiEnv } from "./RenderUi";
import { SlotPanel } from "./slotPanels";
import type { Slot } from "./slots";

vi.mock("./RenderUi", () => ({ RenderUi: () => null }));
// A few lucide names instead of the real table of 1700 chunks.
vi.mock("lucide-react/dynamicIconImports", () => {
   const icon = (n: string) => () =>
      Promise.resolve({ default: (p: object) => <svg data-testid={`lucide-${n}`} {...p} /> });
   return {
      default: {
         anchor: icon("anchor"),
         "git-fork": icon("git-fork"),
         "git-graph": icon("git-graph"),
         "arrow-up": icon("arrow-up"),
      },
   };
});

afterEach(cleanup);

const chrome: PanelChrome = {
   id: "slot:p",
   label: "Panel",
   moves: [],
   expandable: false,
   expanded: false,
   onExpand: () => {},
   onMove: () => {},
   onHide: () => {},
   onDragStart: () => {},
};
const slot = (over: Partial<Slot> = {}): Slot => ({
   id: "p",
   title: "Release notes",
   icon: "file",
   root: { type: "Markdown" } as never,
   files: {},
   ts: 1,
   source: null,
   agent: null,
   ...over,
});

function setup(props: { slot?: Slot; shared?: boolean } = {}) {
   const onEdit = vi.fn(async () => {});
   const onDelete = vi.fn(async () => {});
   const onDetach = vi.fn();
   const shared = props.shared;
   render(
      <TooltipProvider>
         <PanelContext.Provider value={chrome}>
            <SlotPanel
               slot={props.slot ?? slot()}
               env={{} as UiEnv}
               updated={0}
               onShowInArtifacts={() => {}}
               onEdit={onEdit}
               onDelete={shared ? undefined : onDelete}
               onShare={shared ? undefined : () => {}}
               shared={shared ? { meta: undefined, onDetach } : undefined}
            />
         </PanelContext.Provider>
      </TooltipProvider>,
   );
   fireEvent.keyDown(screen.getByRole("button", { name: "Panel options" }), { key: "Enter" });
   return { onEdit, onDelete, onDetach };
}
/** The panel's own entries: the header adds Move to after them. */
const items = () => {
   const all = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
   return all.slice(0, all.indexOf("Move to"));
};

describe("panel menu", () => {
   it("a panel of the Agent starts with Rename and icon and ends with Delete panel", () => {
      setup();
      const all = items();
      expect(all[0]).toBe("Rename and icon…");
      expect(all.at(-1)).toBe("Delete panel…");
      expect(all).not.toContain("Detach from Session");
   });

   it("a shared panel ends with Detach from Session and cannot be deleted", () => {
      const { onDetach } = setup({ shared: true, slot: slot({ source: "shared:notes-3f9a1c" }) });
      const all = items();
      expect(all[0]).toBe("Rename and icon…");
      expect(all.at(-1)).toBe("Detach from Session");
      expect(all).not.toContain("Delete panel…");
      fireEvent.click(screen.getByRole("menuitem", { name: /Detach from Session/ }));
      expect(onDetach).toHaveBeenCalled();
   });
});

describe("rename and icon popover", () => {
   const open = () => fireEvent.click(screen.getByRole("menuitem", { name: /Rename and icon/ }));

   it("saves the title and the picked icon; Agent's own values go as null", async () => {
      const { onEdit } = setup();
      open();
      const input = (await screen.findByLabelText("Title")) as HTMLInputElement;
      expect(input.value).toBe("Release notes");
      expect(screen.getByRole("radio", { name: "file" }).getAttribute("aria-checked")).toBe("true");
      fireEvent.change(input, { target: { value: "  Ship   list " } });
      fireEvent.click(screen.getByRole("radio", { name: "star" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith("Ship list", "star"));
   });

   it("an unchanged title is not stored as an override; Enter saves", async () => {
      const { onEdit } = setup();
      open();
      const input = await screen.findByLabelText("Title");
      fireEvent.click(screen.getByRole("radio", { name: "star" }));
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith(null, "star"));
   });

   it("an edited panel shows the Agent's title and can go back to it", async () => {
      const { onEdit } = setup({
         slot: slot({ title: "Mine", agent: { title: "Release notes", icon: "file" } }),
      });
      open();
      await screen.findByText("Agent called it “Release notes”");
      fireEvent.click(screen.getByRole("button", { name: "Use Agent's" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith(null, null));
   });

   it("changing only the icon of a renamed panel the Agent left untitled keeps the rename", async () => {
      const { onEdit } = setup({
         slot: slot({ title: "Mine", icon: "file", agent: { title: null, icon: "file" } }),
      });
      open();
      await screen.findByLabelText("Title");
      fireEvent.click(screen.getByRole("radio", { name: "star" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith("Mine", "star"));
   });

   it("the id is the untitled panel's baseline: typing it back clears the rename", async () => {
      const { onEdit } = setup({
         slot: slot({ title: "Mine", icon: "file", agent: { title: null, icon: "file" } }),
      });
      open();
      fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "p" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith(null, null));
   });

   it("a shared panel has no Use Agent's and saves title and icon as they are", async () => {
      const { onEdit } = setup({ shared: true, slot: slot({ source: "shared:notes-3f9a1c" }) });
      open();
      await screen.findByLabelText("Title");
      expect(screen.queryByRole("button", { name: "Use Agent's" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith("Release notes", "file"));
   });

   it("search lists all icons, ignoring case, dashes and spaces; picking one saves its name", async () => {
      const { onEdit } = setup();
      open();
      const search = await screen.findByLabelText("Search icons");
      expect(screen.queryByRole("radio", { name: "anchor" })).toBeNull();
      fireEvent.change(search, { target: { value: "Git Fo" } });
      const hit = await screen.findByRole("radio", { name: "git-fork" });
      expect(screen.queryByRole("radio", { name: "git-graph" })).toBeNull();
      expect(screen.queryByRole("radio", { name: "file" })).toBeNull();
      fireEvent.click(hit);
      fireEvent.change(search, { target: { value: "" } });
      // Not in the Agent's list: shown first, selected.
      const radios = screen.getAllByRole("radio");
      expect(radios[0].getAttribute("aria-label")).toBe("git-fork");
      expect(radios[0].getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onEdit).toHaveBeenCalledWith(null, "git-fork"));
   });

   it("says so when no icon matches; Enter in the search saves nothing", async () => {
      const { onEdit } = setup();
      open();
      const search = await screen.findByLabelText("Search icons");
      fireEvent.change(search, { target: { value: "zzzz" } });
      await screen.findByText("No icons match");
      fireEvent.keyDown(search, { key: "Enter" });
      expect(onEdit).not.toHaveBeenCalled();
   });

   it("Cancel closes without saving", async () => {
      const { onEdit } = setup();
      open();
      await screen.findByLabelText("Title");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
      expect(onEdit).not.toHaveBeenCalled();
   });
});

describe("delete panel dialog", () => {
   it("names the panel and its file, and deletes on confirm", async () => {
      const { onDelete } = setup({ slot: slot({ source: "notes/release.md" }) });
      fireEvent.click(screen.getByRole("menuitem", { name: /Delete panel/ }));
      await screen.findByText("Delete “Release notes”?");
      expect(screen.getByText("notes/release.md")).toBeTruthy();
      expect(screen.getByText(/Only hiding it\?/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(onDelete).toHaveBeenCalled());
   });

   it("does not mention a file for a panel without one", async () => {
      setup();
      fireEvent.click(screen.getByRole("menuitem", { name: /Delete panel/ }));
      await screen.findByText("Delete “Release notes”?");
      expect(screen.queryByText(/Its file/)).toBeNull();
   });
});
