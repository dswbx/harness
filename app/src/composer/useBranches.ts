import { type Branches, type BranchInfo, errText, type HarnessClient } from "@harness/api";
import { useEffect, useState } from "react";

/** The branches of the chosen folder: loaded debounced (the path can be typed), and refreshed after an Update. */
export function useBranches({
   client,
   isOpen,
   folder,
   setError,
   onLoaded,
}: {
   client: HarnessClient;
   isOpen: boolean;
   folder: string;
   setError: (e: string | null) => void;
   /** The first load of a folder: preselect the start point. */
   onLoaded: (b: Branches) => void;
}) {
   const [branches, setBranches] = useState<Branches | null>(null);
   /** Bumped to reload the branch list (after an Update) without resetting the pick. */
   const [branchesVersion, setBranchesVersion] = useState(0);
   /** Branch being fast-forwarded. */
   const [updating, setUpdating] = useState<string | null>(null);

   // Branches (and whether PRs are available) once a folder is chosen; debounced, it can be typed.
   // biome-ignore lint/correctness/useExhaustiveDependencies: setError and onLoaded only call stable state setters
   useEffect(() => {
      setError(null); // a new folder, or a reopen: no error of the last one
      setBranches(null);
      if (!isOpen || !folder.trim()) return;
      let off = false;
      const h = setTimeout(() => {
         client
            .listBranches(folder.trim())
            .then((b) => {
               if (off) return;
               setBranches(b);
               onLoaded(b);
            })
            .catch((e) => !off && setError(errText(e)));
      }, 250);
      return () => {
         off = true;
         clearTimeout(h);
      };
   }, [folder, isOpen, client]);

   // After an Update: fresh ahead/behind counts, the pick kept.
   useEffect(() => {
      if (!branchesVersion || !folder.trim()) return;
      let off = false;
      client
         .listBranches(folder.trim())
         .then((b) => !off && setBranches(b))
         .catch(() => {});
      return () => {
         off = true;
      };
   }, [branchesVersion, folder, client]);

   const updateBranch = (b: BranchInfo) => {
      setUpdating(b.name);
      setError(null);
      client
         .updateBranch(folder.trim(), b.name)
         .then(() => setBranchesVersion((v) => v + 1))
         .catch((e) => setError(`Could not update ${b.name}: ${errText(e)}`))
         .finally(() => setUpdating(null));
   };

   return { branches, updating, updateBranch };
}
