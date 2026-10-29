import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { $isListItemNode } from "@lexical/list";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { PROMPT_NODES, PROMPT_TRANSFORMERS, enterAction, fenceLanguage, unescapeMarkdown, type EnterCtx } from "./promptMarkdown";

export type PromptEditorHandle = {
  /** Markdown of the current content (newlines preserved, no escapes outside code). */
  getMarkdown(): string;
  /** Replace content with plain text, caret at end, focus. */
  setText(text: string): void;
  /** Put Markdown back, only if the editor is empty. */
  restore(markdown: string): void;
  clear(): void;
  focus(): void;
};

export type MenuKey = "up" | "down" | "pick";

type Props = {
  ref?: Ref<PromptEditorHandle>;
  placeholder: string;
  /** While true, ArrowUp/ArrowDown/Tab/Enter go to `onMenuKey` instead of the editor. */
  menuOpen: boolean;
  onMenuKey(key: MenuKey): void;
  /** `text`: plain text (for matching); `markdown`: what would be sent. */
  onChange(text: string, markdown: string): void;
  onSubmit(): void;
  /** Content is taller than the max height and scrolls. */
  onOverflowChange?(overflow: boolean): void;
};

const theme: InitialConfigType["theme"] = {
  paragraph: "m-0",
  text: {
    bold: "font-semibold",
    italic: "italic",
    strikethrough: "line-through",
    code: "rounded bg-muted px-1 font-mono text-[0.9em]",
  },
  code: "my-1 block overflow-x-auto whitespace-pre rounded-md border bg-background/60 p-2 font-mono text-xs data-[language]:before:mb-1 data-[language]:before:block data-[language]:before:select-none data-[language]:before:text-[0.65rem] data-[language]:before:text-muted-foreground data-[language]:before:content-[attr(data-language)]",
  list: { ul: "list-disc pl-5", ol: "list-decimal pl-5", nested: { listitem: "list-none" } },
  link: "text-primary underline underline-offset-2",
};

const config: InitialConfigType = { namespace: "prompt", theme, nodes: PROMPT_NODES, onError: (e) => { throw e; } };

const markdown = () => unescapeMarkdown($convertToMarkdownString(PROMPT_TRANSFORMERS, undefined, true));

function $reset() {
  const para = $createParagraphNode();
  $getRoot().clear().append(para);
  return para;
}

function $block(node: LexicalNode): EnterCtx["block"] {
  const chain = [node, ...node.getParents()];
  if (chain.some($isCodeNode)) return "code";
  if (chain.some($isListItemNode)) return "list";
  const top = chain.at(-2) ?? node;
  return $isParagraphNode(top) && fenceLanguage(top.getTextContent()) !== null ? "fence" : "text";
}

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
        <div ref={scroller} onScroll={measure} className="relative max-h-[40vh] overflow-y-auto">
          <RichTextPlugin
            contentEditable={<ContentEditable aria-label="Message" className="min-h-10 px-1 text-sm outline-none" />}
            placeholder={<div className="pointer-events-none absolute left-1 top-0 select-none text-sm text-muted-foreground">{props.placeholder}</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        {scrolled && <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-linear-to-b from-card to-transparent" />}
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <MarkdownShortcutPlugin transformers={PROMPT_TRANSFORMERS} />
      <Behavior {...props} onUpdate={measure} />
    </LexicalComposer>
  );
}

function Behavior(props: Props & { onUpdate(): void }) {
  const [editor] = useLexicalComposerContext();
  const p = useRef(props);
  useLayoutEffect(() => { p.current = props; });

  useImperativeHandle(props.ref, () => handle(editor), [editor]);

  useEffect(() => {
    const menu = (key: MenuKey) => (e: KeyboardEvent | null) => {
      if (!p.current.menuOpen) return false;
      e?.preventDefault();
      p.current.onMenuKey(key);
      return true;
    };
    const offs = [
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => p.current.onChange($getRoot().getTextContent(), markdown()));
        p.current.onUpdate();
      }),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, menu("up"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, menu("down"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_TAB_COMMAND, menu("pick"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (e) => {
          if (!e) return false;
          const sel = $getSelection();
          const block = $isRangeSelection(sel) ? $block(sel.anchor.getNode()) : "text";
          const action = enterAction({
            menuOpen: p.current.menuOpen,
            composing: e.isComposing || e.keyCode === 229,
            shift: e.shiftKey,
            mod: e.metaKey || e.ctrlKey,
            block,
          });
          if (action === "default") return false;
          e.preventDefault();
          if (action === "pick") p.current.onMenuKey("pick");
          else if (action === "send") p.current.onSubmit();
          else if ($isRangeSelection(sel)) {
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
      // Paste as plain text (no HTML/Markdown parsing); newlines become line breaks.
      editor.registerCommand(
        PASTE_COMMAND,
        (e) => {
          const t = "clipboardData" in e ? e.clipboardData?.getData("text/plain") : undefined;
          const sel = $getSelection();
          if (!t || !$isRangeSelection(sel)) return false;
          e.preventDefault();
          sel.insertRawText(t.replace(/\r\n?/g, "\n"));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [editor]);

  return null;
}

function handle(editor: LexicalEditor): PromptEditorHandle {
  return {
    getMarkdown: () => editor.getEditorState().read(markdown),
    setText: (text) => {
      editor.update(() => {
        $reset().append($createTextNode(text)).selectEnd();
      });
      editor.focus();
    },
    restore: (md) =>
      editor.update(() => {
        if ($getRoot().getTextContent().trim()) return;
        $convertFromMarkdownString(md, PROMPT_TRANSFORMERS, undefined, true);
        $getRoot().selectEnd();
      }),
    clear: () => editor.update(() => void $reset().select()),
    focus: () => editor.focus(),
  };
}
