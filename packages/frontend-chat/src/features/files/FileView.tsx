import { anchorLine, type LineCommentState, type SessionApi } from "@harness/api";
import { cn } from "@harness/ui";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCodeFontSize } from "../changes/DiffViewer";
import { WRAP } from "../markdown/CodeBlock";
import { highlightLines, languageOf, type Run } from "../markdown/highlight";
import { CommentForm, CommentList } from "../review/ReviewCommentWidgets";

/** Above this many lines the file shows plain: highlighting it would block the window. */
export const MAX_HIGHLIGHT_LINES = 5000;

/** Lines to show marked and scroll to (1-based, inclusive). */
export type LineRange = { start: number; end: number };

/**
 * One whole file with line numbers, highlighted. `mode: "comment"`: hover a line's number and click "+" to comment;
 * comments are core Review Comments (ADR 0027) that wait in the prompt box until sent, and show under their lines
 * (a comment follows its line's code when the file changed, and says so when it cannot). (An edit mode can come
 * later.) `target` lines are marked and scrolled into view.
 */
export function FileView({
   api,
   path,
   lines,
   comments,
   target,
   wrap = false,
   mode,
   className,
}: {
   api: SessionApi;
   path: string;
   lines: readonly string[];
   /** This Session's comments on working-tree lines; the ones for `path` show under their lines. */
   comments: readonly LineCommentState[];
   target?: LineRange | null;
   wrap?: boolean;
   mode: "comment";
   className?: string;
}) {
   const fontSize = useCodeFontSize();
   const box = useRef<HTMLDivElement>(null);
   const [form, setForm] = useState<number | null>(null);
   /** The scroller's width: comment widgets stay this wide while the lines scroll sideways. */
   const [width, setWidth] = useState(0);
   const rows: Run[][] = useMemo(
      () => highlightLines(lines.length > MAX_HIGHLIGHT_LINES ? null : languageOf(path), lines),
      [path, lines],
   );
   const byLine = useMemo(() => {
      const m = new Map<number, { comments: LineCommentState[]; outdated: Set<string> }>();
      for (const c of comments) {
         if (c.path !== path) continue;
         const at = anchorLine(lines, c.line, c.code);
         const t = m.get(at.line) ?? { comments: [], outdated: new Set<string>() };
         t.comments.push(c);
         if (at.outdated) t.outdated.add(c.id);
         m.set(at.line, t);
      }
      return m;
   }, [comments, path, lines]);

   useEffect(() => {
      const el = box.current;
      if (!el) return;
      const o = new ResizeObserver(() => setWidth(el.clientWidth));
      o.observe(el);
      return () => o.disconnect();
   }, []);

   // A new target scrolls to its lines; a reload of the same file does not.
   useEffect(() => {
      if (!target) return;
      box.current
         ?.querySelector(`[data-line="${target.start}"]`)
         ?.scrollIntoView({ block: "center" });
   }, [target]);

   const from = target?.start ?? Number.POSITIVE_INFINITY;
   const to = target?.end ?? target?.start ?? 0;
   const digits = `${String(lines.length).length + 1}ch`;
   const widget = (children: React.ReactNode) => (
      <div className="sticky left-0" style={{ width: width || undefined }}>
         {children}
      </div>
   );

   return (
      <div
         ref={box}
         className={cn(
            "code-colors min-h-0 flex-1 select-text overflow-auto py-1.5 font-mono leading-5",
            className,
         )}
         style={{ fontSize }}
      >
         {rows.map((runs, i) => {
            const n = i + 1;
            const marked = n >= from && n <= to;
            const cs = byLine.get(n);
            return (
               <div key={n}>
                  <div
                     data-line={n}
                     className={cn(
                        "group flex min-w-full",
                        !wrap && "w-max",
                        marked && "bg-sky-500/10",
                     )}
                     style={{ contentVisibility: "auto", containIntrinsicSize: "auto 20px" }}
                  >
                     <span
                        style={{ minWidth: digits }}
                        className={cn(
                           "sticky left-0 shrink-0 select-none bg-background pr-3 pl-6 text-right text-muted-foreground/60 tabular-nums",
                           marked &&
                              "bg-[color-mix(in_oklab,var(--color-sky-500)_10%,var(--background))] text-muted-foreground shadow-[inset_2px_0_0_var(--color-sky-500)]",
                        )}
                     >
                        {mode === "comment" && (
                           <button
                              type="button"
                              aria-label={`Comment on line ${n}`}
                              className="absolute top-0.5 left-1 hidden size-4 items-center justify-center rounded bg-primary text-primary-foreground group-hover:flex focus-visible:flex"
                              onClick={() => setForm(n)}
                           >
                              <Plus className="size-3" />
                           </button>
                        )}
                        {n}
                     </span>
                     <span
                        className={cn(
                           "min-w-0 flex-1 pr-3 text-foreground",
                           wrap ? WRAP : "whitespace-pre",
                        )}
                     >
                        {runs.map((r, j) => (
                           // biome-ignore lint/suspicious/noArrayIndexKey: runs of one line.
                           <span key={j} className={r.cls}>
                              {r.text}
                           </span>
                        ))}
                        {!runs.length && " "}
                     </span>
                  </div>
                  {cs &&
                     widget(
                        <CommentList api={api} comments={cs.comments} outdated={cs.outdated} />,
                     )}
                  {form === n &&
                     widget(
                        <CommentForm
                           onCancel={() => setForm(null)}
                           onSubmit={async (text) => {
                              await api.addComment({
                                 path,
                                 line: n,
                                 side: null,
                                 code: lines[n - 1] ?? "",
                                 text: text.trim(),
                              });
                              setForm(null);
                           }}
                        />,
                     )}
               </div>
            );
         })}
      </div>
   );
}
