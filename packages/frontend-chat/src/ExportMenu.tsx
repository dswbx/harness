import { saveFile } from "@harness/api";
import {
   Button,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuTrigger,
} from "@harness/ui";
import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { ExportFormat } from "./exportFormats";

/** Makes a file and saves it: the app's save dialog asks where. */
export function useExport() {
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const save = async (f: ExportFormat) => {
      setBusy(true);
      setError(null);
      try {
         await saveFile(f.file, await f.blob());
      } catch (e) {
         setError(e instanceof Error ? e.message : String(e));
      } finally {
         setBusy(false);
      }
   };
   return { busy, error, save };
}

const items = (formats: ExportFormat[], save: (f: ExportFormat) => Promise<void>) =>
   formats.map((f) => (
      <DropdownMenuItem key={f.file} onSelect={() => void save(f)}>
         {f.label}
      </DropdownMenuItem>
   ));

/** An icon button with a menu of file formats, like a dialog's X. */
export function ExportMenu({
   formats,
   className,
}: {
   formats: ExportFormat[];
   className?: string;
}) {
   const { busy, error, save } = useExport();
   return (
      <div className={className}>
         {error && <span className="mr-2 text-xs text-destructive">{error}</span>}
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 opacity-70 hover:opacity-100"
                  aria-label="Download"
                  disabled={busy}
               >
                  {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
               {items(formats, save)}
            </DropdownMenuContent>
         </DropdownMenu>
      </div>
   );
}

/** The same formats as a submenu of another menu. `save`: from `useExport`, which outlives the closed menu. */
export function ExportSubmenu({
   formats,
   save,
}: {
   formats: ExportFormat[];
   save: (f: ExportFormat) => Promise<void>;
}) {
   return (
      <DropdownMenuSub>
         <DropdownMenuSubTrigger>
            <Download /> Download
         </DropdownMenuSubTrigger>
         <DropdownMenuSubContent className="w-44">{items(formats, save)}</DropdownMenuSubContent>
      </DropdownMenuSub>
   );
}
