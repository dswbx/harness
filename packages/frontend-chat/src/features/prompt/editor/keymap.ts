import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { $isListItemNode } from "@lexical/list";
import { $isQuoteNode } from "@lexical/rich-text";
import {
   $getSelection,
   $isParagraphNode,
   $isRangeSelection,
   COMMAND_PRIORITY_HIGH,
   INDENT_CONTENT_COMMAND,
   INSERT_LINE_BREAK_COMMAND,
   INSERT_PARAGRAPH_COMMAND,
   KEY_ARROW_DOWN_COMMAND,
   KEY_ARROW_LEFT_COMMAND,
   KEY_ARROW_RIGHT_COMMAND,
   KEY_ARROW_UP_COMMAND,
   KEY_BACKSPACE_COMMAND,
   KEY_DELETE_COMMAND,
   KEY_ENTER_COMMAND,
   KEY_ESCAPE_COMMAND,
   KEY_TAB_COMMAND,
   type LexicalEditor,
   type LexicalNode,
   OUTDENT_CONTENT_COMMAND,
   PASTE_COMMAND,
} from "lexical";
import { $unchip } from "../../prRefs/promptPrRefs";
import {
   $codeTab,
   $escapeBlock,
   $exitCode,
   $indentListItems,
   $insertPlainText,
   $quoteBreak,
   type EnterCtx,
   type EscapeKey,
   enterAction,
   fenceLanguage,
} from "../promptMarkdown";

export type MenuKey = "up" | "down" | "pick" | "close";

/** What the key commands ask of the prompt box: read fresh on every key press. */
export type PromptKeyProps = {
   menuOpen: boolean;
   onMenuKey(key: MenuKey): void;
   onSubmit(): void;
   /** One line: every Enter submits, nothing makes a new paragraph, pasted lines are joined. */
   singleLine?: boolean;
   /** Enter makes a new line (as Shift+Enter); Mod+Enter submits. */
   newlineOnEnter?: boolean;
};

function $block(node: LexicalNode): EnterCtx["block"] {
   const chain = [node, ...node.getParents()];
   if (chain.some($isCodeNode)) return "code";
   if (chain.some($isListItemNode)) return "list";
   if (chain.some($isQuoteNode)) return "quote";
   const top = chain.at(-2) ?? node;
   return $isParagraphNode(top) && fenceLanguage(top.getTextContent()) !== null ? "fence" : "text";
}

/**
 * The prompt editor's key commands: the open menu's keys, un-chipping, leaving blocks with arrows, Tab,
 * Enter and paste. `getProps` is read on every key press. Returns the function that removes them all.
 */
export function registerPromptKeys(
   editor: LexicalEditor,
   getProps: () => PromptKeyProps,
): () => void {
   const menu = (key: MenuKey) => (e: KeyboardEvent | null) => {
      const p = getProps();
      if (!p.menuOpen) return false;
      e?.preventDefault();
      p.onMenuKey(key);
      return true;
   };
   const offs = [
      // Backspace/Delete next to a chip (or on a selected one) turns it back into the text the user typed.
      ...(
         [
            [KEY_BACKSPACE_COMMAND, "backward"],
            [KEY_DELETE_COMMAND, "forward"],
         ] as const
      ).map(([cmd, dir]) =>
         editor.registerCommand(
            cmd,
            (e: KeyboardEvent) => {
               if (e.altKey || e.metaKey || e.ctrlKey || !$unchip(dir)) return false;
               e.preventDefault();
               return true;
            },
            COMMAND_PRIORITY_HIGH,
         ),
      ),
      // Up/Down go to the open "/" menu; otherwise arrows past the first/last code block (or list) add a paragraph there.
      ...(
         [
            [KEY_ARROW_UP_COMMAND, "up"],
            [KEY_ARROW_DOWN_COMMAND, "down"],
            [KEY_ARROW_LEFT_COMMAND, "left"],
            [KEY_ARROW_RIGHT_COMMAND, "right"],
         ] as const
      ).map(([cmd, key]: readonly [typeof KEY_ARROW_UP_COMMAND, EscapeKey]) =>
         editor.registerCommand(
            cmd,
            (e) => {
               if ((key === "up" || key === "down") && menu(key)(e)) return true;
               if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || !$escapeBlock(key))
                  return false;
               e.preventDefault();
               return true;
            },
            COMMAND_PRIORITY_HIGH,
         ),
      ),
      // Tab: menu pick, else nest list items / indent code; in plain text it is left to the browser (focus moves on).
      editor.registerCommand(
         KEY_TAB_COMMAND,
         (e) => {
            if (menu("pick")(e)) return true;
            const sel = $getSelection();
            const block = $isRangeSelection(sel) ? $block(sel.anchor.getNode()) : "text";
            if (block === "code") $codeTab(e.shiftKey);
            else if (block === "list")
               editor.dispatchCommand(
                  e.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND,
                  undefined,
               );
            else return false;
            e.preventDefault();
            return true;
         },
         COMMAND_PRIORITY_HIGH,
      ),
      // Escape closes the open "/" menu; otherwise rich-text blurs the editor.
      editor.registerCommand(KEY_ESCAPE_COMMAND, menu("close"), COMMAND_PRIORITY_HIGH),
      // Only list items indent (rich-text would pad paragraphs/code otherwise).
      editor.registerCommand(
         INDENT_CONTENT_COMMAND,
         () => ($indentListItems(1), true),
         COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
         OUTDENT_CONTENT_COMMAND,
         () => ($indentListItems(-1), true),
         COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
         KEY_ENTER_COMMAND,
         (e) => {
            if (!e) return false;
            const p = getProps();
            const sel = $getSelection();
            const block = $isRangeSelection(sel) ? $block(sel.anchor.getNode()) : "text";
            const action = enterAction({
               menuOpen: p.menuOpen,
               composing: e.isComposing || e.keyCode === 229,
               shift: e.shiftKey,
               mod: e.metaKey || e.ctrlKey,
               block,
               newline: p.newlineOnEnter,
               singleLine: p.singleLine,
            });
            if (action === "default" || (action === "code" && !$exitCode())) return false;
            e.preventDefault();
            if (action === "pick") p.onMenuKey("pick");
            else if (action === "send") p.onSubmit();
            else if (action === "paragraph")
               editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
            else if (action === "quote") $quoteBreak();
            else if (action === "fence" && $isRangeSelection(sel)) {
               const para = sel.anchor.getNode().getTopLevelElement();
               if (!para) return true;
               const code = $createCodeNode(fenceLanguage(para.getTextContent()) || undefined);
               para.replace(code);
               code.select();
            }
            return true;
         },
         COMMAND_PRIORITY_HIGH,
      ),
      // Paste as plain text (no HTML/Markdown parsing); each line becomes a paragraph (line breaks in code). Content copied from a Lexical
      // editor (`application/x-lexical-editor`, written by RichTextPlugin's copy) goes to Lexical to keep formatting.
      editor.registerCommand(
         PASTE_COMMAND,
         (e) => {
            const data = "clipboardData" in e ? e.clipboardData : null;
            const single = getProps().singleLine;
            if (!single && data?.types.includes("application/x-lexical-editor")) return false;
            const t = data?.getData("text/plain");
            const sel = $getSelection();
            if (!t || !$isRangeSelection(sel)) return false;
            e.preventDefault();
            if (single) sel.insertText(t.trim().replace(/\s*[\r\n]+\s*/g, " "));
            else $insertPlainText(t);
            return true;
         },
         COMMAND_PRIORITY_HIGH,
      ),
      // A one-line editor never splits: rich-text's own paragraph / line break inserts are dropped.
      editor.registerCommand(
         INSERT_PARAGRAPH_COMMAND,
         () => !!getProps().singleLine,
         COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
         INSERT_LINE_BREAK_COMMAND,
         () => !!getProps().singleLine,
         COMMAND_PRIORITY_HIGH,
      ),
   ];
   return () => offs.forEach((off) => off());
}
