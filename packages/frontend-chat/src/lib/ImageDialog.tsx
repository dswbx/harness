import { Dialog, DialogContent, DialogTitle } from "@harness/ui";

/** Full-size view of one image (an attachment in the prompt box or a sent message). */
export function ImageDialog({
   src,
   alt,
   open,
   onOpenChange,
}: {
   src: string | null;
   alt: string;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}) {
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="w-auto max-w-[90vw] p-2">
            <DialogTitle className="sr-only">{alt}</DialogTitle>
            {src && (
               <img
                  src={src}
                  alt={alt}
                  className="max-h-[85vh] max-w-full rounded object-contain"
               />
            )}
         </DialogContent>
      </Dialog>
   );
}
