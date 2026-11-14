import type { SlashCommand } from "@harness/api";
import { Tooltip } from "@harness/ui";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useRef, useState } from "react";

const HIGHLIGHT = "prompt-command";
// One Highlight for every prompt box (Main and Side Thread); each adds and removes its own range.
const commandRanges = typeof Highlight === "undefined" ? null : new Highlight();

/**
 * Colors the leading `/name` with a CSS Custom Highlight, so the editor content stays plain text. On hover, a tint
 * behind it (the scroller is `isolate`, so `-z-10` stays above the card) and its description.
 */
export function CommandToken({ command }: { command: SlashCommand }) {
   const [editor] = useLexicalComposerContext();
   const range = useRef<Range | null>(null);
   const [box, setBox] = useState<{
      left: number;
      top: number;
      width: number;
      height: number;
   } | null>(null);

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
         const over =
            r &&
            e.clientX >= r.left &&
            e.clientX <= r.right &&
            e.clientY >= r.top &&
            e.clientY <= r.bottom;
         if (!over || !parent) return setBox(null);
         const p = parent.getBoundingClientRect();
         setBox({
            left: r.left - p.left + parent.scrollLeft - 2,
            top: r.top - p.top + parent.scrollTop,
            width: r.width + 4,
            height: r.height,
         });
      };
      const leave = () => setBox(null);
      if (commandRanges && typeof CSS !== "undefined" && CSS.highlights)
         CSS.highlights.set(HIGHLIGHT, commandRanges);
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
   const tint = (
      <div
         aria-hidden
         className="pointer-events-none absolute -z-10 rounded bg-accent"
         style={box}
      />
   );
   if (!command.description) return tint;
   return (
      <Tooltip
         open
         side="top"
         align="start"
         className="max-w-80 text-sm"
         content={
            <>
               <div className="text-muted-foreground">/{command.name}</div>
               {command.description}
            </>
         }
      >
         {tint}
      </Tooltip>
   );
}
