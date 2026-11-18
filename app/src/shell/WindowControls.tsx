import { Badge, Button, Tooltip } from "@harness/ui";
import { ChevronLeft, ChevronRight, PanelLeft, Plus } from "lucide-react";

/** Marks a window served by the Vite dev server, to tell it from the installed app. */
export const DevBadge = () =>
   import.meta.env.DEV ? (
      <Badge variant="warning" className="pointer-events-none px-1.5 text-[10px] uppercase">
         Dev
      </Badge>
   ) : null;

/** Back/forward, sidebar toggle and New Session, next to the traffic lights. */
export function WindowControls({
   sidebarOpen,
   onToggleSidebar,
   onBack,
   onForward,
   onNew,
}: {
   sidebarOpen: boolean;
   onToggleSidebar: () => void;
   /** Undefined: nothing to go back / forward to (button disabled). */
   onBack?: () => void;
   onForward?: () => void;
   onNew: () => void;
}) {
   const btn = "size-7 text-muted-foreground hover:text-foreground";
   return (
      <div className="flex items-center gap-0.5">
         <Tooltip content="Back (⌘[)" side="bottom">
            <Button
               size="icon"
               variant="ghost"
               className={btn}
               aria-label="Back"
               disabled={!onBack}
               onClick={onBack}
            >
               <ChevronLeft />
            </Button>
         </Tooltip>
         <Tooltip content="Forward (⌘])" side="bottom">
            <Button
               size="icon"
               variant="ghost"
               className={btn}
               aria-label="Forward"
               disabled={!onForward}
               onClick={onForward}
            >
               <ChevronRight />
            </Button>
         </Tooltip>
         <Tooltip content={sidebarOpen ? "Hide sidebar" : "Show sidebar"} side="left">
            <Button
               size="icon"
               variant="ghost"
               className={btn}
               aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
               onClick={onToggleSidebar}
            >
               <PanelLeft />
            </Button>
         </Tooltip>
         <Tooltip content="New Session" side="right">
            <Button
               size="icon"
               variant="ghost"
               className={btn}
               aria-label="New Session"
               onClick={onNew}
            >
               <Plus />
            </Button>
         </Tooltip>
      </div>
   );
}
