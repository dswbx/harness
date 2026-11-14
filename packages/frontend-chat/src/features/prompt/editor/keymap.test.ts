import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import {
   $getRoot,
   KEY_BACKSPACE_COMMAND,
   KEY_ENTER_COMMAND,
   KEY_TAB_COMMAND,
   type LexicalCommand,
   type LexicalEditor,
} from "lexical";
import { describe, expect, it, vi } from "vitest";
import { $isPrRefNode } from "../../prRefs/PrRefNode";
import { $exportMarkdown, PROMPT_NODES, PROMPT_TRANSFORMERS } from "../promptMarkdown";
import { type MenuKey, type PromptKeyProps, registerPromptKeys } from "./keymap";

/** A headless editor holding `md`, with the key commands registered; the caret is placed by `place`. */
function setup(md: string, place: () => void, over: Partial<PromptKeyProps> = {}) {
   const editor = createHeadlessEditor({
      nodes: PROMPT_NODES,
      onError: (e) => {
         throw e;
      },
   });
   registerRichText(editor);
   const props = {
      menuOpen: false,
      onMenuKey: vi.fn<(k: MenuKey) => void>(),
      onSubmit: vi.fn(),
      ...over,
   };
   registerPromptKeys(editor, () => props);
   editor.update(
      () => {
         $convertFromMarkdownString(md, PROMPT_TRANSFORMERS, undefined, true);
         place();
      },
      { discrete: true },
   );
   return { editor, props };
}

const key = (init: Partial<KeyboardEvent> = {}) => {
   const e = {
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      isComposing: false,
      keyCode: 13,
      preventDefault: vi.fn(),
      ...init,
   };
   return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
};
const press = (
   editor: LexicalEditor,
   cmd: LexicalCommand<KeyboardEvent> | LexicalCommand<KeyboardEvent | null>,
   e: KeyboardEvent,
) => {
   const handled = editor.dispatchCommand(cmd, e);
   // Flush any update the command queued.
   editor.update(() => {}, { discrete: true });
   return handled;
};
const md = (editor: LexicalEditor) => editor.getEditorState().read($exportMarkdown);
const endOfLast = () => $getRoot().getLastDescendant()?.selectEnd();

describe("registerPromptKeys", () => {
   it("Enter sends", () => {
      const { editor, props } = setup("hello", endOfLast);
      const e = key();
      expect(press(editor, KEY_ENTER_COMMAND, e)).toBe(true);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(props.onSubmit).toHaveBeenCalledTimes(1);
      expect(props.onMenuKey).not.toHaveBeenCalled();
   });

   it("Shift+Enter does not send", () => {
      const { editor, props } = setup("hello", endOfLast);
      press(editor, KEY_ENTER_COMMAND, key({ shiftKey: true }));
      expect(props.onSubmit).not.toHaveBeenCalled();
      expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(2);
   });

   it("Enter picks when a menu is open", () => {
      const { editor, props } = setup("/he", endOfLast, { menuOpen: true });
      expect(press(editor, KEY_ENTER_COMMAND, key())).toBe(true);
      expect(props.onMenuKey).toHaveBeenCalledWith("pick");
      expect(props.onSubmit).not.toHaveBeenCalled();
   });

   it("Enter inside a code fence is left to the editor and does not send", () => {
      const { editor, props } = setup("```\nlet a\n```", endOfLast);
      press(editor, KEY_ENTER_COMMAND, key());
      expect(props.onSubmit).not.toHaveBeenCalled();
      expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(1);
      expect(md(editor)).toMatch(/^```/);
   });

   it("Tab in a list nests the item, Shift+Tab lifts it", () => {
      const { editor } = setup("- a\n- b", endOfLast);
      const tab = key({ keyCode: 9 });
      expect(press(editor, KEY_TAB_COMMAND, tab)).toBe(true);
      expect(tab.preventDefault).toHaveBeenCalled();
      expect(md(editor)).toBe("- a\n    - b");
      press(editor, KEY_TAB_COMMAND, key({ keyCode: 9, shiftKey: true }));
      expect(md(editor)).toBe("- a\n- b");
   });

   it("Tab in plain text is left to the browser", () => {
      const { editor, props } = setup("hello", endOfLast);
      const tab = key({ keyCode: 9 });
      expect(press(editor, KEY_TAB_COMMAND, tab)).toBe(false);
      expect(tab.preventDefault).not.toHaveBeenCalled();
      expect(props.onMenuKey).not.toHaveBeenCalled();
   });

   it("Tab picks when a menu is open", () => {
      const { editor, props } = setup("/he", endOfLast, { menuOpen: true });
      expect(press(editor, KEY_TAB_COMMAND, key({ keyCode: 9 }))).toBe(true);
      expect(props.onMenuKey).toHaveBeenCalledWith("pick");
   });

   it("Backspace after a PR chip turns it back into the typed text", () => {
      const { editor } = setup("see owner/repo#12", endOfLast);
      expect(editor.getEditorState().read(hasChip)).toBe(true);
      const e = key({ keyCode: 8 });
      expect(press(editor, KEY_BACKSPACE_COMMAND, e)).toBe(true);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(editor.getEditorState().read(hasChip)).toBe(false);
      expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain(
         "owner/repo#12",
      );
   });
});

function hasChip() {
   const walk = (n: ReturnType<typeof $getRoot>): boolean =>
      n.getChildren().some((c) => $isPrRefNode(c) || ("getChildren" in c && walk(c as never)));
   return walk($getRoot());
}
