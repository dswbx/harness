import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle } from "@harness/ui";
import { Maximize2 } from "lucide-react";
import { createContext, type ReactNode, useState } from "react";
import { useCapture } from "./Capture";
import { ExportMenu } from "./ExportMenu";
import type { ExportFormat } from "./exportFormats";

/** True inside the expanded view: content there may take all the height it needs. */
export const InExpanded = createContext(false);

/**
 * Content with an Expand button (on hover, in its top right corner, or in the chat column's right gutter
 * where `--expand-out: 1`) that opens it in a near full-screen view. `expanded`: what that view shows; else
 * `children` again, scrolling. That view has a Download menu: `formats` (given a way to take a PNG of a node) lists
 * the files, by default a PNG of `children`.
 */
export function Expandable({
   label,
   children,
   expanded,
   formats,
   className,
   ...data
}: {
   label: string;
   children: ReactNode;
   expanded?: ReactNode;
   formats?: (png: (node?: ReactNode) => ExportFormat) => ExportFormat[];
   className?: string;
   [data: `data-${string}`]: string;
}) {
   const [open, setOpen] = useState(false);
   const { stage, shoot } = useCapture();
   const png = (node: ReactNode = children): ExportFormat => ({
      label: "PNG",
      file: `${label}.png`,
      blob: async () => (await shoot(node)).png,
   });
   return (
      <div className={cn("group/expand relative", className)} {...data}>
         {/* Nested ones (a diagram in a render_ui card) have no gutter of their own: their buttons go inside. */}
         <div className="contents [--expand-out:0]">{children}</div>
         <Button
            size="icon"
            variant="ghost"
            className="absolute top-[calc(0.375rem*(1-var(--expand-out,0)))] right-[calc(0.375rem-2.625rem*var(--expand-out,0))] size-7 bg-background/80 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/expand:opacity-100"
            aria-label={`Expand ${label}`}
            onClick={() => setOpen(true)}
         >
            <Maximize2 />
         </Button>
         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="h-[90vh] max-w-[94vw] grid-rows-1 overflow-hidden p-0">
               <DialogTitle className="sr-only">{label}</DialogTitle>
               <DialogDescription className="sr-only">Expanded view</DialogDescription>
               <InExpanded.Provider value={true}>
                  {expanded ?? <div className="min-h-0 overflow-auto p-8 pt-12">{children}</div>}
               </InExpanded.Provider>
               <ExportMenu
                  className="absolute top-2.5 right-12 flex items-center"
                  formats={formats ? formats(png) : [png()]}
               />
               {stage}
            </DialogContent>
         </Dialog>
      </div>
   );
}
