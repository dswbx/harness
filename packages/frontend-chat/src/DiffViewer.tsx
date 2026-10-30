import { useMemo, useState, useSyncExternalStore } from "react";
import { MessageSquare, X } from "lucide-react";
import { DiffModeEnum, DiffView, SplitSide } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import "./diffView.css";
import { Button, Textarea, Tooltip, cn } from "@harness/ui";
import { hunkLines, langOf, type FilePatch } from "./diff";
import { addReviewComment, removeReviewComment, type DiffComment } from "./reviewComments";

/** Full old/new file text; lets git-diff-view expand collapsed unchanged regions. */
export type FileContents = { old: string; new: string };

function subscribeDark(cb: () => void) {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => o.disconnect();
}
/** Follows the app's `.dark` class. git-diff-view only knows light/dark; colors come from our tokens (diffView.css). */
export const useIsDark = () => useSyncExternalStore(subscribeDark, () => document.documentElement.classList.contains("dark"));

/** The code on one line: from full contents when loaded, else from the hunks. */
export function codeAt(file: FilePatch, contents: FileContents | undefined, side: "old" | "new", line: number): string {
  const full = contents?.[side];
  if (full) return full.split("\n")[line - 1] ?? "";
  return hunkLines(file.text)[side].get(line) ?? "";
}

const NO_COMMENTS: DiffComment[] = [];
const sideName = (s: SplitSide): "old" | "new" => (s === SplitSide.old ? "old" : "new");

function CommentForm({ onSubmit, onCancel }: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const submit = () => text.trim() && onSubmit(text);
  return (
    <div className="harness-diff-widget space-y-1.5 border-y bg-muted/40 p-2 font-sans">
      <Textarea
        autoFocus
        value={text}
        rows={2}
        placeholder="Comment for the Agent. Enter adds, Shift+Enter new line, Esc cancels."
        className="min-h-12 text-xs"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>Cancel</Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={!text.trim()} onClick={submit}>Add to prompt</Button>
      </div>
    </div>
  );
}

function CommentList({ sessionId, comments }: { sessionId: string; comments: DiffComment[] }) {
  return (
    <div className="harness-diff-widget space-y-1 border-y bg-muted/40 px-2 py-1.5 font-sans">
      {comments.map((c) => (
        <div key={c.id} className="flex items-start gap-1.5 text-xs">
          <MessageSquare className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.text}</span>
          <Tooltip content="Remove comment">
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              aria-label="Remove comment"
              onClick={() => removeReviewComment(sessionId, c.id)}
            >
              <X className="size-3" />
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

/**
 * One file of a git diff, rendered by git-diff-view. Hover a changed line's gutter and click "+" to comment;
 * comments go to the Session's prompt box (reviewComments.ts).
 */
export function DiffViewer({
  sessionId, file, comments = NO_COMMENTS, mode, contents, fontSize = 12, wrap = false, className,
}: {
  /** Absent: read-only, no comments. */
  sessionId?: string;
  file: FilePatch;
  /** This Session's comments; the ones for `file` show under their lines. */
  comments?: DiffComment[];
  mode: "split" | "unified";
  contents?: FileContents;
  fontSize?: number;
  wrap?: boolean;
  className?: string;
}) {
  const dark = useIsDark();
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
    const ext: { oldFile: Record<string, { data: DiffComment[] }>; newFile: Record<string, { data: DiffComment[] }> } = { oldFile: {}, newFile: {} };
    for (const c of comments) {
      if (c.path !== file.path) continue;
      const m = c.side === "old" ? ext.oldFile : ext.newFile;
      (m[String(c.line)] ??= { data: [] }).data.push(c);
    }
    return ext;
  }, [comments, file.path]);

  return (
    <div className={cn("harness-diff", className)}>
      <DiffView<DiffComment[]>
        data={data}
        extendData={extendData}
        diffViewMode={mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewTheme={dark ? "dark" : "light"}
        diffViewFontSize={fontSize}
        diffViewWrap={wrap}
        diffViewHighlight
        diffViewAddWidget={!!sessionId}
        renderExtendLine={({ data: cs }) => sessionId && <CommentList sessionId={sessionId} comments={cs} />}
        renderWidgetLine={({ lineNumber, side, onClose }) => sessionId && (
          <CommentForm
            onCancel={onClose}
            onSubmit={(text) => {
              const s = sideName(side);
              addReviewComment(sessionId, { path: file.path, line: lineNumber, side: s, code: codeAt(file, contents, s, lineNumber), text: text.trim() });
              onClose();
            }}
          />
        )}
      />
    </div>
  );
}
