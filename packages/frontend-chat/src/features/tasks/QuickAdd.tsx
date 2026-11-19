import { errText } from "@harness/api";
import { cn } from "@harness/ui";
import { CornerDownLeft, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PromptEditor, type PromptEditorHandle } from "../prompt/PromptEditor";

const noop = () => {};

/**
 * One line that adds a task: the title in Markdown, Enter adds it and empties the line. Escape calls `onCancel`
 * (when given), so a subtask line can close.
 */
export function QuickAdd({
   label,
   placeholder,
   onAdd,
   onCancel,
   autoFocus,
   className,
}: {
   label: string;
   placeholder: string;
   onAdd: (title: string) => Promise<unknown>;
   onCancel?: () => void;
   autoFocus?: boolean;
   className?: string;
}) {
   const editor = useRef<PromptEditorHandle>(null);
   useEffect(() => {
      if (autoFocus) editor.current?.focus();
   }, [autoFocus]);
   const busy = useRef(false);
   const [empty, setEmpty] = useState(true);
   const [error, setError] = useState<string | null>(null);
   const submit = () => {
      const title = editor.current?.getMarkdown().trim() ?? "";
      if (!title || busy.current) return;
      busy.current = true;
      setError(null);
      onAdd(title).then(
         () => {
            busy.current = false;
            editor.current?.clear();
         },
         (e) => {
            busy.current = false;
            setError(errText(e));
         },
      );
   };
   return (
      <div className={className}>
         <div
            className={cn(
               "flex min-h-9 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 transition-colors",
               "focus-within:border-ring/50 dark:focus-within:border-border",
            )}
            onKeyDown={(e) => {
               if (e.key === "Escape" && onCancel) {
                  e.preventDefault();
                  onCancel();
               }
            }}
         >
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
               <PromptEditor
                  ref={editor}
                  label={label}
                  placeholder={placeholder}
                  singleLine
                  menuOpen={false}
                  onMenuKey={noop}
                  onSubmit={submit}
                  onChange={(text) => setEmpty(text.trim() === "")}
                  minHeightClassName="min-h-5"
               />
            </div>
            <CornerDownLeft
               aria-hidden
               className={cn(
                  "size-3 shrink-0 text-muted-foreground transition-opacity",
                  empty && "opacity-40",
               )}
            />
         </div>
         {error && (
            <div role="alert" className="px-1 pt-1 text-xs text-destructive">
               {error}
            </div>
         )}
      </div>
   );
}
