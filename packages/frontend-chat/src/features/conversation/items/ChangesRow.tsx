import { ChevronRight, Diff } from "lucide-react";
import type { Item } from "../../../state/reducer";

/** One line under a Turn: totals and file names; opens the diff scoped to that Turn. */
export function ChangesRow({
   item,
   onOpen,
}: {
   item: Extract<Item, { type: "changes" }>;
   onOpen: () => void;
}) {
   const n = item.files.length;
   const sum = (key: "additions" | "deletions") =>
      item.files.reduce((total, f) => total + (f[key] ?? 0), 0);
   const additions = sum("additions");
   const deletions = sum("deletions");
   const names = item.files.map((f) => f.path.slice(f.path.lastIndexOf("/") + 1)).join(", ");
   return (
      <button
         type="button"
         className="flex w-full items-baseline gap-x-2.5 border-t pt-3 text-left text-[13px] text-muted-foreground hover:text-foreground"
         onClick={onOpen}
      >
         <Diff className="size-4 shrink-0 self-center" />
         <span className="shrink-0 font-medium text-foreground">
            {n} {n === 1 ? "file" : "files"} changed
         </span>
         {(additions > 0 || deletions > 0) && (
            <span className="flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
               <span className="text-emerald-600">+{additions}</span>
               <span className="text-red-600">-{deletions}</span>
            </span>
         )}
         <span className="min-w-0 flex-1 truncate font-mono text-xs">{names}</span>
         <ChevronRight className="size-3.5 shrink-0 self-center" />
      </button>
   );
}
