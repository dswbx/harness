import { Badge, Button, Tooltip } from "@harness/ui";
import { ChevronUp, X, Zap } from "lucide-react";
import type { ReactNode } from "react";

export function IconButton({
   label,
   onClick,
   children,
}: {
   label: string;
   onClick: () => void;
   children: ReactNode;
}) {
   return (
      <Tooltip content={label} side="bottom">
         <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label={label}
            onClick={onClick}
         >
            {children}
         </Button>
      </Tooltip>
   );
}

/** The minimized overlay: one bar to drag, no input. */
export function MiniBar({
   title,
   newReply,
   onClose,
   onExpand,
}: {
   title: string;
   newReply: boolean;
   onClose: () => void;
   onExpand: () => void;
}) {
   return (
      <div
         data-tauri-drag-region
         className="flex h-[52px] items-center gap-2 rounded-xl border bg-background px-2 shadow-overlay"
      >
         <IconButton label="Close" onClick={onClose}>
            <X />
         </IconButton>
         <div data-tauri-drag-region className="h-5 w-px shrink-0 bg-border" />
         <Zap data-tauri-drag-region className="size-4 shrink-0 text-muted-foreground" />
         <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
         </span>
         {newReply && (
            <Badge data-tauri-drag-region className="shrink-0">
               New reply
            </Badge>
         )}
         <IconButton label="Expand (⌘M)" onClick={onExpand}>
            <ChevronUp />
         </IconButton>
      </div>
   );
}
