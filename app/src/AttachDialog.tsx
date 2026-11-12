import { errText, type SessionSummary } from "@harness/api";
import {
   cn,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogHeader,
   DialogTitle,
   Input,
   ScrollArea,
} from "@harness/ui";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { folderName, matches, relativeTime } from "./sessionGroups";

/** "Attach to Session…" for a Shared Artifact (ADR 0024): pick a Session, newest first. */
export function AttachDialog({
   open,
   onOpenChange,
   sessions,
   attached,
   onPick,
}: {
   open: boolean;
   onOpenChange: (o: boolean) => void;
   sessions: readonly SessionSummary[];
   /** Sessions that have it already: shown, not pickable. */
   attached: readonly string[];
   onPick: (sessionId: string) => Promise<void>;
}) {
   const [query, setQuery] = useState("");
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   useEffect(() => {
      if (open) {
         setQuery("");
         setError(null);
      }
   }, [open]);
   const q = query.trim().toLowerCase();
   const rows = sessions.filter((s) => matches(s, q)).sort((a, b) => b.updated_ms - a.updated_ms);
   const pickable = rows.filter((s) => !attached.includes(s.id));
   const pick = (id: string) => {
      setBusy(true);
      setError(null);
      onPick(id)
         .catch((e) => setError(errText(e)))
         .finally(() => setBusy(false));
   };
   const now = Date.now();
   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="gap-3">
            <DialogHeader>
               <DialogTitle>Attach to Session</DialogTitle>
               <DialogDescription>The artifact shows as a Panel in that Session.</DialogDescription>
            </DialogHeader>
            <Input
               autoFocus
               value={query}
               onChange={(e) => setQuery(e.target.value)}
               onKeyDown={(e) => {
                  if (e.key === "Enter" && pickable[0] && !busy) pick(pickable[0].id);
               }}
               placeholder="Search sessions"
               aria-label="Search sessions"
            />
            <ScrollArea
               className="max-h-72 rounded-md border"
               viewportClassName="max-h-[inherit] p-1"
            >
               {rows.length === 0 && (
                  <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                     No sessions found.
                  </p>
               )}
               {rows.map((s) => {
                  const has = attached.includes(s.id);
                  return (
                     <button
                        key={s.id}
                        disabled={has || busy}
                        onClick={() => pick(s.id)}
                        className={cn(
                           "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none",
                           has && "opacity-60",
                        )}
                     >
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        {has ? (
                           <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                              <Check className="size-3.5" /> Attached
                           </span>
                        ) : (
                           <span className="shrink-0 text-xs text-muted-foreground">
                              {s.quick ? "Quick" : folderName(s.folder)} ·{" "}
                              {relativeTime(s.updated_ms, now)}
                           </span>
                        )}
                     </button>
                  );
               })}
            </ScrollArea>
            {error && (
               <p role="alert" className="text-sm text-destructive">
                  {error}
               </p>
            )}
         </DialogContent>
      </Dialog>
   );
}
