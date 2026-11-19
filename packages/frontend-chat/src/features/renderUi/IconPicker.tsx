import { cn, Input, ScrollArea } from "@harness/ui";
import { useEffect, useMemo, useState } from "react";
import { lucideIconNames, PanelIcon } from "./panelIcon";
import { ICONS } from "./tools";

const COLS = 8;
/** A cell is `size-7` (28px) plus the 2px gap. */
const ROW = 30;
const INSET = 2;
const VIEW = 150;
const OVERSCAN = 2;

/** Lowercase, without dashes and spaces: "Git Branch" finds "git-branch". */
const squash = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");

function Cell({ name, on, onPick }: { name: string; on: boolean; onPick: (n: string) => void }) {
   return (
      <button
         type="button"
         role="radio"
         aria-checked={on}
         aria-label={name}
         title={name}
         onClick={() => onPick(name)}
         className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            on && "bg-accent text-foreground ring-1 ring-ring",
         )}
      >
         <PanelIcon name={name} className="size-4" />
      </button>
   );
}

/**
 * Icon choice: the Agent's short list, or, once something is typed in the search, every lucide icon
 * (loaded on first search). Results are windowed by rows of `COLS`, so only the icons in view mount.
 */
export function IconPicker({
   labelId,
   picked,
   onPick,
}: {
   labelId: string;
   picked: string | null;
   onPick: (name: string) => void;
}) {
   const [query, setQuery] = useState("");
   const [names, setNames] = useState<string[] | null>(null);
   const [top, setTop] = useState(0);
   const searching = squash(query) !== "";
   useEffect(() => {
      if (!searching || names) return;
      let live = true;
      lucideIconNames().then((n) => live && setNames(n));
      return () => {
         live = false;
      };
   }, [searching, names]);

   const curated = useMemo(
      () =>
         picked && !(ICONS as readonly string[]).includes(picked) ? [picked, ...ICONS] : [...ICONS],
      [picked],
   );
   const found = useMemo(() => {
      const q = squash(query);
      if (!q || !names) return [];
      // Exact name, then prefix, then a word in the name, then anywhere.
      const rank = (n: string) => {
         const s = squash(n);
         if (s === q) return 0;
         if (s.startsWith(q)) return 1;
         if (n.split("-").some((w) => w.startsWith(q))) return 2;
         return s.includes(q) ? 3 : -1;
      };
      return names
         .map((n) => [n, rank(n)] as const)
         .filter(([, r]) => r >= 0)
         .sort((a, b) => a[1] - b[1])
         .map(([n]) => n);
   }, [query, names]);

   const rows = Math.ceil(found.length / COLS);
   const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
   const last = Math.min(rows, Math.ceil((top + VIEW) / ROW) + OVERSCAN);
   const shown = found.slice(first * COLS, last * COLS);

   return (
      <div className="flex flex-col gap-1.5">
         <span id={labelId} className="text-xs font-medium">
            Icon
         </span>
         <Input
            type="search"
            aria-label="Search icons"
            placeholder="Search all icons"
            value={query}
            onChange={(e) => {
               setQuery(e.target.value);
               setTop(0);
            }}
            onKeyDown={(e) => {
               if (e.key === "Enter") e.preventDefault();
            }}
         />
         {!searching ? (
            <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-8 gap-0.5">
               {curated.map((n) => (
                  <Cell key={n} name={n} on={picked === n} onPick={onPick} />
               ))}
            </div>
         ) : !names ? (
            <p className="py-2 text-xs text-muted-foreground">Loading icons…</p>
         ) : found.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">No icons match</p>
         ) : (
            <ScrollArea
               className="rounded-md"
               style={{ height: Math.min(VIEW, rows * ROW) + 2 * INSET }}
               key={query}
               onViewportScroll={(e) => setTop(e.currentTarget.scrollTop)}
            >
               <div
                  role="radiogroup"
                  aria-labelledby={labelId}
                  className="grid grid-cols-8 content-start gap-0.5"
                  // INSET keeps the selected ring off the viewport edge, where it is clipped.
                  style={{
                     padding: INSET,
                     paddingTop: INSET + first * ROW,
                     paddingBottom: INSET + (rows - last) * ROW,
                  }}
               >
                  {shown.map((n) => (
                     <Cell key={n} name={n} on={picked === n} onPick={onPick} />
                  ))}
               </div>
            </ScrollArea>
         )}
      </div>
   );
}
