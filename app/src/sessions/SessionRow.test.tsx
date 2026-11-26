import type { SessionSummary } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const focusPanelWindow = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@harness/api", async (orig) => ({
   ...(await orig<typeof import("@harness/api")>()),
   focusPanelWindow,
}));

import { SessionRow } from "./SessionRow";

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
   id: "s1",
   title: "Sample task",
   frontend_id: "chat",
   agent_id: "codex",
   folder: "/work/sample",
   created_ms: 1,
   updated_ms: 1,
   status: "idle",
   archived: false,
   quick: false,
   unused: false,
   unseen: false,
   title_explicit: false,
   workspace: {
      repo_root: null,
      source_folder: "/work/sample",
      worktree_branch: null,
      base_branch: null,
      branch: null,
      pr: null,
   } as unknown as SessionSummary["workspace"],
   ...over,
});

function setup(s: SessionSummary, windows?: string[]) {
   const h = {
      onSelect: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn(),
      onResetTitle: vi.fn(),
   };
   render(
      <TooltipProvider>
         <ul>
            <SessionRow
               s={s}
               selected={false}
               display="condensed"
               query=""
               showFolder={false}
               now={10}
               windows={windows}
               {...h}
            />
         </ul>
      </TooltipProvider>,
   );
   return h;
}

const openDropdown = () => {
   const t = screen.getByRole("button", { name: "Session menu" });
   fireEvent.pointerDown(t, { button: 0, ctrlKey: false, pointerType: "mouse" });
};
const names = () => screen.getAllByRole("menuitem").map((e) => e.textContent?.trim());

afterEach(cleanup);

describe("SessionRow menus", () => {
   it("right-click opens the context menu; Rename calls onRename", () => {
      const h = setup(session());
      fireEvent.contextMenu(screen.getByRole("listitem"));
      expect(names()).toEqual(["Rename…", "Archive", "Delete"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
      expect(h.onRename).toHaveBeenCalledOnce();
   });
   it("the ⋯ menu shares the items; automatic title only when explicit", () => {
      const h = setup(session({ title_explicit: true, archived: true }));
      openDropdown();
      expect(names()).toEqual(["Rename…", "Use automatic title", "Unarchive", "Delete"]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Use automatic title" }));
      expect(h.onResetTitle).toHaveBeenCalledOnce();
   });
});

describe("SessionRow panel windows", () => {
   afterEach(() => focusPanelWindow.mockClear());
   it("hides the icon without popped panels", () => {
      setup(session());
      expect(screen.queryByRole("button", { name: /in own window/ })).toBeNull();
   });
   it("shows the icon with a count label", () => {
      setup(session(), ["files", "diff"]);
      expect(screen.getByRole("button", { name: "2 panels in own window" })).toBeTruthy();
   });
   it("click focuses the first window and does not select the row", () => {
      const h = setup(session(), ["files"]);
      fireEvent.click(screen.getByRole("button", { name: "1 panel in own window" }));
      expect(focusPanelWindow).toHaveBeenCalledWith("s1", "files");
      expect(h.onSelect).not.toHaveBeenCalled();
   });
});
