import {
   $createParagraphNode,
   $createTextNode,
   $getRoot,
   $setSelection,
   type LexicalEditor,
} from "lexical";
import { $importPrRefs, $replaceToken } from "../../prRefs/promptPrRefs";
import type { PromptEditorHandle } from "../PromptEditor";
import { $exportMarkdown, restoreSnapshot, snapshot } from "../promptMarkdown";

function $reset() {
   const para = $createParagraphNode();
   $getRoot().clear().append(para);
   return para;
}

export function handle(editor: LexicalEditor): PromptEditorHandle {
   return {
      getMarkdown: () => editor.getEditorState().read($exportMarkdown),
      setText: (text) => {
         editor.update(() => {
            const t = $createTextNode(text);
            $reset().append(t);
            $importPrRefs(t);
            $getRoot().selectEnd();
         });
         editor.focus();
      },
      snapshot: () => snapshot(editor),
      restore: (s) => void restoreSnapshot(editor, s),
      load: (s) => {
         if (s) {
            try {
               editor.setEditorState(editor.parseEditorState(s));
               return;
            } catch {
               // A draft from an older editor that no longer parses: start empty.
            }
         }
         editor.update(() => {
            $reset();
            $setSelection(null);
         });
      },
      clear: () => {
         const root = editor.getRootElement();
         const focused = !!root && root.contains(document.activeElement);
         editor.update(() => {
            const para = $reset();
            if (focused) para.select();
            else $setSelection(null);
         });
      },
      focus: () => editor.focus(),
      replaceToken: (token, by) => {
         editor.update(() => void $replaceToken(token, by));
         editor.focus();
      },
   };
}
