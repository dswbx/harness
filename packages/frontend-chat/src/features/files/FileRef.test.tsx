import { CommandError, type SessionApi } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../markdown/Markdown";
import { createFileReader, FileRefProvider, LockedNotice } from "./FileRef";

afterEach(cleanup);

/** A made-up Session: `src/a.ts` inside, `~/notes/todo.md` outside, `~/.aws/config` locked until allowed, and
 * `docs/notes.md` a symlink to the locked `~/.zshrc`. Errors and lines name the real file. */
function fakeApi() {
   const allowed = new Set<string>();
   const files: Record<string, string[]> = {
      "src/a.ts": ["const a = 1;"],
      "~/notes/todo.md": ["# Todo"],
      "~/.aws/config": ["[default]", "region = made-up-1"],
      "~/.zshrc": ["export MADE_UP=1"],
   };
   const links: Record<string, string> = { "docs/notes.md": "~/.zshrc" };
   const api = {
      readSessionFile: vi.fn(async (asked: string) => {
         const path = links[asked] ?? asked;
         const lines = files[path];
         if (!lines) throw new CommandError("internal", `${asked}: No such file or directory`);
         const reason = path.startsWith("~/.aws/")
            ? "in the hidden folder ~/.aws"
            : path === "~/.zshrc"
              ? "a hidden file"
              : null;
         if (reason && !allowed.has(path)) throw new CommandError("needs_approval", reason, path);
         const scope = reason ? "allowed" : path.startsWith("~/") ? "outside" : "inside";
         return { path, start: 1, lines, total: lines.length, scope };
      }),
      openInEditor: vi.fn(async () => {}),
      approveSessionFile: vi.fn(async (path: string) => void allowed.add(path)),
      revokeSessionFile: vi.fn(async (path: string) => void allowed.delete(path)),
   };
   return api;
}

const view = (api: ReturnType<typeof fakeApi>, text: string) =>
   render(
      <TooltipProvider>
         <FileRefProvider api={api as unknown as SessionApi}>
            <Markdown>{text}</Markdown>
         </FileRefProvider>
      </TooltipProvider>,
   );

describe("file reader", () => {
   it("tells lines, locked and missing files apart", async () => {
      const reader = createFileReader(fakeApi() as unknown as SessionApi);
      expect((await reader.read("src/a.ts", 1, 11)).kind).toBe("ok");
      expect(await reader.read("~/.aws/config", 1, 11)).toEqual({
         kind: "locked",
         reason: "in the hidden folder ~/.aws",
         path: "~/.aws/config",
      });
      expect(await reader.read("docs/notes.md", 1, 11)).toEqual({
         kind: "locked",
         reason: "a hidden file",
         path: "~/.zshrc",
      });
      expect(await reader.read("~/missing.md", 1, 11)).toEqual({ kind: "none" });
      expect(reader.peek("~/missing.md", 1, 11)).toEqual({ kind: "none" });
   });

   it("reads again after access changed", async () => {
      const api = fakeApi();
      const reader = createFileReader(api as unknown as SessionApi);
      const seen = vi.fn();
      reader.subscribe(seen);
      await reader.read("~/.aws/config", 1, 11);
      await reader.allow("~/.aws/config");
      expect(seen).toHaveBeenCalledTimes(1);
      expect(reader.peek("~/.aws/config", 1, 11)).toBeUndefined();
      const r = await reader.read("~/.aws/config", 1, 11);
      expect(r.kind === "ok" && r.slice.scope).toBe("allowed");
   });
});

describe("file ref lenses", () => {
   it("a missing file stays plain inline code", async () => {
      const api = fakeApi();
      const { container } = view(api, "See `~/missing.md`.");
      await waitFor(() => expect(api.readSessionFile).toHaveBeenCalled());
      expect(container.querySelector('span[role="button"]')).toBeNull();
      expect(container.querySelector("code")?.textContent).toBe("~/missing.md");
   });

   it("an outside file is a normal lens marked outside the folder", async () => {
      const api = fakeApi();
      view(api, "See `~/notes/todo.md`.");
      const lens = await screen.findByRole("button", { name: "~/notes/todo.md" });
      fireEvent.focus(lens);
      expect(await screen.findByText("Outside folder")).toBeTruthy();
      expect(screen.getByText("# Todo")).toBeTruthy();
   });

   it("a locked file asks first, then shows its lines, and can be locked again", async () => {
      const api = fakeApi();
      view(api, "See `~/.aws/config`.");
      const lens = await screen.findByRole("button", { name: "~/.aws/config (locked)" });
      fireEvent.click(lens);
      expect(await screen.findByText("This file can hold secrets")).toBeTruthy();
      expect(screen.getByText("It is in the hidden folder ~/.aws.")).toBeTruthy();
      expect(screen.getByText("Locked")).toBeTruthy();
      expect(screen.queryByText(/^Allows/)).toBeNull();
      expect(screen.queryByText("region = made-up-1")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Allow and show" }));
      expect(await screen.findByText("Allowed")).toBeTruthy();
      expect(api.approveSessionFile).toHaveBeenCalledWith("~/.aws/config");
      expect(screen.getByText("region = made-up-1")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
      expect(await screen.findByText("This file can hold secrets")).toBeTruthy();
      expect(api.revokeSessionFile).toHaveBeenCalledWith("~/.aws/config");
      expect(screen.queryByText("region = made-up-1")).toBeNull();
   });

   it("a symlink to a locked file names the real file and allows that one", async () => {
      const api = fakeApi();
      view(api, "See `docs/notes.md`.");
      fireEvent.click(await screen.findByRole("button", { name: "docs/notes.md (locked)" }));
      expect(await screen.findByText("It is a hidden file.")).toBeTruthy();
      expect(screen.getByText("~/.zshrc").closest("p")?.textContent).toBe("Allows ~/.zshrc");
      fireEvent.click(screen.getByRole("button", { name: "Allow and show" }));
      expect(await screen.findByText("export MADE_UP=1")).toBeTruthy();
      expect(api.approveSessionFile).toHaveBeenCalledWith("~/.zshrc");
   });
});

describe("locked notice", () => {
   it("shows a failed approval instead of rejecting", async () => {
      render(
         <LockedNotice
            reason="a hidden file"
            path="~/.made-up"
            written="~/.made-up"
            onAllow={() =>
               Promise.reject(new CommandError("invalid", "~/.made-up is a binary file"))
            }
         />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Allow and show" }));
      expect((await screen.findByRole("alert")).textContent).toBe(
         "Could not allow it: ~/.made-up is a binary file",
      );
      expect(screen.getByRole("button", { name: "Allow and show" })).toHaveProperty(
         "disabled",
         false,
      );
   });
});
