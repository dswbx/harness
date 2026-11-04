import { saveFile } from "@harness/api";
import {
   Button,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from "@harness/ui";
import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { ExportFormat } from "./exportFormats";

/** A Download button with a menu of file formats. The app's save dialog asks where. `icon`: no label, like a dialog's X. */
export function ExportMenu({
   formats,
   icon,
   className,
}: {
   formats: ExportFormat[];
   icon?: boolean;
   className?: string;
}) {
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
   return (
      <div className={className}>
         {error && <span className="mr-2 text-xs text-destructive">{error}</span>}
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               {icon ? (
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-7 opacity-70 hover:opacity-100"
                     aria-label="Download"
                     disabled={busy}
                  >
                     {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
                  </Button>
               ) : (
                  <Button size="sm" variant="outline" disabled={busy}>
                     {busy ? <LoaderCircle className="animate-spin" /> : <Download />} Download
                  </Button>
               )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
               {formats.map((f) => (
                  <DropdownMenuItem key={f.file} onSelect={() => void save(f)}>
                     {f.label}
                  </DropdownMenuItem>
               ))}
            </DropdownMenuContent>
         </DropdownMenu>
      </div>
   );
}
