import type { MarkdownEditorProps } from "@harness/api";
import { useLayoutEffect, useRef } from "react";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";

const noop = () => {};

/**
 * The prompt box's editor as a plain Markdown document (the Frontend's `MarkdownEditor`): Enter makes a new line,
 * no menus. PR chips need a Session, so outside one refs stay text.
 */
export function MarkdownEditor({ initial, onChange, placeholder, label }: MarkdownEditorProps) {
   const editor = useRef<PromptEditorHandle>(null);
   // Changes the load itself makes are not the user's.
   const loaded = useRef<string | null>(null);
   const change = useRef(onChange);
   useLayoutEffect(() => {
      change.current = onChange;
   });
   // biome-ignore lint/correctness/useExhaustiveDependencies: `initial` loads once; a new text mounts a new editor.
   useLayoutEffect(() => {
      const ed = editor.current;
      if (!ed) return;
      ed.loadMarkdown(initial);
      loaded.current = ed.getMarkdown();
   }, []);
   return (
      <PromptEditor
         ref={editor}
         label={label}
         placeholder={placeholder ?? ""}
         newlineOnEnter
         menuOpen={false}
         onMenuKey={noop}
         onSubmit={noop}
         onChange={(_, md) => {
            if (loaded.current === null || md === loaded.current) return;
            loaded.current = md;
            change.current(md);
         }}
         maxHeightClassName="max-h-none"
         minHeightClassName="min-h-40"
      />
   );
}
