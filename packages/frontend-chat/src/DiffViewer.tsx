import { DiffModeEnum, DiffView, SplitSide } from "@git-diff-view/react";
import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import "./diffView.css";
import { cn, ResizeHandle, Tooltip, useDragDelta } from "@harness/ui";
import { type FilePatch, hunkLines, langOf } from "./diff";
import { CommentForm, CommentList } from "./ReviewCommentWidgets";
import { addReviewComment, type DiffComment } from "./reviewComments";

/** Full old/new file text; lets git-diff-view expand collapsed unchanged regions. */
export type FileContents = { old: string; new: string };

function subscribeRoot(cb: () => void) {
   const o = new MutationObserver(cb);
   o.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
   return () => o.disconnect();
}
/** Follows the app's `.dark` class. git-diff-view only knows light/dark; colors come from our tokens (diffView.css). */
export const useIsDark = () =>
   useSyncExternalStore(subscribeRoot, () => document.documentElement.classList.contains("dark"));

/** The code font size in px (Appearance, `--code-font-size` on <html>). git-diff-view takes a number. */
export const useCodeFontSize = () =>
   useSyncExternalStore(subscribeRoot, () => {
      const n = Number.parseFloat(
         getComputedStyle(document.documentElement).getPropertyValue("--code-font-size"),
      );
      return Number.isFinite(n) && n > 0 ? n : 12;
   });

/** Comment count of a file in a file list. */
export function CommentCount({ n }: { n: number }) {
   if (n <= 0) return null;
   return (
      <Tooltip content={n === 1 ? "1 comment" : `${n} comments`}>
         <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <MessageSquare className="size-3" />
            {n}
         </span>
      </Tooltip>
   );
}

const SPLIT_KEY = "harness:diff-split";
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;
const readSplit = () => {
   try {
      const r = Number(localStorage.getItem(SPLIT_KEY));
      return r >= SPLIT_MIN && r <= SPLIT_MAX ? r : 0.5;
   } catch {
      return 0.5;
   }
};

/** Split mode: where the old side ends, as a share of the width; dragged with a handle, remembered per viewer. */
function useSplit() {
   const box = useRef<HTMLDivElement>(null);
   const [ratio, setRatio] = useState(readSplit);
   const [width, setWidth] = useState(0);
   useEffect(() => {
      const el = box.current;
      if (!el) return;
      const o = new ResizeObserver(() => setWidth(el.clientWidth));
      o.observe(el);
      return () => o.disconnect();
   }, []);
   const save = (r: number) => {
      try {
         localStorage.setItem(SPLIT_KEY, String(r));
      } catch {
         /* per-viewer convenience only */
      }
   };
   const start = useRef(ratio);
   const last = useRef(ratio);
   const onPointerDown = useDragDelta({
      cursor: "col-resize",
      onStart: () => {
         start.current = ratio;
         last.current = ratio;
      },
      onDelta: (dx) => {
         if (!width) return;
         last.current = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, start.current + dx / width));
         setRatio(last.current);
      },
      onEnd: () => save(last.current),
   });
   const reset = () => {
      setRatio(0.5);
      save(0.5);
   };
   /** px, so it works in table column widths too. */
   const left = Math.round(width * ratio);
   return { box, left, handle: { onPointerDown, onDoubleClick: reset } };
}

/** The code on one line: from full contents when loaded, else from the hunks. */
export function codeAt(
   file: FilePatch,
   contents: FileContents | undefined,
   side: "old" | "new",
   line: number,
): string {
   const full = contents?.[side];
   if (full) return full.split("\n")[line - 1] ?? "";
   return hunkLines(file.text)[side].get(line) ?? "";
}

const NO_COMMENTS: DiffComment[] = [];
const sideName = (s: SplitSide): "old" | "new" => (s === SplitSide.old ? "old" : "new");

/**
 * One file of a git diff, rendered by git-diff-view. Hover a changed line's gutter and click "+" to comment;
 * comments go to the Session's prompt box (reviewComments.ts).
 */
export function DiffViewer({
   sessionId,
   file,
   comments = NO_COMMENTS,
   mode,
   contents,
   fontSize,
   wrap = false,
   resizable = false,
   className,
}: {
   /** Absent: read-only, no comments. */
   sessionId?: string;
   file: FilePatch;
   /** This Session's comments; the ones for `file` show under their lines. */
   comments?: DiffComment[];
   mode: "split" | "unified";
   contents?: FileContents;
   /** px; defaults to the code font size (Appearance). */
   fontSize?: number;
   wrap?: boolean;
   /** Split mode: a handle drags the line between the old and new side. */
   resizable?: boolean;
   className?: string;
}) {
   const dark = useIsDark();
   const codeSize = useCodeFontSize();
   const split = useSplit();
   const showHandle = resizable && mode === "split" && split.left > 0;
   const lang = langOf(file.path);
   // New object only when the input changes: git-diff-view rebuilds its DiffFile on a new `data`.
   const data = useMemo(
      () => ({
         oldFile: { fileName: file.oldPath, fileLang: lang, content: contents?.old ?? null },
         newFile: { fileName: file.newPath, fileLang: lang, content: contents?.new ?? null },
         hunks: [file.text],
      }),
      [file.text, file.oldPath, file.newPath, lang, contents],
   );
   const extendData = useMemo(() => {
      const ext: {
         oldFile: Record<string, { data: DiffComment[] }>;
         newFile: Record<string, { data: DiffComment[] }>;
      } = { oldFile: {}, newFile: {} };
      for (const c of comments) {
         if (c.path !== file.path) continue;
         const m = c.side === "old" ? ext.oldFile : ext.newFile;
         (m[String(c.line)] ??= { data: [] }).data.push(c);
      }
      return ext;
   }, [comments, file.path]);

   return (
      <div
         ref={split.box}
         // `isolate`: git-diff-view's sticky line-number cells use `z-[1]`; keep that from painting over the composer.
         className={cn(
            "harness-diff isolate",
            showHandle && "harness-diff-resizable relative",
            className,
         )}
         style={
            showHandle
               ? ({ "--harness-split-left": `${split.left}px` } as React.CSSProperties)
               : undefined
         }
      >
         {showHandle && (
            <ResizeHandle
               label="Resize sides"
               style={{ top: 0, bottom: 0, left: split.left - 4, width: 8 }}
               {...split.handle}
            />
         )}
         <DiffView<DiffComment[]>
            data={data}
            extendData={extendData}
            diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewTheme={dark ? "dark" : "light"}
            diffViewFontSize={fontSize ?? codeSize}
            diffViewWrap={wrap}
            diffViewHighlight
            diffViewAddWidget={!!sessionId}
            renderExtendLine={({ data: cs }) =>
               sessionId && <CommentList sessionId={sessionId} comments={cs} />
            }
            renderWidgetLine={({ lineNumber, side, onClose }) =>
               sessionId && (
                  <CommentForm
                     onCancel={onClose}
                     onSubmit={(text) => {
                        const s = sideName(side);
                        addReviewComment(sessionId, {
                           path: file.path,
                           line: lineNumber,
                           side: s,
                           code: codeAt(file, contents, s, lineNumber),
                           text: text.trim(),
                        });
                        onClose();
                     }}
                  />
               )
            }
         />
      </div>
   );
}
