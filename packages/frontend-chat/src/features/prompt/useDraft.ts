import { type RefObject, useLayoutEffect, useRef } from "react";
import { getDraft, setDraft } from "./drafts";
import type { PromptEditorHandle } from "./PromptEditor";

/**
 * The half-written prompt of this composer: loaded into the editor when `key` changes, saved on every
 * change after (`saveDraft`, called with the new text; an empty text clears the draft).
 */
export function useDraft(key: string, editor: RefObject<PromptEditorHandle | null>) {
   const loaded = useRef<string | null>(null);
   useLayoutEffect(() => {
      editor.current?.load(getDraft(key));
      loaded.current = key;
   }, [key, editor]);
   return (t: string) => {
      if (loaded.current === key)
         setDraft(key, t.trim() ? (editor.current?.snapshot() ?? null) : null);
   };
}
