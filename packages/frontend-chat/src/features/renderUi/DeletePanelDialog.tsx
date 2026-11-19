import { errText } from "@harness/api";
import {
   Button,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from "@harness/ui";
import { useEffect, useState } from "react";

/**
 * Confirms deleting a panel: it leaves the Session, a file-backed one also loses its file (`file`, its name in
 * panels/); the chat message that created it stays. The Agent's next call with the same id brings it back.
 */
export function DeletePanelDialog({
   open,
   title,
   file,
   onClose,
   onDelete,
}: {
   open: boolean;
   title: string;
   file: string | null;
   onClose: () => void;
   onDelete: () => Promise<void>;
}) {
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   useEffect(() => {
      if (open) setError(null);
   }, [open]);
   const run = () => {
      setBusy(true);
      onDelete().then(
         () => {
            setBusy(false);
            onClose();
         },
         (e) => {
            setBusy(false);
            setError(errText(e));
         },
      );
   };
   return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>Delete “{title}”?</DialogTitle>
               <DialogDescription>
                  The panel leaves this Session.
                  {file && (
                     <>
                        {" "}
                        Its file <code className="font-mono text-xs">{file}</code> is removed.
                     </>
                  )}{" "}
                  The chat message stays.
               </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-muted-foreground">Only hiding it? Use Hide (−) instead.</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
               <Button variant="outline" onClick={onClose}>
                  Cancel
               </Button>
               <Button variant="destructive" disabled={busy} onClick={run}>
                  Delete
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
