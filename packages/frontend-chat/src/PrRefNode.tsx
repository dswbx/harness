import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  FOCUS_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { displayRef, prKey, type PrRefKey } from "@harness/api";
import { PrChipView, usePrRefs, type RegisterEscape } from "./prRefs";

export type SerializedPrRefNode = Spread<{ owner: string; repo: string; number: number; typed: string }, SerializedLexicalNode>;

/**
 * A PR ref in the prompt, shown as a chip. Its text (what is sent) is always the qualified `owner/repo#N`, whatever the
 * user typed; `typed` comes back when Backspace turns the chip into text again.
 */
export class PrRefNode extends DecoratorNode<ReactNode> {
  __owner: string;
  __repo: string;
  __number: number;
  __typed: string;

  static getType() {
    return "pr-ref";
  }
  static clone(n: PrRefNode) {
    return new PrRefNode(n.__owner, n.__repo, n.__number, n.__typed, n.__key);
  }
  static importJSON(s: SerializedPrRefNode) {
    return $createPrRefNode({ repo: { owner: s.owner, name: s.repo }, number: s.number }, s.typed);
  }

  constructor(owner: string, repo: string, number: number, typed: string, key?: NodeKey) {
    super(key);
    this.__owner = owner;
    this.__repo = repo;
    this.__number = number;
    this.__typed = typed;
  }

  exportJSON(): SerializedPrRefNode {
    const s = this.getLatest();
    return { ...super.exportJSON(), owner: s.__owner, repo: s.__repo, number: s.__number, typed: s.__typed };
  }
  createDOM() {
    return document.createElement("span");
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return true;
  }
  getRefKey(): PrRefKey {
    const s = this.getLatest();
    return { repo: { owner: s.__owner, name: s.__repo }, number: s.__number };
  }
  getTyped() {
    return this.getLatest().__typed;
  }
  getTextContent() {
    return prKey(this.getRefKey());
  }
  decorate(_editor: LexicalEditor) {
    return <PromptPrChip nodeKey={this.__key} refKey={this.getRefKey()} typed={this.__typed} />;
  }
}

export const $createPrRefNode = (key: PrRefKey, typed: string) =>
  $applyNodeReplacement(new PrRefNode(key.repo.owner, key.repo.name, key.number, typed));
export const $isPrRefNode = (n: LexicalNode | null | undefined): n is PrRefNode => n instanceof PrRefNode;

/**
 * The chip in the prompt: `#N` for the Session's repo, else `owner/repo#N`. Active (popover above) while the caret is
 * next to it. Esc closes its open popover before anything else in the editor (menus, blur).
 */
function PromptPrChip({ nodeKey, refKey, typed }: { nodeKey: NodeKey; refKey: PrRefKey; typed: string }) {
  const refs = usePrRefs();
  const [editor] = useLexicalComposerContext();
  const [active, setActive] = useState(false);
  useEffect(() => {
    const check = () => {
      const focused = !!editor.getRootElement()?.contains(document.activeElement);
      setActive(focused && editor.getEditorState().read(() => $prRefAtCaret()?.getKey() === nodeKey));
    };
    // On blur `activeElement` moves only after the event.
    const later = () => (setTimeout(check), false);
    check();
    const offs = [
      editor.registerUpdateListener(check),
      editor.registerCommand(FOCUS_COMMAND, later, COMMAND_PRIORITY_LOW),
      editor.registerCommand(BLUR_COMMAND, later, COMMAND_PRIORITY_LOW),
    ];
    return () => offs.forEach((off) => off());
  }, [editor, nodeKey]);
  const onEscape = useCallback<RegisterEscape>(
    (handle) =>
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (e) => {
          if (!handle()) return false;
          e?.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    [editor],
  );
  const onCaret = useCallback(
    (side: "before" | "after") =>
      editor.update(() => {
        const n = $getNodeByKey(nodeKey);
        if (!n) return;
        if (side === "before") n.selectPrevious();
        else n.selectNext(0, 0);
      }),
    [editor, nodeKey],
  );
  if (!refs) return <>{typed}</>;
  return <PrChipView refs={refs} prKey={refKey} raw={typed} text={displayRef(refKey, refs.ctx)} prompt={{ active, onEscape, onCaret }} />;
}

/** The node right before (`before`) or after a point, or null when the point is inside text. */
export function $nodeAt(pt: PointType, side: "before" | "after"): LexicalNode | null {
  const n = pt.getNode();
  if (pt.type === "text") {
    if (side === "before") return pt.offset === 0 ? n.getPreviousSibling() : null;
    return pt.offset === n.getTextContentSize() ? n.getNextSibling() : null;
  }
  return $isElementNode(n) ? n.getChildAtIndex(side === "before" ? pt.offset - 1 : pt.offset) : null;
}

/** The chip that is selected, or next to the collapsed caret (the one before it first). */
export function $prRefAtCaret(): PrRefNode | null {
  const sel = $getSelection();
  if ($isNodeSelection(sel)) {
    const nodes = sel.getNodes();
    return nodes.length === 1 && $isPrRefNode(nodes[0]) ? nodes[0] : null;
  }
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return null;
  const n = [$nodeAt(sel.anchor, "before"), $nodeAt(sel.anchor, "after")].find($isPrRefNode);
  return n ?? null;
}
