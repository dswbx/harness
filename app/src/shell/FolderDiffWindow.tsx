import { ALL_CHANGES, diffWindowScope, folderGit, type Transport } from "@harness/api";
import { useMemo } from "react";
import { folderDiff } from "../platform/frontends";

/** A Folder Diff window (`?folder=<abs>&pane=diff`): a folder's repository diff with no Session, drawn by a Frontend. */
export function FolderDiffWindow({ transport, folder }: { transport: Transport; folder: string }) {
   const git = useMemo(() => folderGit(transport, folder), [transport, folder]);
   const scope = useMemo(() => diffWindowScope(window.location.search) ?? ALL_CHANGES, []);
   const FolderDiff = folderDiff();
   if (!FolderDiff)
      return (
         <div className="p-6 text-sm text-muted-foreground">
            No installed Frontend can show a folder's diff.
         </div>
      );
   return (
      <div className="h-full">
         <FolderDiff folder={folder} git={git} scope={scope} />
      </div>
   );
}
