import { dockPanel, focusPanelWindow } from "@harness/api";
import { Button } from "@harness/ui";
import { AppWindow, Minimize2 } from "lucide-react";

/** What a popped panel's zone shows in the main window: where the panel is, Show window and Dock back. */
export function PopoutPlaceholder({
   sessionId,
   panelId,
   label,
}: {
   sessionId: string;
   panelId: string;
   label: string;
}) {
   return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
         <AppWindow className="size-8 text-muted-foreground" aria-hidden />
         <p className="text-sm text-muted-foreground">{label} is open in its own window.</p>
         <div className="flex flex-wrap justify-center gap-2">
            <Button
               size="sm"
               variant="outline"
               onClick={() =>
                  void focusPanelWindow(sessionId, panelId).catch((e) =>
                     console.error("focus window failed", e),
                  )
               }
            >
               Show window
            </Button>
            <Button size="sm" onClick={() => dockPanel(sessionId, panelId)}>
               <Minimize2 /> Dock back
            </Button>
         </div>
      </div>
   );
}
