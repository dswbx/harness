import type { SessionApi } from "@harness/api";
import { errText } from "@harness/api";
import { Button } from "@harness/ui";
import { Archive } from "lucide-react";
import { useState } from "react";

/** Where the prompt box would be in an archived Session: unarchive to continue. */
export function ArchivedNotice({ api }: { api: SessionApi }) {
   const [error, setError] = useState<string | null>(null);
   return (
      <div role="alert" className="p-3">
         <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
            <Archive className="size-4 text-muted-foreground" />
            <span className="flex-1">Archived. Unarchive to continue</span>
            <Button
               size="sm"
               onClick={() => {
                  setError(null);
                  api.unarchive().catch((e) => setError(errText(e)));
               }}
            >
               Unarchive
            </Button>
         </div>
         {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
   );
}
