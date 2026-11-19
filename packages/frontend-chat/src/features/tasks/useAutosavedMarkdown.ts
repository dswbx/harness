import { type AttachmentInput, errText } from "@harness/api";
import {
   type ClipboardEvent,
   type FocusEvent,
   useCallback,
   useEffect,
   useLayoutEffect,
   useRef,
} from "react";
import type { PromptEditorHandle } from "../prompt/PromptEditor";
import { filesToInputs } from "./AssetStrip";
import { useAutosave } from "./useAutosave";

type Options<V, B> = {
   /** The stored value; null while loading. */
   value: V | null;
   /** The version a save is checked against (a hash, an updated time). */
   baseOf: (v: V) => B;
   textOf: (v: V) => string;
   /** Saves `md`; refused (`conflict`) when the stored value is no longer `base`. */
   write: (md: string, base: B | null) => Promise<V>;
   /** Reads the stored value again (`reload`). */
   read: () => Promise<V>;
   /** A value written or read here, for the caller's state. */
   onStored: (v: V) => void;
   /** Files pasted into the editor's box. */
   onFiles: (files: AttachmentInput[]) => void;
   onError: (message: string) => void;
};

/**
 * Markdown typed in place in a `PromptEditor` and autosaved (`useAutosave`: after typing stops, on blur, on Mod+Enter
 * and on unmount): the Session Note and a task's description. Each save sends the base of the value the editor holds;
 * a value changed elsewhere since is refused and the user reloads (`reload`). A value written elsewhere loads in
 * unless there are unsaved changes. Files pasted into the box go to `onFiles`.
 */
export function useAutosavedMarkdown<V, B>(options: Options<V, B>) {
   const opts = useRef(options);
   useLayoutEffect(() => {
      opts.current = options;
   });
   const editor = useRef<PromptEditorHandle>(null);
   /** The base of the value the editor holds (loaded or saved). */
   const base = useRef<B | null>(null);
   /** The Markdown last loaded or seen, so a selection change or a load does not save. */
   const lastMd = useRef<string | null>(null);

   const autosave = useAutosave<string>(async (md) => {
      const saved = await opts.current.write(md, base.current);
      base.current = opts.current.baseOf(saved);
      opts.current.onStored(saved);
   });

   const load = useCallback((v: V) => {
      const ed = editor.current;
      if (!ed) return;
      base.current = opts.current.baseOf(v);
      lastMd.current = null;
      ed.loadMarkdown(opts.current.textOf(v));
      lastMd.current = ed.getMarkdown();
   }, []);

   // The first read, and values written elsewhere while nothing here waits to be saved.
   const { value } = options;
   const { dirty } = autosave;
   useEffect(() => {
      if (value === null || opts.current.baseOf(value) === base.current) return;
      if (base.current !== null && dirty()) return;
      load(value);
   }, [value, load, dirty]);

   const reload = () => {
      autosave.reset();
      opts.current.read().then(
         (v) => {
            opts.current.onStored(v);
            load(v);
         },
         (e) => opts.current.onError(errText(e)),
      );
   };

   return {
      editor,
      status: autosave.status,
      error: autosave.error,
      reload,
      /** For the `PromptEditor`. */
      onChange: (_: string, md: string) => {
         if (lastMd.current === null || md === lastMd.current) return;
         lastMd.current = md;
         autosave.change(md);
      },
      onSubmit: () => void autosave.flush(),
      /** For the box around the editor: saves when focus leaves it, takes pasted files. */
      box: {
         onBlur: (e: FocusEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void autosave.flush();
         },
         onPasteCapture: (e: ClipboardEvent<HTMLElement>) => {
            const list = [...e.clipboardData.files];
            if (!list.length) return;
            e.preventDefault();
            e.stopPropagation();
            filesToInputs(list).then(
               (files) => opts.current.onFiles(files),
               (err) => opts.current.onError(errText(err)),
            );
         },
      },
   };
}
