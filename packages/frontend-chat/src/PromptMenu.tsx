import { type PrEntry, type PrInfo, type PrRefKey, repoName } from "@harness/api";
import { cn, ScrollArea } from "@harness/ui";
import { Book } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
   exactNumber,
   type PrMenuRow,
   type PrMenuState,
   prMenuHeader,
   prMenuRows,
   prMenuState,
   searchQuery,
} from "./prMenu";
import type { PrRefs } from "./prRefs";
import { formatAge, useNow } from "./time";
import { prStateVisual } from "./UiPullRequest";

/**
 * A popup above the prompt box, out of the flow (the slash and `#` menus): a listbox that scrolls past `maxHeight`, with
 * an optional header and footer that stay put.
 */
export function PromptMenu({
   label,
   className,
   maxHeight = "max-h-72",
   header,
   footer,
   children,
}: {
   label: string;
   /** Width. */
   className: string;
   maxHeight?: string;
   header?: ReactNode;
   footer?: ReactNode;
   children: ReactNode;
}) {
   return (
      // Radix sets an inline `position: relative` on the ScrollArea root, so the wrapper takes the popup out of the flow.
      <div className={cn("absolute bottom-full left-6 mb-1 max-w-[calc(100%-3rem)]", className)}>
         <div className="overflow-hidden rounded-lg border bg-popover shadow-md">
            {header}
            <ScrollArea className={maxHeight} viewportClassName="max-h-[inherit]">
               <div className="p-1" role="listbox" aria-label={label}>
                  {children}
               </div>
            </ScrollArea>
            {footer}
         </div>
      </div>
   );
}

/** How long typing pauses before a `#` search goes out. */
export const PR_SEARCH_DELAY = 150;

export type PrMenu = { state: PrMenuState; rows: PrMenuRow[]; loading: boolean };

const NONE = () => () => {};

/**
 * The `#` menu for `token` (the `#` token at the caret): rows from `searchPrs` (debounced, cached per repo and query) plus
 * an exact lookup for a full number. While a search runs, the last rows of the same repo stay. Null for no popup: no
 * menu for this token, nothing found, or the search failed (no `gh`).
 */
export function usePrMenu(token: string | null, refs: PrRefs | null): PrMenu | null {
   const state = useMemo(
      () => (token && refs ? prMenuState(token, refs.ctx) : null),
      [token, refs],
   );
   const repo = state && state.mode !== "repos" ? state.repo : null;
   const repoId = repo ? repoName(repo).toLowerCase() : null;
   const query = state ? (searchQuery(state) ?? null) : null;
   const number = state ? exactNumber(state) : null;
   const want = repoId === null ? null : `${repoId}\n${query ?? ""}`;
   const [res, setRes] = useState<{ want: string; repoId: string; prs: PrInfo[] | null } | null>(
      null,
   );
   const [exactKey, setExactKey] = useState<PrRefKey | null>(null);

   useEffect(() => {
      if (!refs || !repo || want === null || repoId === null) return;
      const done = (prs: PrInfo[] | null) => setRes({ want, repoId, prs });
      const cached = refs.search.peek(repo, query);
      if (cached) done(cached);
      const key = number ? { repo, number } : null;
      const t = setTimeout(
         () => {
            setExactKey(key);
            if (key) refs.store.request(key);
            if (!cached) refs.search.get(repo, query).then(done, () => done(null));
         },
         cached && !key ? 0 : PR_SEARCH_DELAY,
      );
      return () => clearTimeout(t);
      // `repo`/`query` are covered by `want`, `number` by itself.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [refs, want, number]);

   const store = refs?.store;
   const exactEntry = useSyncExternalStore(
      store?.subscribe ?? NONE,
      () => (store && exactKey ? store.peek(exactKey) : null) as PrEntry | null,
   );

   if (!state || !refs) return null;
   if (state.mode === "repos")
      return { state, rows: prMenuRows(state, [], null, refs.me), loading: false };
   const current = res && res.want === want;
   const exactWanted =
      !!number &&
      !!exactKey &&
      exactKey.number === number &&
      repoName(exactKey.repo).toLowerCase() === repoId;
   const exact = exactWanted && exactEntry?.status === "found" ? exactEntry.pr : null;
   const prs = res && res.repoId === repoId ? res.prs : null;
   const rows = prMenuRows(state, prs ?? [], exact, refs.me);
   const loading = !current || (!!number && (!exactWanted || exactEntry?.status === "loading"));
   const failed = !!current && res.prs === null;
   if (!rows.length && (failed || !loading)) return null;
   return { state, rows, loading };
}

const underline =
   "font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px]";

/** `text` with the characters at `positions` underlined. */
function Marked({ text, positions }: { text: string; positions: number[] }) {
   const on = new Set(positions);
   const runs: { text: string; on: boolean }[] = [];
   for (let i = 0; i < text.length; i++) {
      const last = runs.at(-1);
      if (last && last.on === on.has(i)) last.text += text[i];
      else runs.push({ text: text[i]!, on: on.has(i) });
   }
   return (
      <>
         {runs.map((r, i) =>
            r.on ? (
               <span key={i} className={underline}>
                  {r.text}
               </span>
            ) : (
               r.text
            ),
         )}
      </>
   );
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** The `#` menu: header (repo + why these rows), PR or repo rows, key hints. */
export function PrMenuPopup({
   menu,
   refs,
   sel,
   onSelect,
   onPick,
}: {
   menu: PrMenu;
   refs: PrRefs;
   sel: number;
   onSelect(i: number): void;
   onPick(i: number): void;
}) {
   const now = useNow();
   const head = prMenuHeader(menu.state, refs.ctx);
   const repoRow = menu.rows[sel]?.kind === "repo";
   return (
      <PromptMenu
         label="Pull requests"
         className="w-[440px]"
         maxHeight="max-h-[12.5rem]"
         header={
            <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs text-muted-foreground">
               <span className="min-w-0 truncate">{head.title}</span>
               <span className="ml-auto shrink-0">{head.note}</span>
            </div>
         }
         footer={
            <div className="flex gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
               <span>↑↓ select</span>
               <span>⏎ insert</span>
               <span>{repoRow ? "tab pick repo" : "tab complete"}</span>
               <span>esc close</span>
            </div>
         }
      >
         {menu.rows.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Searching…</div>
         )}
         {menu.rows.map((row, i) => (
            <button
               key={row.kind === "pr" ? row.pr.number : repoName(row.hit.repo.repo)}
               ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
               role="option"
               aria-selected={i === sel}
               className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                  i === sel && "bg-foreground/8",
               )}
               // Keep the caret in the editor: the pick replaces the token at it.
               onMouseDown={(e) => e.preventDefault()}
               onMouseMove={() => i !== sel && onSelect(i)}
               onClick={() => onPick(i)}
            >
               {row.kind === "pr" ? <PrRow row={row} now={now} /> : <RepoRow row={row} now={now} />}
            </button>
         ))}
      </PromptMenu>
   );
}

function PrRow({
   row: { pr, hit },
   now,
}: {
   row: Extract<PrMenuRow, { kind: "pr" }>;
   now: number;
}) {
   const v = prStateVisual(pr.state, pr.checks);
   return (
      <>
         <v.Icon className={cn("size-4 shrink-0", v.fg)} aria-label={v.label} />
         <span className="shrink-0 font-mono text-[13px]">#{pr.number}</span>
         <span className="min-w-0 truncate">
            {hit ? <Marked text={pr.title} positions={range(hit[0], hit[1])} /> : pr.title}
         </span>
         <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
            {formatAge(Date.parse(pr.updated_at), now)}
         </span>
      </>
   );
}

function RepoRow({
   row: { hit },
   now,
}: {
   row: Extract<PrMenuRow, { kind: "repo" }>;
   now: number;
}) {
   const k = hit.repo;
   return (
      <>
         <Book className="size-4 shrink-0 text-muted-foreground" aria-hidden />
         <span className="min-w-0 truncate">
            <Marked text={repoName(k.repo)} positions={hit.positions} />
         </span>
         <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
            {k.sessions} {k.sessions === 1 ? "session" : "sessions"}
            {k.last_ms ? ` · ${formatAge(k.last_ms, now)}` : ""}
         </span>
      </>
   );
}
