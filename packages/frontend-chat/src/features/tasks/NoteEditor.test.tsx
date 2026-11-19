import { HarnessClient } from "@harness/api";
import { MockTransport } from "@harness/api/mock";
import { TooltipProvider } from "@harness/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor";

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

async function setup() {
   const mock = new MockTransport([], []);
   const api = new HarnessClient(mock).sessionApi("mock-1");
   render(
      <TooltipProvider>
         <NoteEditor api={api} />
      </TooltipProvider>,
   );
   const editor = await waitFor(() => screen.getByRole("textbox", { name: "Session note" }));
   await waitFor(() => expect(editor.textContent).not.toBe(""));
   return { mock, api, editor };
}

const stored = (mock: MockTransport) => mock.notes.get("mock-1")?.content;

describe("Session note", () => {
   it("saves on blur, checked against the note it loaded", async () => {
      const { mock, api, editor } = await setup();
      const write = vi.spyOn(api, "writeNote");
      const loaded = (await api.readNote()).hash;
      await typeIn(editor, "First line");
      await act(async () => fireEvent.focusOut(editor));
      await waitFor(() => expect(stored(mock)).toBe("First line"));
      expect(write.mock.calls[0]).toEqual(["First line", loaded]);
      // The next save is checked against the saved note.
      const saved = (await api.readNote()).hash;
      await typeIn(editor, "Second line");
      await act(async () => fireEvent.focusOut(editor));
      await waitFor(() => expect(stored(mock)).toBe("Second line"));
      expect(write.mock.calls[1]).toEqual(["Second line", saved]);
   });

   it("loads a note written elsewhere, and refuses unsaved text over it until reloaded", async () => {
      const { mock, api, editor } = await setup();
      // Nothing unsaved: it loads in.
      await act(async () => void (await api.writeNote("From another window")));
      await waitFor(() => expect(editor.textContent).toBe("From another window"));
      // Typed here, then written elsewhere before the save: the save is refused.
      await typeIn(editor, "Typed here");
      await act(async () => void (await api.writeNote("Elsewhere again")));
      expect(editor.textContent).toBe("Typed here");
      await act(async () => fireEvent.focusOut(editor));
      await waitFor(() => screen.getByText("Changed elsewhere"));
      expect(stored(mock)).toBe("Elsewhere again");
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(editor.textContent).toBe("Elsewhere again"));
      expect(screen.queryByText("Changed elsewhere")).toBeNull();
   });

   it("removes a note image", async () => {
      const { mock, api } = await setup();
      const png =
         "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      await act(async () => {
         await api.addNoteImages([
            { type: "data", name: "shot.png", mime: "image/png", data: png },
         ]);
      });
      const remove = await waitFor(() => screen.getByRole("button", { name: "Remove shot.png" }));
      await act(async () => fireEvent.click(remove));
      await waitFor(() =>
         expect(screen.queryByRole("button", { name: "Remove shot.png" })).toBeNull(),
      );
      expect(mock.notes.get("mock-1")?.images).toEqual([]);
   });
});
