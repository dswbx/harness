import { displayRef, openExternalUrl, prKey } from "@harness/api";
import { Button, cn, DropdownMenuItem, ScrollArea, Tooltip } from "@harness/ui";
import {
   ChevronDown,
   ChevronLeft,
   ChevronRight,
   ChevronUp,
   Copy,
   ExternalLink,
   FileCode,
   Folder,
   Globe,
   Link2,
   List,
   ListTree,
   Search,
   SquareArrowOutUpRight,
} from "lucide-react";
import {
   type KeyboardEvent,
   type ReactNode,
   useEffect,
   useMemo,
   useReducer,
   useRef,
   useState,
} from "react";
import { age } from "./ArtifactsPanel";
import { FilePreview, type FileReader, useFileRefs } from "./FileRef";
import { type FileRef, lineLabel, refWindow } from "./fileRefs";
import { localPref } from "./localPref";
import { PanelHeader } from "./PanelHeader";
import { usePrRefs } from "./prRefs";
import type { Item } from "./reducer";
import {
   byRecency,
   collectReferences,
   filterReferences,
   groupReferences,
   type Mention,
   outsidePath,
   type Reference,
   type ReferenceKind,
   type ReferenceSection,
   resolveReferences,
} from "./references";
import { useNow } from "./time";
import { prStateVisual } from "./UiPullRequest";

export type ResolvedReferences = {
   refs: Reference[];
   prsUnavailable: boolean;
   /** Lookups are still running. */
   checking: boolean;
   /** For the stripe; undefined until the lookups are done. */
   count: number | undefined;
};
export const NO_REFERENCES: ResolvedReferences = {
   refs: [],
   prsUnavailable: false,
   checking: false,
   count: undefined,
};

/**
 * Finds the Session's references and, once `active` (the panel was opened), asks the PR store and the file reader about
 * each candidate and reports what exists. No lookups before that: until then the stripe's icon has no count.
 * Renders nothing; it sits inside their providers.
 */
export function ReferencesProbe({
   items,
   active,
   onResolved,
}: {
   items: Item[];
   active: boolean;
   onResolved: (r: ResolvedReferences) => void;
}) {
   const prRefs = usePrRefs();
   const reader = useFileRefs();
   const [tick, bump] = useReducer((n: number) => n + 1, 0);
   const candidates = useMemo(
      () => collectReferences(items, prRefs?.ctx ?? null),
      [items, prRefs?.ctx],
   );
   const changed = useMemo(() => {
      const s = new Set<string>();
      for (const it of items) if (it.type === "changes") for (const f of it.files) s.add(f.path);
      return s;
   }, [items]);
   const store = prRefs?.store;
   useEffect(() => store?.subscribe(bump), [store]);
   // Each lookup once per target; both caches keep the answers.
   const wanted = useMemo(() => candidates.map((c) => c.key).join("\n"), [candidates]);
   // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` stands for `candidates`, which change with every Event.
   useEffect(() => {
      if (!active) return;
      let off = false;
      for (const c of candidates) {
         if (c.kind === "pr") store?.request(c.ref);
         if (c.kind === "file" && reader) {
            const w = refWindow(c.ref);
            if (reader.peek(c.ref.path, w.from, w.to) === undefined)
               reader.read(c.ref.path, w.from, w.to).then(() => !off && bump());
         }
      }
      return () => void (off = true);
   }, [wanted, store, reader, active]);
   // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is when the caches changed.
   const resolved = useMemo(() => {
      const file = (f: FileRef) => {
         const w = refWindow(f);
         return reader ? reader.peek(f.path, w.from, w.to) : undefined;
      };
      const r = resolveReferences(candidates, {
         pr: (k) => store?.peek(k) ?? null,
         file,
         changed,
      });
      const checking =
         active &&
         candidates.some((c) =>
            c.kind === "pr"
               ? store?.peek(c.ref).status === "loading"
               : c.kind === "file" && !!reader && file(c.ref) === undefined,
         );
      const known = active && !checking;
      return {
         ...r,
         checking,
         count: known ? r.refs.length : undefined,
      };
   }, [candidates, store, reader, changed, tick, active]);
   useEffect(() => onResolved(resolved), [resolved, onResolved]);
   return null;
}

const KINDS: { kind: ReferenceKind; label: string; filter: string; group: string }[] = [
   { kind: "pr", label: "PRs", filter: "Filter PRs", group: "Group by repository" },
   { kind: "code", label: "Code", filter: "Filter files", group: "Group by workspace and folder" },
   { kind: "link", label: "Links", filter: "Filter links", group: "Group by site" },
];
/** Group or List, per tab: on is List. */
const listPrefs = {
   pr: localPref("harness.chat.references.list.pr", false),
   code: localPref("harness.chat.references.list.code", false),
   link: localPref("harness.chat.references.list.link", false),
};

const refLabel = (r: Reference) =>
   r.kind === "pr" ? `#${r.pr.number}` : r.kind === "code" ? r.name : r.title;
const countLabel = (r: Reference) => (r.mentions.length > 1 ? `${r.mentions.length}×` : null);
const rangesLabel = (r: Reference) =>
   r.kind === "code" ? r.ranges.map((x) => lineLabel(x)).join(", ") : "";

function RefIcon({ r, className }: { r: Reference; className?: string }) {
   if (r.kind === "pr") {
      const v = prStateVisual(r.pr.state, r.pr.checks);
      return <v.Icon className={cn(v.fg, className)} aria-hidden />;
   }
   if (r.kind === "code") return <FileCode className={className} aria-hidden />;
   return <Link2 className={className} aria-hidden />;
}

function Changed() {
   return (
      <Tooltip content="Changed in this Session">
         <span
            className="shrink-0 font-mono text-[11px] font-semibold text-amber-600 dark:text-amber-400"
            role="img"
            aria-label="Changed in this Session"
         >
            M
         </span>
      </Tooltip>
   );
}

function CountBadge({ r }: { r: Reference }) {
   const n = countLabel(r);
   if (!n) return null;
   return (
      <span
         className="shrink-0 rounded bg-muted px-1.5 text-[11px] leading-[17px] text-foreground/80"
         aria-label={`${r.mentions.length} mentions`}
      >
         {n}
      </span>
   );
}

/** A row, keyboard-selected from the list like the Artifacts panel's. */
function RefRow({
   selected,
   onOpen,
   className,
   style,
   children,
}: {
   selected: boolean;
   onOpen: () => void;
   className: string;
   style?: React.CSSProperties;
   children: ReactNode;
}) {
   const ref = useRef<HTMLDivElement>(null);
   useEffect(() => {
      if (selected) ref.current?.scrollIntoView({ block: "nearest" });
   }, [selected]);
   return (
      <div
         ref={ref}
         role="option"
         aria-selected={selected}
         onClick={onOpen}
         style={style}
         className={cn(
            "flex items-center select-none hover:bg-accent/60",
            selected && "bg-accent ring-1 ring-border ring-inset hover:bg-accent",
            className,
         )}
      >
         {children}
      </div>
   );
}

function GroupRow({
   r,
   pad,
   selected,
   onOpen,
}: {
   r: Reference;
   pad: number;
   selected: boolean;
   onOpen: () => void;
}) {
   const mono = r.kind !== "link";
   return (
      <RefRow
         selected={selected}
         onOpen={onOpen}
         className="min-h-7 gap-2 pr-2.5"
         style={{ paddingLeft: pad }}
      >
         <RefIcon r={r} className="size-3.5 shrink-0 text-foreground/80" />
         <span
            className={cn(
               "shrink-0 text-[12.5px]",
               mono && "font-mono",
               r.kind !== "code" && "font-medium",
            )}
         >
            {refLabel(r)}
         </span>
         <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/80">
            {r.kind === "pr" ? r.pr.title : r.kind === "link" ? pathOf(r.url) : ""}
         </span>
         {r.kind === "code" && r.changed && <Changed />}
         <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            {rangesLabel(r)}
         </span>
         <CountBadge r={r} />
      </RefRow>
   );
}

const pathOf = (url: string) => {
   try {
      const u = new URL(url);
      return u.pathname === "/" ? "" : u.pathname + u.search;
   } catch {
      return "";
   }
};

/** List view's second line: what the separators say in Group view. */
const contextLine = (r: Reference) =>
   r.kind === "pr"
      ? `${prStateVisual(r.pr.state, r.pr.checks).label} · ${r.pr.repo.owner}/${r.pr.repo.name}`
      : r.kind === "code"
        ? r.dir === "."
           ? "Session folder"
           : r.dir
        : `${r.site}${pathOf(r.url)}`;

function ListRow({ r, selected, onOpen }: { r: Reference; selected: boolean; onOpen: () => void }) {
   const now = useNow();
   return (
      <RefRow selected={selected} onOpen={onOpen} className="gap-2.5 px-2.5 py-1.5">
         <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-foreground/80">
            <RefIcon r={r} className="size-3.5" />
         </span>
         <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="flex items-center gap-1.5">
               <span
                  className={cn(
                     "shrink-0 text-[13px] font-medium",
                     r.kind !== "link" && "font-mono",
                  )}
               >
                  {refLabel(r)}
               </span>
               <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/80">
                  {r.kind === "pr" ? r.pr.title : ""}
               </span>
               {r.kind === "code" && r.changed && <Changed />}
               <CountBadge r={r} />
               <span className="shrink-0 text-xs text-muted-foreground">{age(r.ts, now)}</span>
            </span>
            <span className="flex items-center gap-2">
               <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {contextLine(r)}
               </span>
               <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                  {rangesLabel(r)}
               </span>
            </span>
         </span>
      </RefRow>
   );
}

function Chevron({ open }: { open: boolean }) {
   return <ChevronRight className={cn("size-3 shrink-0", open && "rotate-90")} aria-hidden />;
}

function SectionHeader({
   s,
   kind,
   count,
   open,
   onToggle,
}: {
   s: ReferenceSection;
   kind: ReferenceKind;
   count: number;
   open: boolean;
   onToggle: () => void;
}) {
   const Icon = kind === "code" ? Folder : kind === "link" ? Globe : null;
   return (
      <button
         type="button"
         aria-expanded={open}
         onClick={onToggle}
         className="flex h-8 w-full items-center gap-1.5 border-t pr-2.5 pl-2 text-left hover:bg-accent/40"
      >
         <span className="text-muted-foreground">
            <Chevron open={open} />
         </span>
         {Icon && <Icon className="size-3.5 shrink-0 text-foreground/80" aria-hidden />}
         <span className="truncate text-[12.5px] font-semibold">{s.title}</span>
         {s.tag && (
            <span className="shrink-0 rounded border px-1 text-[10.5px] leading-[15px] font-medium text-foreground/80">
               {s.tag}
            </span>
         )}
         <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
            {s.note}
         </span>
         <span className="text-xs text-muted-foreground">{count}</span>
      </button>
   );
}

/**
 * The References panel: every PR, file and link the Session's messages name, by kind. Group shows them by where they
 * live, List by recency. A click opens one here (inspect); its mentions jump to the chat.
 */
export function ReferencesPanel({
   resolved,
   onJump,
}: {
   resolved: ResolvedReferences;
   onJump: (rowId: string) => void;
}) {
   const { refs, prsUnavailable } = resolved;
   const sessionRepo = usePrRefs()?.ctx.sessionRepo ?? null;
   const [tab, setTab] = useState<ReferenceKind | null>(null);
   const [query, setQuery] = useState("");
   const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
   const [selected, setSelected] = useState<string | null>(null);
   const [inspecting, setInspecting] = useState<string | null>(null);
   // The first kind with something in it, until the user picks a tab.
   const kind = tab ?? KINDS.find((k) => refs.some((r) => r.kind === k.kind))?.kind ?? "code";
   const asList = listPrefs[kind].use();
   const meta = KINDS.find((k) => k.kind === kind)!;
   const matching = useMemo(() => filterReferences(refs, query), [refs, query]);
   const sections = useMemo(
      () => groupReferences(matching, kind, sessionRepo),
      [matching, kind, sessionRepo],
   );
   const toggle = (key: string) =>
      setFolded((f) => {
         const next = new Set(f);
         if (!next.delete(key)) next.add(key);
         return next;
      });
   /** The rows on screen, in order; the keys and inspect's arrows walk them. */
   const shown = useMemo(() => {
      if (asList) return byRecency(matching.filter((r) => r.kind === kind));
      return sections.flatMap((s) =>
         folded.has(s.key)
            ? []
            : [
                 ...s.dirs.flatMap((d) => (folded.has(`${s.key}/${d.label}`) ? [] : d.items)),
                 ...s.items,
              ],
      );
   }, [asList, matching, kind, sections, folded]);
   const current = inspecting ? (refs.find((r) => r.key === inspecting) ?? null) : null;
   if (current) {
      const i = shown.findIndex((r) => r.key === current.key);
      return (
         <Inspect
            r={current}
            position={i < 0 ? null : { i, n: shown.length }}
            onStep={(d) => {
               const next = shown[i + d];
               if (next) {
                  setInspecting(next.key);
                  setSelected(next.key);
               }
            }}
            onBack={() => setInspecting(null)}
            onJump={onJump}
         />
      );
   }
   const open = (r: Reference) => {
      setSelected(r.key);
      setInspecting(r.key);
   };
   const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.key !== "ArrowDown" && e.key !== "Enter")
         return;
      const i = shown.findIndex((r) => r.key === selected);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
         e.preventDefault();
         const next =
            shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
         if (next) setSelected(next.key);
      } else if (e.key === "Enter" && shown[i]) {
         e.preventDefault();
         const m = shown[i].mentions[0];
         if (m) onJump(m.rowId);
      } else if (e.key === " " && shown[i]) {
         e.preventDefault();
         open(shown[i]);
      }
   };
   const hasAny = refs.some((r) => r.kind === kind);
   return (
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
         <PanelHeader className="gap-2.5">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">References</span>
            <div
               className="inline-flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5"
               role="tablist"
               aria-label="Kind"
            >
               {KINDS.map((k) => (
                  <button
                     key={k.kind}
                     type="button"
                     role="tab"
                     aria-selected={kind === k.kind}
                     onClick={() => setTab(k.kind)}
                     className={cn(
                        "h-6 rounded px-2 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground",
                        kind === k.kind && "bg-background text-foreground shadow-sm",
                     )}
                  >
                     {k.label} {matching.filter((r) => r.kind === k.kind).length}
                  </button>
               ))}
            </div>
         </PanelHeader>
         <div className="flex shrink-0 items-center gap-2 px-2.5 py-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
               <Search className="size-3 shrink-0" />
               <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={meta.filter}
                  aria-label={meta.filter}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
               />
            </label>
            <div
               className="inline-flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5"
               role="group"
               aria-label="View"
            >
               <ViewButton
                  label={meta.group}
                  on={!asList}
                  onClick={() => listPrefs[kind].set(false)}
               >
                  <ListTree />
               </ViewButton>
               <ViewButton
                  label="List, most recent first"
                  on={asList}
                  onClick={() => listPrefs[kind].set(true)}
               >
                  <List />
               </ViewButton>
            </div>
         </div>
         {kind === "pr" && prsUnavailable && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
               GitHub CLI not available, so PRs can't be checked and stay hidden.
            </p>
         )}
         <ScrollArea className="min-h-0 flex-1">
            <div className="pb-2 outline-none" role="listbox" aria-label="References" tabIndex={0}>
               {shown.length === 0 && sections.length === 0 && (
                  <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                     {hasAny
                        ? "Nothing matches."
                        : refs.length === 0
                          ? resolved.checking
                             ? "Checking references..."
                             : "Links, PRs and code refs from this Session show here."
                          : `No ${meta.label === "Code" ? "code refs" : meta.label} in this Session.`}
                  </p>
               )}
               {asList ? (
                  <div className={cn(shown.length > 0 && "border-t pt-1")}>
                     {shown.map((r) => (
                        <ListRow
                           key={r.key}
                           r={r}
                           selected={r.key === selected}
                           onOpen={() => open(r)}
                        />
                     ))}
                  </div>
               ) : (
                  sections.map((s) => {
                     const isOpen = !folded.has(s.key);
                     const count = s.items.length + s.dirs.reduce((n, d) => n + d.items.length, 0);
                     return (
                        <div key={s.key}>
                           <SectionHeader
                              s={s}
                              kind={kind}
                              count={count}
                              open={isOpen}
                              onToggle={() => toggle(s.key)}
                           />
                           {isOpen &&
                              s.dirs.map((d) => {
                                 const k = `${s.key}/${d.label}`;
                                 const dirOpen = !folded.has(k);
                                 return (
                                    <div key={k}>
                                       <button
                                          type="button"
                                          aria-expanded={dirOpen}
                                          onClick={() => toggle(k)}
                                          className="flex h-6.5 w-full items-center gap-1.5 pr-2 pl-6 text-left font-mono text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                                       >
                                          <Chevron open={dirOpen} />
                                          <span className="truncate">{d.label}</span>
                                       </button>
                                       {dirOpen &&
                                          d.items.map((r) => (
                                             <GroupRow
                                                key={r.key}
                                                r={r}
                                                pad={38}
                                                selected={r.key === selected}
                                                onOpen={() => open(r)}
                                             />
                                          ))}
                                    </div>
                                 );
                              })}
                           {isOpen &&
                              s.items.map((r) => (
                                 <GroupRow
                                    key={r.key}
                                    r={r}
                                    pad={26}
                                    selected={r.key === selected}
                                    onOpen={() => open(r)}
                                 />
                              ))}
                        </div>
                     );
                  })
               )}
            </div>
         </ScrollArea>
      </div>
   );
}

function ViewButton({
   label,
   on,
   onClick,
   children,
}: {
   label: string;
   on: boolean;
   onClick: () => void;
   children: ReactNode;
}) {
   return (
      <Tooltip content={label}>
         <button
            type="button"
            aria-label={label}
            aria-pressed={on}
            onClick={onClick}
            className={cn(
               "grid h-6 w-7 place-items-center rounded text-muted-foreground hover:text-foreground [&_svg]:size-3.5",
               on && "bg-background text-foreground shadow-sm",
            )}
         >
            {children}
         </button>
      </Tooltip>
   );
}

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

function Inspect({
   r,
   position,
   onStep,
   onBack,
   onJump,
}: {
   r: Reference;
   position: { i: number; n: number } | null;
   onStep: (d: 1 | -1) => void;
   onBack: () => void;
   onJump: (rowId: string) => void;
}) {
   const reader = useFileRefs();
   const prRefs = usePrRefs();
   const [error, setError] = useState<string | null>(null);
   const title =
      r.kind === "pr" && prRefs
         ? displayRef({ repo: r.pr.repo, number: r.pr.number }, prRefs.ctx)
         : refLabel(r);
   const onKey = (e: KeyboardEvent) => {
      // A menu's keys are its own (its content is in a portal, but React events still come here).
      if ((e.target as Element).closest("[role=menu]")) return;
      if (e.key === "Escape" || e.key === "Backspace") {
         e.preventDefault();
         onBack();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
         e.preventDefault();
         onStep(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" && e.target === e.currentTarget) {
         e.preventDefault();
         const m = r.mentions[0];
         if (m) onJump(m.rowId);
      }
   };
   const openInEditor = (path: string, line?: number) => {
      setError(null);
      reader?.open(path, line).catch((err) => setError(String(err)));
   };
   return (
      <div
         className="flex min-h-0 flex-1 flex-col outline-none"
         aria-label={`Reference: ${title}`}
         tabIndex={-1}
         onKeyDown={onKey}
         ref={(el) => el?.focus({ preventScroll: true })}
      >
         <PanelHeader
            className="gap-1 pl-1.5"
            menu={
               r.kind === "pr" ? (
                  <>
                     <DropdownMenuItem onSelect={() => openExternalUrl(r.pr.url)}>
                        <ExternalLink /> Open on GitHub
                     </DropdownMenuItem>
                     <DropdownMenuItem
                        onSelect={() => copy(prKey({ repo: r.pr.repo, number: r.pr.number }))}
                     >
                        <Copy /> Copy ref
                     </DropdownMenuItem>
                  </>
               ) : r.kind === "code" ? (
                  <>
                     <DropdownMenuItem
                        onSelect={() => openInEditor(r.path, r.ranges[0]?.start ?? undefined)}
                     >
                        <SquareArrowOutUpRight /> Open in editor
                     </DropdownMenuItem>
                     <DropdownMenuItem onSelect={() => copy(r.path)}>
                        <Copy /> Copy path
                     </DropdownMenuItem>
                  </>
               ) : (
                  <>
                     <DropdownMenuItem onSelect={() => openExternalUrl(r.url)}>
                        <ExternalLink /> Open link
                     </DropdownMenuItem>
                     <DropdownMenuItem onSelect={() => copy(r.url)}>
                        <Copy /> Copy URL
                     </DropdownMenuItem>
                  </>
               )
            }
         >
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label="Back to all references"
               onClick={onBack}
            >
               <ChevronLeft />
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
            {position && (
               <span className="mr-0.5 text-xs text-muted-foreground">
                  {position.i + 1} of {position.n}
               </span>
            )}
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label="Previous reference"
               disabled={!position || position.i === 0}
               onClick={() => onStep(-1)}
            >
               <ChevronUp />
            </Button>
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label="Next reference"
               disabled={!position || position.i >= position.n - 1}
               onClick={() => onStep(1)}
            >
               <ChevronDown />
            </Button>
         </PanelHeader>
         {error && <p className="px-3.5 pt-2 text-xs text-destructive">{error}</p>}
         <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-2 p-3.5">
               {r.kind === "pr" && <PrDetail r={r} />}
               {r.kind === "code" && <CodeDetail key={r.key} r={r} reader={reader} />}
               {r.kind === "link" && (
                  <>
                     <div className="text-[14.5px] leading-snug font-semibold">{r.title}</div>
                     <div className="font-mono text-xs break-all text-muted-foreground">
                        {r.url}
                     </div>
                  </>
               )}
               <div className="mt-2.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {r.mentions.length === 1 ? "1 mention" : `${r.mentions.length} mentions`}
               </div>
               <div className="-mx-1.5 flex flex-col">
                  {r.mentions.map((m, i) => (
                     <MentionRow
                        // biome-ignore lint/suspicious/noArrayIndexKey: mentions of one target, a message can repeat it.
                        key={`${m.rowId}:${i}`}
                        m={m}
                        onJump={() => onJump(m.rowId)}
                     />
                  ))}
               </div>
            </div>
         </ScrollArea>
      </div>
   );
}

function PrDetail({ r }: { r: Extract<Reference, { kind: "pr" }> }) {
   const v = prStateVisual(r.pr.state, r.pr.checks);
   return (
      <>
         <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <v.Icon strokeWidth={2.2} className={cn("size-3.5 shrink-0", v.fg)} aria-hidden />
            <span className={cn("font-medium", v.fg)}>{v.label}</span>
            <span className="truncate">
               {r.pr.repo.owner}/{r.pr.repo.name}
            </span>
         </div>
         <div className="text-[14.5px] leading-snug font-semibold">{r.pr.title}</div>
         <div className="font-mono text-xs text-muted-foreground">
            +{r.pr.additions} −{r.pr.deletions}
         </div>
      </>
   );
}

function CodeDetail({
   r,
   reader,
}: {
   r: Extract<Reference, { kind: "code" }>;
   reader: FileReader | null;
}) {
   const [at, setAt] = useState(0);
   const bare: FileRef = { path: r.path, start: null, end: null };
   const ref = r.ranges[Math.min(at, r.ranges.length - 1)] ?? bare;
   return (
      <>
         <div className="font-mono text-xs break-all text-muted-foreground">{r.path}</div>
         {r.ranges.length > 1 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Line ranges">
               {r.ranges.map((x, i) => (
                  <button
                     key={lineLabel(x)}
                     type="button"
                     aria-pressed={i === at}
                     onClick={() => setAt(i)}
                     className={cn(
                        "h-5.5 rounded px-1.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground",
                        i === at && "bg-accent text-foreground",
                     )}
                  >
                     {lineLabel(x)}
                  </button>
               ))}
            </div>
         )}
         {r.inside && reader ? (
            <FilePreview reader={reader} fileRef={ref} />
         ) : (
            <p className="rounded-md border border-dashed px-2.5 py-2 text-xs text-foreground/80">
               {outsidePath(r.path)
                  ? "This path is outside the Session folder, so there is no preview."
                  : "No preview."}
            </p>
         )}
      </>
   );
}

function MentionRow({ m, onJump }: { m: Mention; onJump: () => void }) {
   const where = `${m.turn ? `Turn ${m.turn}` : "Start"} · ${m.who === "you" ? "You" : "Agent"}`;
   return (
      <button
         type="button"
         onClick={onJump}
         aria-label={`Jump to the mention: ${where}`}
         className="rounded-md px-1.5 py-1 text-left hover:bg-accent/60"
      >
         <span className="mb-0.5 flex justify-between gap-2 text-[11.5px] text-muted-foreground">
            <span>{where}</span>
            {m.range && <span className="font-mono">{m.range}</span>}
         </span>
         <span className="block text-[12.5px] leading-normal text-foreground/80">
            {m.before}
            <span className="rounded-[3px] bg-sky-500/25 px-0.5 text-foreground">{m.hit}</span>
            {m.after}
         </span>
      </button>
   );
}
