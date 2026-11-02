import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Button } from "./button";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogContent({
   className,
   children,
   ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
   return (
      <DialogPrimitive.Portal>
         <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
         <DialogPrimitive.Content
            className={cn(
               "fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg",
               className,
            )}
            {...props}
         >
            {children}
            <DialogPrimitive.Close asChild>
               <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-2.5 top-2.5 size-7 opacity-70 hover:opacity-100"
                  aria-label="Close"
               >
                  <X />
               </Button>
            </DialogPrimitive.Close>
         </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
   );
}
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
   return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
   return <div className={cn("flex justify-end gap-2", className)} {...props} />;
}
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
   return (
      <DialogPrimitive.Title
         className={cn("text-lg font-semibold leading-none", className)}
         {...props}
      />
   );
}
function DialogDescription({
   className,
   ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
   return (
      <DialogPrimitive.Description
         className={cn("text-sm text-muted-foreground", className)}
         {...props}
      />
   );
}

export {
   Dialog,
   DialogClose,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   DialogTrigger,
};
