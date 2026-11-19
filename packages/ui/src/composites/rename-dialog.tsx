import { useEffect, useState } from "react";
import { Button } from "../primitives/button";
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from "../primitives/dialog";
import { Input } from "../primitives/input";

/**
 * A dialog with one text field. Enter saves, Esc cancels; Save needs a changed, non-empty value.
 * `onSave` may be async: the dialog stays open and shows its error when it rejects.
 */
export function RenameDialog({
   open,
   onOpenChange,
   title,
   label,
   value,
   maxLength,
   description,
   onSave,
}: {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   /** The dialog heading. */
   title: string;
   /** Accessible name of the field. */
   label: string;
   value: string;
   maxLength?: number;
   description?: string;
   onSave: (value: string) => void | Promise<void>;
}) {
   const [draft, setDraft] = useState(value);
   const [error, setError] = useState<string | null>(null);
   useEffect(() => {
      if (open) {
         setDraft(value);
         setError(null);
      }
   }, [open, value]);
   const next = draft.trim();
   const canSave = next !== "" && next !== value.trim();
   const save = () => {
      if (!canSave) return;
      Promise.resolve()
         .then(() => onSave(next))
         .then(
            () => onOpenChange(false),
            (e) => setError((e as { message?: string } | null)?.message ?? String(e)),
         );
   };
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>{title}</DialogTitle>
               {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            <Input
               autoFocus
               value={draft}
               maxLength={maxLength}
               onChange={(e) => setDraft(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && save()}
               aria-label={label}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
               <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
               </Button>
               <Button disabled={!canSave} onClick={save}>
                  Save
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
