import { Button } from "@harness/ui";
import { X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useReportError } from "../platform/toast";
import { getImportedThemes, getThemes, onThemesChange, setImportedThemes } from "./appearance";
import { Row } from "./Row";

/** Imported themes, each removable (the current one falls back to Default). */
export function ImportedThemes({ current, onRemoved }: { current: string; onRemoved: () => void }) {
   const report = useReportError();
   const themes = useSyncExternalStore(onThemesChange, getThemes).filter((t) => t.imported);
   if (!themes.length) return null;
   const remove = (id: string) => {
      const { [id]: _, ...rest } = getImportedThemes();
      setImportedThemes(rest).catch((e) => report("Could not remove the theme", e));
      if (id === current) onRemoved();
   };
   return (
      <Row label="Imported">
         <div className="flex min-w-0 flex-wrap gap-1.5">
            {themes.map((t) => (
               <span
                  key={t.id}
                  className="inline-flex h-7 items-center gap-1 rounded-md border pl-2 pr-0.5 text-xs"
               >
                  {t.label}
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-6 text-muted-foreground"
                     aria-label={`Remove ${t.label}`}
                     onClick={() => remove(t.id)}
                  >
                     <X />
                  </Button>
               </span>
            ))}
         </div>
      </Row>
   );
}
