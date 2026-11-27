import { ALL_CHANGES, type Diff, type GitSource } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffWindow } from "./DiffWindow";

afterEach(cleanup);

// The view measures text with a canvas; happy-dom has none.
HTMLCanvasElement.prototype.getContext = (() => ({
   font: "",
   measureText: () => ({ width: 8 }),
})) as never;

const patch = (path: string) =>
   `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

const diff: Diff = {
   from: "base",
   to: "tree",
   files: [],
   patch: patch("src/a.ts") + patch("b.md"),
};

function fakeGit(): GitSource & { [K in keyof GitSource]: ReturnType<typeof vi.fn> } {
   return {
      gitDiff: vi.fn(async () => diff),
      gitLog: vi.fn(async () => []),
      gitShowFile: vi.fn(async (rev: string) => (rev === "base" ? "old\n" : "new\n")),
   } as never;
}

describe("DiffWindow on a folder (no Session)", () => {
   it("lists the files, has no comment UI, reads the open file, and Refresh reloads", async () => {
      const git = fakeGit();
      const { container } = render(
         <TooltipProvider>
            <DiffWindow
               source={{ kind: "folder", folder: "/home/me/proj", git }}
               scope={ALL_CHANGES}
            />
         </TooltipProvider>,
      );
      expect(await screen.findByText("a.ts")).toBeTruthy();
      expect(screen.getByText("b.md")).toBeTruthy();
      expect(document.title).toBe("Diff: proj · All changes");
      expect(window.location.search).toContain("folder=%2Fhome%2Fme%2Fproj");
      await waitFor(() => expect(git.gitShowFile).toHaveBeenCalledWith("base", "src/a.ts"));
      expect(git.gitShowFile).toHaveBeenCalledWith("tree", "src/a.ts");
      // A Session's window draws "+" comment widgets on these rows; a folder's draws none.
      expect(container.querySelector("tr.diff-line")).not.toBeNull();
      expect(container.querySelector(".diff-add-widget, .diff-add-widget-wrapper")).toBeNull();
      expect(git.gitDiff).toHaveBeenCalledTimes(1);
      expect(git.gitLog).toHaveBeenCalledTimes(1);

      // Select the second file; Refresh keeps it and reloads diff, commits and its contents.
      fireEvent.click(screen.getByLabelText("Next file"));
      await waitFor(() => expect(git.gitShowFile).toHaveBeenCalledWith("tree", "b.md"));
      git.gitShowFile.mockClear();
      fireEvent.click(screen.getByLabelText("Refresh diff"));
      await waitFor(() => expect(git.gitDiff).toHaveBeenCalledTimes(2));
      expect(git.gitDiff).toHaveBeenLastCalledWith(null, null);
      await waitFor(() => expect(git.gitLog).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(git.gitShowFile).toHaveBeenCalledWith("tree", "b.md"));
      expect(screen.getByText("2/2 files")).toBeTruthy();
   });
});
