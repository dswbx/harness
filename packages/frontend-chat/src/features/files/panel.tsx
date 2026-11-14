import { Folder } from "lucide-react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { FilesPanel, type FileTarget } from "./FilesPanel";

/** The file to show next, kept by the shell until panels take typed targets. */
export type FilesBridge = { target?: FileTarget | null; onTargetShown?: () => void };
const NONE: FilesBridge = {};

/** The Session folder's files. It polls its own workspace and git state. */
export const filesPanel = definePanel<FilesBridge>({
   id: "files",
   label: "Files",
   icon: Folder,
   placement: { edge: "right" },
   useModel: () => NONE,
   status: () => ({ presence: "ready" }),
   Body: ({ model, ctx }: PanelBodyProps<FilesBridge>) => (
      <FilesPanel api={ctx.api} target={model.target} onTargetShown={model.onTargetShown} />
   ),
});
