import { Badge, Button, Tooltip } from "@harness/ui";
import { PanelLeft, Plus } from "lucide-react";

/** Marks a window served by the Vite dev server, to tell it from the installed app. */
export const DevBadge = () =>
   import.meta.env.DEV ? (
      <Badge variant="warning" className="pointer-events-none px-1.5 text-[10px] uppercase">
         Dev
      </Badge>
   ) : null;

/** Sidebar toggle and New Session, next to the traffic lights. */
export function WindowControls({
   sidebarOpen,
   onToggleSidebar,
   onNew,
}: {
   sidebarOpen: boolean;
   onToggleSidebar: () => void;
   onNew: () => void;
}) {
   const btn = "size-7 text-muted-foreground hover:text-foreground";
   return (
      <div className="flex items-center gap-0.5">
         <Tooltip
            content={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            side="bottom"
            align="start"
         >
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
         <Tooltip content="New Session" side="bottom" align="end">
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
