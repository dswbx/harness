import type { PrRefKey, SlashCommand } from "@harness/api";
import { cn } from "@harness/ui";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $getRoot } from "lexical";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { $caretToken, type CaretToken, registerAutoChip } from "../prRefs/promptPrRefs";
import { usePrRefs } from "../prRefs/prRefs";
import { CommandToken } from "./editor/CommandToken";
import { config } from "./editor/config";
import { handle } from "./editor/handle";
import { type MenuKey, registerPromptKeys } from "./editor/keymap";
import { registerCodeHighlight } from "./promptCodeHighlight";
import {
   $exportMarkdown,
   INLINE_TRANSFORMERS,
   PROMPT_TRANSFORMERS,
   type PromptSnapshot,
} from "./promptMarkdown";

export type { CaretToken };

export type PromptEditorHandle = {
   /** Markdown of the current content (newlines preserved, no escapes outside code). */
   getMarkdown(): string;
   /** Replace content with plain text (`owner/repo#N` becomes a chip), caret at end, focus. */
   setText(text: string): void;
   /** Exact current content (for `restore`). */
   snapshot(): PromptSnapshot;
   /** Put a snapshot back, only if the editor is empty. Does not move focus. */
   restore(snapshot: PromptSnapshot): void;
   /** Replace the content with a snapshot (empty for `null`), e.g. a saved draft. Does not move focus. */
   load(snapshot: PromptSnapshot | null): void;
   /** Replace the content with Markdown (as `getMarkdown` writes it), e.g. a saved note. Not undoable; does not move focus. */
   loadMarkdown(markdown: string): void;
   /** Empty the editor; keeps the caret only if the editor has focus. */
   clear(): void;
   focus(): void;
   /** Replace `token` (if its text is still there) with a PR chip and a space, or with `text`; caret after it, focus. */
   replaceToken(token: CaretToken, by: { pr: PrRefKey; typed: string } | { text: string }): void;
};

export type { MenuKey };

type Props = {
   ref?: Ref<PromptEditorHandle>;
   placeholder: string;
   /** While true, ArrowUp/ArrowDown/Tab/Enter/Escape go to `onMenuKey` instead of the editor. Otherwise Tab/Shift+Tab nest lists and indent code. */
   menuOpen: boolean;
   onMenuKey(key: MenuKey): void;
   /** The known command the content starts with: its `/name` is colored, with its description on hover. */
   command?: SlashCommand | null;
   /** `text`: plain text (for matching); `markdown`: what would be sent. */
   onChange(text: string, markdown: string): void;
   /** The `#` token at the caret, after each update. */
   onToken?(token: CaretToken | null): void;
   onSubmit(): void;
   /** Content is taller than the max height and scrolls. */
   onOverflowChange?(overflow: boolean): void;
   /** The editor's accessible name; default "Message". */
   label?: string;
   /** Replaces the default max height of the scrolling area (`max-h-[40vh]`). */
   maxHeightClassName?: string;
   /** Replaces the default min height of the content (`min-h-10`). */
   minHeightClassName?: string;
   /**
    * One line, for titles: every Enter calls `onSubmit`, pasted lines are joined with spaces, and typed Markdown
    * makes only inline formatting (no lists, quotes or code blocks).
    */
   singleLine?: boolean;
   /** A document, not a prompt: Enter makes a new line as Shift+Enter does; only Mod+Enter calls `onSubmit`. */
   newlineOnEnter?: boolean;
};

export function PromptEditor(props: Props) {
   const scroller = useRef<HTMLDivElement>(null);
   const [scrolled, setScrolled] = useState(false);
   const [overflow, setOverflow] = useState(false);
   const measure = () => {
      const el = scroller.current;
      if (!el) return;
      setScrolled(el.scrollTop > 0);
      setOverflow(el.scrollHeight > el.clientHeight + 1);
   };
   const { onOverflowChange } = props;
   useEffect(() => onOverflowChange?.(overflow), [overflow, onOverflowChange]);
   useEffect(() => {
      const el = scroller.current;
      if (!el) return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
   }, []);

   return (
      <LexicalComposer initialConfig={config}>
         <div className="relative">
            <div
               ref={scroller}
               onScroll={measure}
               className={cn(
                  "relative isolate overflow-y-auto",
                  props.maxHeightClassName ?? "max-h-[40vh]",
               )}
            >
               <RichTextPlugin
                  contentEditable={
                     <ContentEditable
                        aria-label={props.label ?? "Message"}
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        className={cn(
                           "px-1 text-sm outline-none",
                           props.minHeightClassName ?? "min-h-10",
                        )}
                     />
                  }
                  placeholder={
                     <div className="pointer-events-none absolute left-1 top-0 select-none text-sm text-muted-foreground/50">
                        {props.placeholder}
                     </div>
                  }
                  ErrorBoundary={LexicalErrorBoundary}
               />
               {props.command && <CommandToken command={props.command} />}
            </div>
            {scrolled && (
               <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b from-card to-transparent" />
            )}
         </div>
         <HistoryPlugin />
         <ListPlugin />
         <MarkdownShortcutPlugin
            transformers={props.singleLine ? INLINE_TRANSFORMERS : PROMPT_TRANSFORMERS}
         />
         <Behavior {...props} onUpdate={measure} />
      </LexicalComposer>
   );
}

function Behavior(props: Props & { onUpdate(): void }) {
   const [editor] = useLexicalComposerContext();
   const p = useRef(props);
   useLayoutEffect(() => {
      p.current = props;
   });
   const prRefs = usePrRefs();
   const refs = useRef(prRefs);
   useLayoutEffect(() => {
      refs.current = prRefs;
   });

   useImperativeHandle(props.ref, () => handle(editor), [editor]);

   useEffect(() => {
      const offs = [
         editor.registerUpdateListener(({ editorState }) => {
            editorState.read(() => {
               p.current.onChange($getRoot().getTextContent(), $exportMarkdown());
               p.current.onToken?.($caretToken());
            });
            p.current.onUpdate();
         }),
         // A typed PR ref followed by a space or punctuation becomes a chip once the PR is found.
         registerAutoChip(editor, () => refs.current),
         registerCodeHighlight(editor),
         registerPromptKeys(editor, () => p.current),
      ];
      return () => offs.forEach((off) => off());
   }, [editor]);

   return null;
}
