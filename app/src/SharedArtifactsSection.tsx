import type { SharedArtifactEntry } from "@harness/api";
import { cn, ScrollArea, Tooltip } from "@harness/ui";
import { ChevronDown, Search, Share2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "./sessionGroups";
import {
   hasChanged,
   isSharedSeen,
   markSeen,
   type SharedSeen,
   visibleShared,
} from "./sharedSection";
import { useStored } from "./useStored";

const SEEN_KEY = "harness.sharedArtifacts.seen";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/**
 * The sidebar's Shared Artifacts (ADR 0024), docked under the Session list: a header with count,
 * search and collapse, then one row per artifact, newest first, with a dot when it changed since
 * the user last opened it.
 */
export function SharedArtifactsSection({
   list,
   selected,
   onSelect,
}: {
   /** null while loading. */
   list: readonly SharedArtifactEntry[] | null;
   selected: string | null;
   onSelect: (id: string) => void;
}) {
   const [collapsed, setCollapsed] = useStored("harness.sharedArtifacts.collapsed", false, isBool);
   const [seen, setSeen] = useStored<SharedSeen>(
      SEEN_KEY,
      { since: Date.now(), seen: {} },
      isSharedSeen,
   );
   const [searching, setSearching] = useState(false);
   const [query, setQuery] = useState("");
   const input = useRef<HTMLInputElement>(null);

   // Keep the first `since`, so a reload does not hide what changed while the app was closed.
   useEffect(() => {
      try {
         if (localStorage.getItem(SEEN_KEY) === null) setSeen(seen);
      } catch {
         /* per-window convenience only */
      }
   }, [seen, setSeen]);

   // Opening an artifact marks it seen, and so does each change while it is open.
   const open = list?.find((e) => e.meta.id === selected)?.meta;
   const openId = open?.id;
   const openUpdated = open?.updated_ms;
   useEffect(() => {
      if (openId === undefined || openUpdated === undefined) return;
      const next = markSeen(seen, openId, openUpdated);
      if (next !== seen) setSeen(next);
   }, [openId, openUpdated, seen, setSeen]);

   const rows = useMemo(() => visibleShared(list ?? [], query), [list, query]);
   const now = Date.now();
   const closeSearch = () => {
      setQuery("");
      setSearching(false);
   };

   return (
      <section aria-label="Shared artifacts" className="flex shrink-0 flex-col border-t">
         <div className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-3.5">
            <button
               aria-expanded={!collapsed}
               onClick={() => setCollapsed(!collapsed)}
               className="flex h-7 min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
               <Share2 className="size-3.5 shrink-0" />
               <span className="truncate text-foreground/75">Shared artifacts</span>
               {list && <span className="shrink-0 tabular-nums">{list.length}</span>}
            </button>
            <Tooltip content="Search shared artifacts" side="top">
               <button
                  aria-label="Search shared artifacts"
                  aria-pressed={searching}
                  onClick={() => {
                     if (searching) return closeSearch();
                     setSearching(true);
                     if (collapsed) setCollapsed(false);
                     requestAnimationFrame(() => input.current?.focus());
                  }}
                  className={cn(
                     "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                     searching && "bg-accent text-accent-foreground",
                  )}
               >
                  <Search className="size-3.5" />
               </button>
            </Tooltip>
            <button
               aria-label={collapsed ? "Expand shared artifacts" : "Collapse shared artifacts"}
               aria-expanded={!collapsed}
               onClick={() => setCollapsed(!collapsed)}
               className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
               <ChevronDown
                  className={cn("size-3.5 transition-transform", collapsed && "-rotate-90")}
               />
            </button>
         </div>
         {!collapsed && (
            <>
               {searching && (
                  <div className="shrink-0 px-2.5 pb-1.5">
                     <label className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
                        <Search className="size-3 shrink-0 opacity-80" />
                        <input
                           ref={input}
                           value={query}
                           onChange={(e) => setQuery(e.target.value)}
                           onKeyDown={(e) => e.key === "Escape" && closeSearch()}
                           placeholder="Filter shared artifacts"
                           aria-label="Filter shared artifacts"
                           className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                        />
                        <button
                           aria-label="Close search"
                           onClick={closeSearch}
                           className="grid size-5 shrink-0 place-items-center rounded hover:bg-accent hover:text-accent-foreground"
                        >
                           <X className="size-3" />
                        </button>
                     </label>
                  </div>
               )}
               <ScrollArea className="max-h-[35vh]" viewportClassName="max-h-[inherit]">
                  <ul className="flex flex-col gap-px px-2 pb-2">
                     {list?.length === 0 && (
                        <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
                           No shared artifacts yet.
                        </li>
                     )}
                     {list && list.length > 0 && rows.length === 0 && (
                        <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
                           No matches for “{query.trim()}”
                        </li>
                     )}
                     {rows.map((e) => {
                        const isSel = e.meta.id === selected;
                        const changed = hasChanged(e, seen, selected);
                        return (
                           <li key={e.meta.id}>
                              <button
                                 onClick={() => onSelect(e.meta.id)}
                                 aria-current={isSel || undefined}
                                 title={e.meta.title}
                                 className={cn(
                                    "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-foreground/80 hover:bg-accent/60 hover:text-accent-foreground",
                                    isSel &&
                                       "bg-accent font-medium text-accent-foreground hover:bg-accent",
                                 )}
                              >
                                 <span className="min-w-0 flex-1 truncate">{e.meta.title}</span>
                                 {changed && (
                                    <span
                                       aria-label="Changed"
                                       className="size-2 shrink-0 rounded-full bg-sky-500"
                                    />
                                 )}
                                 <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                                    {relativeTime(e.meta.updated_ms, now)}
                                 </span>
                              </button>
                           </li>
                        );
                     })}
                  </ul>
               </ScrollArea>
            </>
         )}
      </section>
   );
}
