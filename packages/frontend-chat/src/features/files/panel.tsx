import { openWindow } from "@harness/api";
import { Folder } from "lucide-react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { usePanelTargetState } from "../../panels/usePanelTarget";
import { FilesPanel, type FileTarget, filesWindowUrl } from "./FilesPanel";

/**
 * The Session folder's files. It polls its own workspace and git state. Opened at a file (and lines), it shows
 * them; the Quick Overlay has no Files panel, so there it opens the Files window.
 */
export const filesPanel = definePanel<null, FileTarget>({
   id: "files",
   label: "Files",
   icon: Folder,
   placement: { edge: "right" },
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   fallback: ({ api }, ref) => {
      void openWindow(
         `files-${api.sessionId}`,
         filesWindowUrl(api.sessionId, ref.path, ref.start),
         {
            title: `Files: ${ref.path}`,
            remember: "files",
            overlayTitleBar: true,
         },
      );
   },
   Body: ({ ctx, self }: PanelBodyProps<null, FileTarget>) => {
      // A new object each time, so the same file scrolls to its lines again.
      const target = usePanelTargetState(self, (t) => ({ ...t }));
      return <FilesPanel api={ctx.api} target={target} />;
   },
});
