import type { HarnessClient, PrFilter, PullRequest } from "@harness/api";
import { useEffect, useState } from "react";

/** A PR picked from the list, or typed by number (title unknown). */
export type PickedPr = Pick<PullRequest, "number"> & Partial<PullRequest>;

/** The "Pull request" start point: the list for a repository folder, the filter, and the pick. */
export function usePullRequests({
   client,
   isOpen,
   folder,
   isRepo,
}: {
   client: HarnessClient;
   isOpen: boolean;
   folder: string;
   isRepo: boolean;
}) {
   const [mode, setMode] = useState<"branch" | "pr">("branch");
   const [prs, setPrs] = useState<PullRequest[] | null>(null);
   /** `false` when `gh` can't list PRs here: the Pull request tab is hidden. */
   const [prAvailable, setPrAvailable] = useState(false);
   const [prFilter, setPrFilter] = useState<PrFilter>("open");
   const [pr, setPr] = useState<PickedPr | null>(null);

   // A new folder, or a reopen: nothing of the last one stays.
   // biome-ignore lint/correctness/useExhaustiveDependencies: the folder and the dialog being open are what resets
   useEffect(() => {
      setPrs(null);
      setPrAvailable(false);
      setPr(null);
      setMode("branch");
   }, [folder, isOpen, client]);

   useEffect(() => {
      if (!isRepo || !folder.trim()) return;
      let off = false;
      setPrs(null);
      client
         .listPullRequests(folder.trim(), prFilter)
         .then((l) => {
            if (off) return;
            setPrs(l);
            setPrAvailable(true);
         })
         .catch(() => {
            if (off) return;
            setPrAvailable(false);
            setMode("branch");
         });
      return () => {
         off = true;
      };
   }, [isRepo, folder, prFilter, client]);

   return { mode, setMode, prs, prAvailable, prFilter, setPrFilter, pr, setPr };
}
