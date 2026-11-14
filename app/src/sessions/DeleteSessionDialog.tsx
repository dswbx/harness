import type { SessionSummary } from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from "@harness/ui";

/** Confirms deleting a Session; once the core refused, the same button becomes "Delete anyway". */
export function DeleteSessionDialog({
   toDelete,
   subSessionCount,
   deleteError,
   deleting,
   onCancel,
   onConfirm,
}: {
   toDelete: SessionSummary | null;
   subSessionCount: number;
   deleteError: string | null;
   deleting: boolean;
   onCancel: () => void;
   onConfirm: () => void;
}) {
   return (
      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && onCancel()}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>Delete Session?</DialogTitle>
               <DialogDescription>
                  "{toDelete?.title}" and its log will be deleted
                  {toDelete?.quick
                     ? ", along with its folder and the files in it"
                     : toDelete?.workspace.worktree_branch
                       ? ", along with its Worktree and branch"
                       : ""}
                  {subSessionCount > 0 &&
                     `, and ${subSessionCount} sub session${subSessionCount === 1 ? "" : "s"}`}
                  . This cannot be undone.
               </DialogDescription>
            </DialogHeader>
            {deleteError && (
               <p role="alert" className="text-sm text-destructive">
                  {deleteError}
               </p>
            )}
            <DialogFooter>
               <Button variant="outline" onClick={onCancel}>
                  Cancel
               </Button>
               <Button variant="destructive" disabled={deleting} onClick={onConfirm}>
                  {deleteError ? "Delete anyway" : "Delete"}
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
