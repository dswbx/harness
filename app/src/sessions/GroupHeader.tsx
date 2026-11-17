import { cn } from "@harness/ui";
import { ChevronRight, Folder, Plus, Zap } from "lucide-react";
import type { Group } from "./sessionGroups";

/**
 * A group's header: its folded caret and count, with the + that starts a Session in it. A folder
 * group's header is also its drag handle (`onDragStart`, see `useFolderDrag`).
 */
export function GroupHeader({
   g,
   open,
   onToggle,
   onNewInFolder,
   onNewQuick,
   onDragStart,
}: {
   g: Group;
   open: boolean;
   onToggle: () => void;
   /** Starts dragging this folder group to reorder it. */
   onDragStart?: (e: React.PointerEvent) => void;
   /** Opens the Composer with this folder picked (the + on a folder group). */
   onNewInFolder?: (folder: string) => void;
   /** Starts a Quick Session right away (the + on the Quick group). */
   onNewQuick?: () => void;
}) {
   return (
      <div
         className="group/hdr relative flex items-center"
         data-folder-group={g.folder && onDragStart ? g.id : undefined}
      >
         <button
            aria-expanded={open}
            onClick={() => onToggle()}
            onPointerDown={onDragStart}
            className={cn(
               "flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-medium text-muted-foreground transition-[padding] hover:text-foreground group-hover/hdr:pr-7 group-has-focus-visible/hdr:pr-7",
               g.quick && "pr-7",
            )}
         >
            {g.folder && <Folder className="size-3.25 shrink-0" />}
            {g.quick && <Zap className="size-3.25 shrink-0" />}
            <span className="min-w-0 truncate text-foreground/75 group-hover/hdr:text-foreground">
               {g.label}
            </span>
            <span className="shrink-0 tabular-nums">{g.sessions.length}</span>
            <ChevronRight
               className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
            />
         </button>
         {g.folder && onNewInFolder && g.sessions[0] && (
            <button
               aria-label={`New Session in ${g.label}`}
               onClick={() =>
                  onNewInFolder(g.sessions[0]!.workspace.source_folder || g.sessions[0]!.folder)
               }
               className="absolute right-1 grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition hover:bg-accent hover:text-accent-foreground group-hover/hdr:opacity-100 group-has-focus-visible/hdr:opacity-100 focus-visible:opacity-100"
            >
               <Plus className="size-3.5" />
            </button>
         )}
         {g.quick && onNewQuick && (
            <button
               aria-label="New Quick Session"
               onClick={() => {
                  if (!open) onToggle();
                  onNewQuick();
               }}
               className="absolute right-1 grid size-5 place-items-center rounded text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
            >
               <Plus className="size-3.5" />
            </button>
         )}
      </div>
   );
}
