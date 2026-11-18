import { createHeadlessEditor } from "@lexical/headless";
import { registerList } from "@lexical/list";
import { $convertFromMarkdownString, registerMarkdownShortcuts } from "@lexical/markdown";
import { registerRichText } from "@lexical/rich-text";
import {
   $getRoot,
   $getSelection,
   $isRangeSelection,
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

describe("newlineOnEnter: typing Markdown after Enter", () => {
   /** A headless editor with the live Markdown shortcuts; `type` inserts one character at a time, as a keyboard does. */
   function typing() {
      const editor = createHeadlessEditor({
         nodes: PROMPT_NODES,
         onError: (e) => {
            throw e;
         },
      });
      registerRichText(editor);
      registerList(editor);
      registerMarkdownShortcuts(editor, PROMPT_TRANSFORMERS);
      registerPromptKeys(editor, () => ({
         menuOpen: false,
         onMenuKey: vi.fn(),
         onSubmit: vi.fn(),
         newlineOnEnter: true,
      }));
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
      const type = (s: string) => {
         for (const c of s)
            editor.update(
               () => {
                  const sel = $getSelection();
                  if ($isRangeSelection(sel)) sel.insertText(c);
               },
               { discrete: true },
            );
      };
      const enter = (init: Partial<KeyboardEvent> = {}) =>
         press(editor, KEY_ENTER_COMMAND, key(init));
      const types = () =>
         editor.getEditorState().read(() =>
            $getRoot()
               .getChildren()
               .map((n) => n.getType()),
         );
      return { editor, type, enter, types };
   }

   it("Enter starts a new paragraph, so `- ` becomes a list live", () => {
      const { editor, type, enter, types } = typing();
      type("hello");
      enter();
      type("- a");
      expect(types()).toEqual(["paragraph", "list"]);
      enter();
      type("b");
      expect(md(editor)).toBe("hello\n\n- a\n- b");
   });

   it("`1. ` and `> ` also convert after Enter", () => {
      const { editor, type, enter, types } = typing();
      type("x");
      enter();
      type("1. q");
      enter();
      type("r");
      enter();
      enter();
      type("> quote");
      expect(types()).toEqual(["paragraph", "list", "quote"]);
      expect(md(editor)).toBe("x\n\n1. q\n2. r\n\n> quote");
   });

   it("Enter on an empty list item leaves the list", () => {
      const { editor, type, enter, types } = typing();
      type("- a");
      enter();
      enter();
      type("tail");
      expect(types()).toEqual(["list", "paragraph"]);
      expect(md(editor)).toBe("- a\n\ntail");
   });
});
