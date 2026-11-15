import type { HarnessClient } from "@harness/api";
import { useEffect, useRef, useState } from "react";
import {
   loadRecent,
   mergeRecent,
   pathsToRequest,
   type RecentFolder,
   sessionFolders,
   sourceFolders,
} from "./composer";

/** The Workspace folder choice: the recent list, the chosen folder, and the current branch per recent folder. */
export function useRecentFolders({
   client,
   isOpen,
   presetFolder,
   folderOpen,
}: {
   client: HarnessClient;
   isOpen: boolean;
   /** Folder to open with; null: the most recent one. */
   presetFolder: string | null;
   folderOpen: boolean;
}) {
   const [recent, setRecent] = useState<RecentFolder[]>([]);
   const [folder, setFolder] = useState("");
   /** "No folder" picked: a Quick Session. `folder` is empty then. */
   const [noFolder, setNoFolder] = useState(false);
   /** Current branch per recent folder (`null`: not a repository), loaded when the list opens. */
   const [recentBranch, setRecentBranch] = useState<Record<string, string | null>>({});

   // Recent folders: picked here before, plus folders of existing Sessions. Preselect the newest.
   useEffect(() => {
      if (!isOpen) return;
      let off = false;
      void client
         .listSessions()
         .catch(() => [])
         .then((sessions) => {
            if (off) return;
            const r = mergeRecent(sourceFolders(loadRecent(), sessions), sessionFolders(sessions));
            setRecent(r);
            setNoFolder(false);
            setFolder((cur) => presetFolder || cur || r[0]?.path || "");
         });
      return () => {
         off = true;
      };
   }, [isOpen, client, presetFolder]);

   // Each folder is asked once per open of the list; closing drops the answers, so the next open refreshes.
   const branchReq = useRef(new Set<string>());
   useEffect(() => {
      if (!folderOpen) {
         branchReq.current = new Set();
         setRecentBranch((m) => (Object.keys(m).length ? {} : m));
         return;
      }
      const mine = branchReq.current;
      const set = (path: string, v: string | null) =>
         branchReq.current === mine && setRecentBranch((m) => ({ ...m, [path]: v }));
      for (const path of pathsToRequest(
         recent.slice(0, 12).map((r) => r.path),
         mine,
      )) {
         mine.add(path);
         client
            .listBranches(path)
            .then((b) => set(path, b.repo_root ? (b.current ?? "detached") : null))
            .catch(() => set(path, null));
      }
   }, [folderOpen, recent, client]);

   return { recent, folder, setFolder, noFolder, setNoFolder, recentBranch };
}
