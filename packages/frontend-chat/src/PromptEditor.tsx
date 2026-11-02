import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { $isListItemNode } from "@lexical/list";
import { $isQuoteNode } from "@lexical/rich-text";
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
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  INDENT_CONTENT_COMMAND,
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
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import {
  $codeTab,
  $escapeBlock,
  $exitCode,
  $exportMarkdown,
  $indentListItems,
  $insertPlainText,
  $quoteBreak,
  PROMPT_NODES,
  PROMPT_TRANSFORMERS,
  enterAction,
  fenceLanguage,
  restoreSnapshot,
  snapshot,
  type EnterCtx,
  type EscapeKey,
  type PromptSnapshot,
} from "./promptMarkdown";
import { $caretToken, $importPrRefs, $replaceToken, $unchip, registerAutoChip, type CaretToken } from "./promptPrRefs";

export type { CaretToken };
import { usePrRefs } from "./prRefs";
import type { PrRefKey, SlashCommand } from "@harness/api";
import { Tooltip } from "@harness/ui";

export type PromptEditorHandle = {
  /** Markdown of the current content (newlines preserved, no escapes outside code). */
  getMarkdown(): string;
  /** Replace content with plain text (`owner/repo#N` becomes a chip), caret at end, focus. */
  setText(text: string): void;
  /** Exact current content (for `restore`). */
  snapshot(): PromptSnapshot;
  /** Put a snapshot back, only if the editor is empty. Does not move focus. */
  restore(snapshot: PromptSnapshot): void;
  /** Empty the editor; keeps the caret only if the editor has focus. */
  clear(): void;
  focus(): void;
  /** Replace `token` (if its text is still there) with a PR chip and a space, or with `text`; caret after it, focus. */
  replaceToken(token: CaretToken, by: { pr: PrRefKey; typed: string } | { text: string }): void;
};

export type MenuKey = "up" | "down" | "pick" | "close";

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
};

const theme: InitialConfigType["theme"] = {
  paragraph: "m-0",
  text: {
    bold: "font-semibold",
    italic: "italic",
    strikethrough: "line-through",
    code: "rounded bg-muted px-1 font-mono text-[0.9em]",
  },
  code: "my-1 block [tab-size:4] overflow-x-auto whitespace-pre rounded-md border bg-background/60 p-2 font-mono text-xs data-[language]:before:mb-1 data-[language]:before:block data-[language]:before:select-none data-[language]:before:text-[0.65rem] data-[language]:before:text-muted-foreground data-[language]:before:content-[attr(data-language)]",
  // Preflight sets `list-style: none` on ul/ol; markers come from these. Nested lists sit in a wrapper li (`nested.listitem`)
  // whose own marker is hidden; the inner list shows its depth's marker.
  list: {
    ul: "pl-5",
    ol: "list-decimal pl-5",
    ulDepth: ["list-disc", "list-[circle]", "list-[square]"],
    listitem: "my-0.5",
    nested: { listitem: "list-none" },
  },
  link: "text-primary underline underline-offset-2",
  quote: "my-1 border-l-2 pl-3 text-muted-foreground",
};

const config: InitialConfigType = { namespace: "prompt", theme, nodes: PROMPT_NODES, onError: (e) => { throw e; } };

function $reset() {
  const para = $createParagraphNode();
  $getRoot().clear().append(para);
  return para;
}

function $block(node: LexicalNode): EnterCtx["block"] {
  const chain = [node, ...node.getParents()];
  if (chain.some($isCodeNode)) return "code";
  if (chain.some($isListItemNode)) return "list";
  if (chain.some($isQuoteNode)) return "quote";
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
        <div ref={scroller} onScroll={measure} className="relative isolate max-h-[40vh] overflow-y-auto">
          <RichTextPlugin
            contentEditable={<ContentEditable aria-label="Message" spellCheck={false} autoCorrect="off" autoCapitalize="off" className="min-h-10 px-1 text-sm outline-none" />}
            placeholder={<div className="pointer-events-none absolute left-1 top-0 select-none text-sm text-muted-foreground">{props.placeholder}</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          {props.command && <CommandToken command={props.command} />}
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
  const prRefs = usePrRefs();
  const refs = useRef(prRefs);
  useLayoutEffect(() => { refs.current = prRefs; });

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
        editorState.read(() => {
          p.current.onChange($getRoot().getTextContent(), $exportMarkdown());
          p.current.onToken?.($caretToken());
        });
        p.current.onUpdate();
      }),
      // A typed PR ref followed by a space or punctuation becomes a chip once the PR is found.
      registerAutoChip(editor, () => refs.current),
      // Backspace/Delete next to a chip (or on a selected one) turns it back into the text the user typed.
      ...([[KEY_BACKSPACE_COMMAND, "backward"], [KEY_DELETE_COMMAND, "forward"]] as const).map(([cmd, dir]) =>
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
      ...([
        [KEY_ARROW_UP_COMMAND, "up"],
        [KEY_ARROW_DOWN_COMMAND, "down"],
        [KEY_ARROW_LEFT_COMMAND, "left"],
        [KEY_ARROW_RIGHT_COMMAND, "right"],
      ] as const).map(([cmd, key]: readonly [typeof KEY_ARROW_UP_COMMAND, EscapeKey]) =>
        editor.registerCommand(
          cmd,
          (e) => {
            if ((key === "up" || key === "down") && menu(key)(e)) return true;
            if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || !$escapeBlock(key)) return false;
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
          else if (block === "list") editor.dispatchCommand(e.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND, undefined);
          else return false;
          e.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // Escape closes the open "/" menu; otherwise rich-text blurs the editor.
      editor.registerCommand(KEY_ESCAPE_COMMAND, menu("close"), COMMAND_PRIORITY_HIGH),
      // Only list items indent (rich-text would pad paragraphs/code otherwise).
      editor.registerCommand(INDENT_CONTENT_COMMAND, () => ($indentListItems(1), true), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(OUTDENT_CONTENT_COMMAND, () => ($indentListItems(-1), true), COMMAND_PRIORITY_HIGH),
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
          if (action === "default" || (action === "code" && !$exitCode())) return false;
          e.preventDefault();
          if (action === "pick") p.current.onMenuKey("pick");
          else if (action === "send") p.current.onSubmit();
          else if (action === "paragraph") editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
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
          if (data?.types.includes("application/x-lexical-editor")) return false;
          const t = data?.getData("text/plain");
          if (!t || !$isRangeSelection($getSelection())) return false;
          e.preventDefault();
          $insertPlainText(t);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [editor]);

  return null;
}

const HIGHLIGHT = "prompt-command";
// One Highlight for every prompt box (Main and Side Thread); each adds and removes its own range.
const commandRanges = typeof Highlight === "undefined" ? null : new Highlight();

/**
 * Colors the leading `/name` with a CSS Custom Highlight, so the editor content stays plain text. On hover, a tint
 * behind it (the scroller is `isolate`, so `-z-10` stays above the card) and its description.
 */
function CommandToken({ command }: { command: SlashCommand }) {
  const [editor] = useLexicalComposerContext();
  const range = useRef<Range | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const root = editor.getRootElement();
    const token = `/${command.name}`;
    const drop = () => {
      if (range.current) commandRanges?.delete(range.current);
      range.current = null;
    };
    const update = () => {
      drop();
      const first = root && document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
      if (!(first instanceof Text) || !first.data.startsWith(token)) return;
      const r = document.createRange();
      r.setStart(first, 0);
      r.setEnd(first, token.length);
      range.current = r;
      commandRanges?.add(r);
    };
    const hover = (e: MouseEvent) => {
      const r = range.current?.getBoundingClientRect();
      const parent = root?.offsetParent;
      const over = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!over || !parent) return setBox(null);
      const p = parent.getBoundingClientRect();
      setBox({ left: r.left - p.left + parent.scrollLeft - 2, top: r.top - p.top + parent.scrollTop, width: r.width + 4, height: r.height });
    };
    const leave = () => setBox(null);
    if (commandRanges && typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.set(HIGHLIGHT, commandRanges);
    update();
    const off = editor.registerUpdateListener(update);
    root?.addEventListener("mousemove", hover);
    root?.addEventListener("mouseleave", leave);
    return () => {
      off();
      root?.removeEventListener("mousemove", hover);
      root?.removeEventListener("mouseleave", leave);
      drop();
      setBox(null);
    };
  }, [editor, command]);

  if (!box) return null;
  const tint = <div aria-hidden className="pointer-events-none absolute -z-10 rounded bg-accent" style={box} />;
  if (!command.description) return tint;
  return (
    <Tooltip open side="top" align="start" className="max-w-80 text-sm" content={<><div className="text-muted-foreground">/{command.name}</div>{command.description}</>}>
      {tint}
    </Tooltip>
  );
}

function handle(editor: LexicalEditor): PromptEditorHandle {
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
