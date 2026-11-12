import type { SharedArtifactEntry, SharedArtifactMeta } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
   Popover,
   PopoverContent,
   PopoverTrigger,
   ScrollArea,
   Tooltip,
} from "@harness/ui";
import {
   ArrowRight,
   ChartColumn,
   Check,
   ChevronDown,
   ChevronLeft,
   ChevronUp,
   ExternalLink,
   GitPullRequest,
   LayoutDashboard,
   MoreHorizontal,
   Plus,
   Search,
   Share2,
   Table2,
   Unlink,
   Workflow,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArtifactImage, ArtifactPreview, artifactFormats } from "./ArtifactExport";
import {
   type Artifact,
   type ArtifactKind,
   artifactSource,
   filterArtifacts,
   groupShared,
   type SharedRow,
} from "./artifacts";
import { useCapture } from "./Capture";
import { CopyButton, Frame, useWrapCode, WRAP, WrapButton } from "./CodeBlock";
import { ExportSubmenu, useExport } from "./ExportMenu";
import { fileName, sharedFormats } from "./exportFormats";
import { Highlighted } from "./highlight";
import { PanelHeader } from "./PanelHeader";
import type { UiEnv } from "./RenderUi";
import { parseTree, sharedSourceText, useSharedArtifact } from "./renderUi/sharedSource";
import { Segmented } from "./Segmented";
import { quotableAttrs } from "./SelectionComment";
import { fullMessageTime, useNow } from "./time";
import { sharedNode } from "./tools";
import { uiIcons } from "./uiIcons";

/** Short age for a row: "now", "5m", "2h", "3d". */
export function age(ts: number, now: number): string {
   const m = Math.floor((now - ts) / 60_000);
   if (m < 1) return "now";
   if (m < 60) return `${m}m`;
   if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
   return `${Math.floor(m / (24 * 60))}d`;
}

const KINDS: { kind: ArtifactKind | "all"; label: string }[] = [
   { kind: "all", label: "All" },
   { kind: "ui", label: "UI" },
   { kind: "diagram", label: "Diagrams" },
   { kind: "table", label: "Tables" },
];

function KindIcon({ a }: { a: Artifact }) {
   const Custom = a.icon ? uiIcons[a.icon as keyof typeof uiIcons] : undefined;
   if (Custom) return <Custom />;
   if (a.kind === "diagram") return <Workflow />;
   if (a.kind === "table") return <Table2 />;
   if (a.ui?.root.type === "PullRequest") return <GitPullRequest />;
   if (a.ui?.root.type === "Chart") return <ChartColumn />;
   return <LayoutDashboard />;
}

const PLACED: Record<string, string> = {
   top: "Top",
   bottom: "Bottom",
   left: "Left",
   right: "Right",
};

/** The artifact's source, highlighted, with wrap and copy. */
function Source({ a, src }: { a: Artifact; src?: { lang: string; text: string } }) {
   const wrap = useWrapCode();
   const { lang, text } = src ?? artifactSource(a);
   return (
      <Frame
         label={lang}
         action={
            <>
               <WrapButton />
               <CopyButton text={text} />
            </>
         }
      >
         <pre
            className={cn(
               "code-colors m-0 overflow-x-auto p-3 font-mono text-code leading-relaxed",
               wrap && WRAP,
            )}
         >
            <code>
               <Highlighted lang={lang} text={text} />
            </code>
         </pre>
      </Frame>
   );
}

/**
 * The Artifacts panel: every render_ui item, Mermaid diagram and table of the Session,
 * by Turn, filterable. A click opens one here (inspect); from there, or with Enter, it jumps to the chat.
 */
export function ArtifactsPanel({
   artifacts: all,
   env,
   onJump,
   shared,
}: {
   artifacts: Artifact[];
   env: UiEnv;
   onJump: (a: Artifact) => void;
   /** Shared Artifacts (ADR 0024): absent, the panel shows only the Session's own. */
   shared?: SharedActions;
}) {
   const [kind, setKind] = useState<ArtifactKind | "all">("all");
   const [query, setQuery] = useState("");
   const [selected, setSelected] = useState<string | null>(null);
   const [inspecting, setInspecting] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);
   const groupsOf = useMemo(
      () => groupShared(all, shared?.attached ?? [], shared?.copies),
      [all, shared?.attached, shared?.copies],
   );
   const artifacts = groupsOf.local;
   const shown = useMemo(
      () => filterArtifacts(artifacts, kind, query).reverse(),
      [artifacts, kind, query],
   );
   const metas = shared?.metas;
   const sharedShown = useMemo(() => {
      if (kind !== "all" && kind !== "ui") return [];
      const q = query.trim().toLowerCase();
      return groupsOf.shared.filter(
         (r) => !q || sharedTitle(r, metas?.get(r.id)).toLowerCase().includes(q),
      );
   }, [groupsOf.shared, kind, query, metas]);
   const act = (f: () => Promise<unknown>) => {
      setError(null);
      f().catch((e) => setError(e instanceof Error ? e.message : String(e)));
   };
   const sharedOpen = inspecting
      ? groupsOf.shared.find((r) => `shared:${r.id}` === inspecting)
      : null;
   if (sharedOpen && shared) {
      const meta = metas?.get(sharedOpen.id);
      return (
         <Inspect
            a={sharedArtifact(sharedOpen, meta)}
            env={env}
            position={null}
            onStep={() => {}}
            onBack={() => setInspecting(null)}
            onJump={() => shared.open(sharedOpen.id)}
            madeIn={meta?.created_by.session_title}
         />
      );
   }
   const current = inspecting ? (artifacts.find((a) => a.key === inspecting) ?? null) : null;
   if (current) {
      const i = shown.findIndex((a) => a.key === current.key);
      return (
         <Inspect
            a={current}
            env={env}
            position={i < 0 ? null : { i, n: shown.length }}
            onStep={(d) => {
               const next = shown[i + d];
               if (next) {
                  setInspecting(next.key);
                  setSelected(next.key);
               }
            }}
            onBack={() => setInspecting(null)}
            onJump={() => onJump(current)}
         />
      );
   }
   const counts = (k: ArtifactKind | "all") => filterArtifacts(artifacts, k, query).length;
   const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.key !== "ArrowDown" && e.key !== "Enter")
         return;
      const i = shown.findIndex((a) => a.key === selected);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
         e.preventDefault();
         const next =
            shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
         if (next) setSelected(next.key);
      } else if (e.key === "Enter" && shown[i]) {
         e.preventDefault();
         onJump(shown[i]);
      } else if (e.key === " " && shown[i]) {
         e.preventDefault();
         setInspecting(shown[i].key);
      }
   };
   // Rows by Turn, newest first.
   const groups: { turn: number; prompt: string; items: Artifact[] }[] = [];
   for (const a of shown) {
      const g = groups.at(-1);
      if (g?.turn === a.turn) g.items.push(a);
      else groups.push({ turn: a.turn, prompt: a.prompt, items: [a] });
   }
   return (
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
         <PanelHeader title="Artifacts" className="@container gap-1.5">
            <span className="hidden text-xs text-muted-foreground @[18rem]:inline">
               {artifacts.length + groupsOf.shared.length}
            </span>
            <label className="ml-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
               <Search className="size-3 shrink-0" />
               <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter"
                  aria-label="Filter artifacts"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
               />
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <button
                        aria-label={`Kind: ${KINDS.find((k) => k.kind === kind)!.label}`}
                        className={cn(
                           "inline-flex h-5.5 shrink-0 items-center gap-0.5 rounded pr-0.5 pl-1.5 text-xs whitespace-nowrap hover:text-foreground data-[state=open]:bg-accent",
                           kind !== "all" && "bg-accent font-medium text-foreground",
                        )}
                     >
                        {KINDS.find((k) => k.kind === kind)!.label}
                        <ChevronDown className="size-3.5" />
                     </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                     {KINDS.map((k) => (
                        <DropdownMenuItem key={k.kind} onSelect={() => setKind(k.kind)}>
                           {k.label}
                           <span className="ml-auto text-xs text-muted-foreground">
                              {counts(k.kind)}
                           </span>
                           <Check className={cn("size-3.5", kind !== k.kind && "invisible")} />
                        </DropdownMenuItem>
                     ))}
                  </DropdownMenuContent>
               </DropdownMenu>
            </label>
            {shared && (
               <AttachPicker
                  attached={shared.attached}
                  search={shared.search}
                  onPick={(id) => act(() => shared.attach(id))}
               />
            )}
         </PanelHeader>
         {error && <p className="px-3.5 pt-2 text-xs text-destructive">{error}</p>}
         <ScrollArea className="min-h-0 flex-1">
            <div
               className="px-2 pb-2 outline-none"
               role="listbox"
               aria-label="Artifacts"
               tabIndex={0}
            >
               {shared && sharedShown.length > 0 && (
                  <div>
                     <div className="flex gap-1.5 px-1.5 pt-3 pb-1 text-[11px] text-muted-foreground">
                        <span className="shrink-0 font-medium tracking-wide whitespace-nowrap uppercase">
                           Shared
                        </span>
                        <span className="truncate">attached</span>
                     </div>
                     {sharedShown.map((r) => (
                        <SharedRowView
                           key={r.id}
                           row={r}
                           meta={metas?.get(r.id)}
                           onInspect={() => setInspecting(`shared:${r.id}`)}
                           onOpen={() => shared.open(r.id)}
                           onDetach={() => act(() => shared.detach(r.id))}
                           onOpenOutside={
                              shared.openOutside ? () => shared.openOutside!(r.id) : undefined
                           }
                        />
                     ))}
                  </div>
               )}
               {shown.length === 0 && sharedShown.length === 0 && (
                  <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                     {artifacts.length === 0 && groupsOf.shared.length === 0
                        ? "Cards, diagrams and tables from this Session show here."
                        : "Nothing matches."}
                  </p>
               )}
               {groups.map((g) => (
                  <div key={`${g.turn}:${g.items[0]!.key}`}>
                     <div className="flex gap-1.5 px-1.5 pt-3 pb-1 text-[11px] text-muted-foreground">
                        <span className="shrink-0 font-medium tracking-wide whitespace-nowrap uppercase">
                           {g.turn ? `Turn ${g.turn}` : "Start"}
                        </span>
                        <span className="truncate">{g.prompt}</span>
                     </div>
                     {g.items.map((a) => (
                        <Row
                           key={a.key}
                           a={a}
                           selected={a.key === selected}
                           onOpen={() => {
                              setSelected(a.key);
                              setInspecting(a.key);
                           }}
                           onShare={
                              shared && canShare(a) ? () => act(() => shared.share(a)) : undefined
                           }
                        />
                     ))}
                  </div>
               ))}
            </div>
         </ScrollArea>
      </div>
   );
}

/** A row's menu button: shows on hover, while selected or while its menu is open. */
function RowMenu({ label, children }: { label: string; children: React.ReactNode }) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button
               size="icon"
               variant="ghost"
               className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100"
               aria-label={label}
               onClick={(e) => e.stopPropagation()}
            >
               <MoreHorizontal />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end" className="w-48" onClick={(e) => e.stopPropagation()}>
            {children}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}

function Row({
   a,
   selected,
   onOpen,
   onShare,
}: {
   a: Artifact;
   selected: boolean;
   onOpen: () => void;
   /** Offers "Make shared" (ADR 0024). */
   onShare?: () => void;
}) {
   const ref = useRef<HTMLDivElement>(null);
   const now = useNow();
   useEffect(() => {
      if (selected) ref.current?.scrollIntoView({ block: "nearest" });
   }, [selected]);
   return (
      <div
         ref={ref}
         role="option"
         aria-selected={selected}
         onClick={onOpen}
         className={cn(
            "group/row flex items-center gap-2.5 rounded-lg px-2.5 py-2 select-none hover:bg-accent/60",
            selected && "bg-accent ring-1 ring-border ring-inset hover:bg-accent",
         )}
      >
         <span
            className={cn(
               "grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground/80 [&_svg]:size-4",
               selected && "bg-background",
            )}
         >
            <KindIcon a={a} />
         </span>
         <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
               <span className="truncate text-[13px] font-medium">{a.title}</span>
               {PLACED[a.placement] && (
                  <span className="shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground">
                     {PLACED[a.placement]}
                  </span>
               )}
            </div>
            <div className="truncate text-xs text-muted-foreground">{a.sub}</div>
         </div>
         <span className="text-xs text-muted-foreground">{age(a.ts, now)}</span>
         {onShare && (
            <RowMenu label={`${a.title} options`}>
               <DropdownMenuItem onSelect={onShare}>
                  <Share2 /> Make shared
               </DropdownMenuItem>
            </RowMenu>
         )}
      </div>
   );
}

/** What the Artifacts panel can do with Shared Artifacts (ADR 0024); the View wires it to the Session. */
export type SharedActions = {
   /** Attached to this Session, in attach order. */
   attached: readonly { id: string; ts: number }[];
   /** Meta of every Shared Artifact by id (titles, "N sessions"); missing while loading. */
   metas: ReadonlyMap<string, SharedArtifactMeta>;
   /** Message blocks this Session shared (artifact key -> Shared Artifact id): listed once, as shared. */
   copies?: ReadonlyMap<string, string>;
   /** The attach picker's list: all, or matches of `query`. */
   search: (query: string) => Promise<SharedArtifactEntry[]>;
   share: (a: Artifact) => Promise<unknown>;
   attach: (id: string) => Promise<unknown>;
   detach: (id: string) => Promise<unknown>;
   /** Shows the artifact's panel. */
   open: (id: string) => void;
   /** Opens it without a Session (the host app); absent, the menu has no such entry. */
   openOutside?: (id: string) => void;
};

/** A render_ui item with an id, a diagram or a table can be made shared. */
const canShare = (a: Artifact) => a.kind !== "ui" || !!a.slotId;

const KIND_LABEL: Record<SharedArtifactMeta["kind"], string> = {
   md: "Markdown",
   html: "HTML",
   ui: "UI",
};

function sharedTitle(r: SharedRow, meta: SharedArtifactMeta | undefined): string {
   return meta?.title ?? r.artifact?.title ?? r.id;
}

/**
 * An attached Shared Artifact as an Artifact for the detail page: it previews through the `Shared`
 * node (the artifact's own state); its source and downloads come from a read (see `Inspect`).
 */
function sharedArtifact(r: SharedRow, meta: SharedArtifactMeta | undefined): Artifact {
   return {
      key: `shared:${r.id}`,
      kind: "ui",
      title: sharedTitle(r, meta),
      sub: meta ? `${KIND_LABEL[meta.kind]} · ${sessionCount(meta)}` : "Shared artifact",
      rowId: null,
      index: null,
      placement: r.artifact?.placement ?? "right",
      slotId: r.artifact?.slotId ?? null,
      ts: meta?.updated_ms ?? r.ts,
      turn: r.artifact?.turn ?? 0,
      prompt: r.artifact?.prompt ?? "",
      source: "",
      ui: { root: sharedNode(r.id), files: {} },
      shared: { id: r.id },
   };
}

/** "Attached in 2 Sessions"-style count. */
export const sessionCount = (meta: SharedArtifactMeta | undefined) => {
   const n = meta?.attached?.length ?? 0;
   return `${n} ${n === 1 ? "session" : "sessions"}`;
};

function SharedRowView({
   row,
   meta,
   onInspect,
   onOpen,
   onDetach,
   onOpenOutside,
}: {
   row: SharedRow;
   meta: SharedArtifactMeta | undefined;
   /** A click: its detail page (preview, image, source). */
   onInspect: () => void;
   onOpen: () => void;
   onDetach: () => void;
   onOpenOutside?: () => void;
}) {
   const now = useNow();
   const title = sharedTitle(row, meta);
   return (
      <div
         role="option"
         aria-selected={false}
         onClick={onInspect}
         className="group/row flex items-center gap-2.5 rounded-lg px-2.5 py-2 select-none hover:bg-accent/60"
      >
         <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground/80 [&_svg]:size-4">
            <Share2 />
         </span>
         <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
               <span className="truncate text-[13px] font-medium">{title}</span>
               <span className="shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground">
                  Shared
               </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
               {meta ? `${KIND_LABEL[meta.kind]} · ${sessionCount(meta)}` : "Shared artifact"}
            </div>
         </div>
         <span className="text-xs text-muted-foreground">
            {age(meta?.updated_ms ?? row.ts, now)}
         </span>
         <RowMenu label={`${title} options`}>
            <DropdownMenuItem onSelect={onOpen}>
               <ArrowRight /> Open panel
            </DropdownMenuItem>
            {onOpenOutside && (
               <DropdownMenuItem onSelect={onOpenOutside}>
                  <ExternalLink /> Open outside Session
               </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onDetach}>
               <Unlink /> Detach
            </DropdownMenuItem>
         </RowMenu>
      </div>
   );
}

/** The header's "+": a searchable list of Shared Artifacts to attach to this Session. */
function AttachPicker({
   attached,
   search,
   onPick,
}: {
   attached: readonly { id: string }[];
   search: (query: string) => Promise<SharedArtifactEntry[]>;
   onPick: (id: string) => void;
}) {
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState("");
   const [list, setList] = useState<SharedArtifactEntry[] | null>(null);
   const [active, setActive] = useState(0);
   useEffect(() => {
      if (!open) return;
      let live = true;
      const t = setTimeout(
         () =>
            search(query).then(
               (l) => live && (setList(l), setActive(0)),
               () => live && setList([]),
            ),
         query ? 150 : 0,
      );
      return () => {
         live = false;
         clearTimeout(t);
      };
   }, [open, query, search]);
   const now = useNow();
   const isAttached = (id: string) => attached.some((a) => a.id === id);
   const items = list ?? [];
   const pick = (e: SharedArtifactEntry | undefined) => {
      if (!e || isAttached(e.meta.id)) return;
      onPick(e.meta.id);
      setOpen(false);
      setQuery("");
   };
   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Tooltip content="Attach shared…" side="bottom">
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 data-[state=open]:bg-accent"
                  aria-label="Attach shared artifact"
               >
                  <Plus />
               </Button>
            </Tooltip>
         </PopoverTrigger>
         <PopoverContent
            align="end"
            className="w-80 p-0"
            // React events bubble through the portal: keep the panel header from starting a drag.
            onPointerDown={(e) => e.stopPropagation()}
         >
            <label className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-muted-foreground">
               <Search className="size-3.5 shrink-0" />
               <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                     if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const d = e.key === "ArrowDown" ? 1 : -1;
                        setActive((i) => Math.max(0, Math.min(items.length - 1, i + d)));
                     } else if (e.key === "Enter") {
                        e.preventDefault();
                        pick(items[active]);
                     }
                  }}
                  placeholder="Attach shared…"
                  aria-label="Search shared artifacts"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
               />
            </label>
            <ScrollArea
               className="max-h-[min(20rem,calc(var(--radix-popover-content-available-height)-2.5rem))]"
               viewportClassName="max-h-[inherit]"
            >
               <div className="p-1" role="listbox" aria-label="Shared artifacts">
                  {list && items.length === 0 && (
                     <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {query ? "Nothing matches." : "No shared artifacts yet."}
                     </p>
                  )}
                  {items.map((e, i) => {
                     const on = isAttached(e.meta.id);
                     return (
                        <div
                           key={e.meta.id}
                           role="option"
                           aria-selected={i === active}
                           aria-disabled={on}
                           onMouseEnter={() => setActive(i)}
                           onClick={() => pick(e)}
                           className={cn(
                              "flex items-center gap-2.5 rounded-md px-2 py-1.5 select-none",
                              i === active && "bg-accent",
                              on && "opacity-60",
                           )}
                        >
                           <Share2 className="size-3.5 shrink-0 text-muted-foreground" />
                           <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] font-medium">{e.meta.title}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                 {e.snippet ??
                                    `${KIND_LABEL[e.meta.kind]} · ${sessionCount(e.meta)}`}
                              </div>
                           </div>
                           {on ? (
                              <Check className="size-3.5 shrink-0 text-muted-foreground" />
                           ) : (
                              <span className="text-xs text-muted-foreground">
                                 {age(e.meta.updated_ms, now)}
                              </span>
                           )}
                        </div>
                     );
                  })}
               </div>
            </ScrollArea>
         </PopoverContent>
      </Popover>
   );
}

function Inspect({
   a,
   env,
   position,
   onStep,
   onBack,
   onJump,
   madeIn,
}: {
   a: Artifact;
   env: UiEnv;
   position: { i: number; n: number } | null;
   onStep: (d: 1 | -1) => void;
   onBack: () => void;
   onJump: () => void;
   /** A Shared Artifact's: the title of the Session that shared it. */
   madeIn?: string;
}) {
   const [tab, setTab] = useState<"preview" | "image" | "source">("preview");
   // A Shared Artifact's content, for its source, downloads and picture key (the preview reads it too).
   const sharedId = a.shared && a.key === `shared:${a.shared.id}` ? a.shared.id : null;
   const read = useSharedArtifact(
      sharedId ?? "",
      sharedId ? env.readShared : undefined,
      env.watchShared,
   );
   const data = sharedId && read && "data" in read ? read.data : null;
   const src = useMemo(() => (data ? sharedSourceText(data) : undefined), [data]);
   const shown = useMemo(() => (data ? { ...a, source: data.content } : a), [a, data]);
   const formats = (shoot: Parameters<typeof artifactFormats>[2]) => {
      if (!sharedId) return artifactFormats(a, env, shoot);
      const [png] = artifactFormats(shown, env, shoot);
      if (!data) return png ? [png] : [];
      const tree = data.meta.kind === "ui" ? parseTree(data.content) : null;
      const root = tree && "root" in tree ? tree.root : null;
      return [
         ...(png ? [png] : []),
         ...sharedFormats(fileName(a.title), data.meta.kind, data.content, root),
      ];
   };
   const { stage, shoot } = useCapture();
   const { busy, error, save } = useExport();
   const onKey = (e: KeyboardEvent) => {
      // A menu's keys are its own (its content is in a portal, but React events still come here).
      if ((e.target as Element).closest("[role=menu]")) return;
      if (e.key === "Escape" || e.key === "Backspace") {
         e.preventDefault();
         onBack();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
         e.preventDefault();
         onStep(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
         e.preventDefault();
         onJump();
      }
   };
   return (
      <div
         className="flex min-h-0 flex-1 flex-col outline-none"
         aria-label={`Artifact: ${a.title}`}
         tabIndex={-1}
         onKeyDown={onKey}
         ref={(el) => el?.focus({ preventScroll: true })}
      >
         <PanelHeader
            className="gap-1 pl-1.5"
            menu={
               <>
                  <DropdownMenuItem onSelect={onJump}>
                     <ArrowRight />{" "}
                     {a.placement === "left" || a.placement === "right"
                        ? "Open panel"
                        : a.placement === "inline"
                          ? "Jump to message"
                          : "Show"}
                  </DropdownMenuItem>
                  <ExportSubmenu formats={formats(shoot)} save={save} />
               </>
            }
         >
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label="Back to all artifacts"
               onClick={onBack}
            >
               <ChevronLeft />
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.title}</span>
            {position && (
               <span className="mr-0.5 text-xs text-muted-foreground">
                  {position.i + 1} of {position.n}
               </span>
            )}
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label="Previous artifact"
               disabled={!position || position.i === 0}
               onClick={() => onStep(-1)}
            >
               <ChevronUp />
            </Button>
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label="Next artifact"
               disabled={!position || position.i >= position.n - 1}
               onClick={() => onStep(1)}
            >
               <ChevronDown />
            </Button>
         </PanelHeader>
         <div className="flex items-center gap-2 px-3.5 pt-3">
            <Segmented
               value={tab}
               onChange={setTab}
               items={[
                  { value: "preview", label: "Preview" },
                  { value: "image", label: "Image" },
                  { value: "source", label: "Source" },
               ]}
            />
            <div className="flex-1" />
            <span className="truncate text-xs text-muted-foreground">{a.sub}</span>
         </div>
         {(busy || error) && (
            <p
               className={cn(
                  "px-3.5 pt-2 text-xs text-muted-foreground",
                  error && "text-destructive",
               )}
            >
               {error ?? "Preparing the download..."}
            </p>
         )}
         <ScrollArea className="min-h-0 flex-1">
            <div className="p-3.5">
               {tab === "preview" && (
                  <div {...quotableAttrs(null, false, { source: "artifact", label: a.title })}>
                     <ArtifactPreview a={a} env={env} />
                  </div>
               )}
               {tab === "image" && <ArtifactImage a={shown} env={env} shoot={shoot} />}
               {tab === "source" &&
                  (sharedId && !src ? (
                     <div className="h-16 animate-pulse rounded bg-muted" />
                  ) : (
                     <Source a={a} src={src} />
                  ))}
               <dl className="mt-4 grid grid-cols-[88px_1fr] gap-y-1.5 px-0.5 text-[13px]">
                  <dt className="text-muted-foreground">From</dt>
                  <dd>
                     {sharedId
                        ? `Shared${madeIn ? ` · made in ${madeIn}` : ""}`
                        : `${a.turn ? `Turn ${a.turn}` : "Start"} · ${a.ui ? "render_ui" : "Agent message"}`}
                  </dd>
                  {a.prompt && (
                     <>
                        <dt className="text-muted-foreground">Prompt</dt>
                        <dd className="line-clamp-3">{a.prompt}</dd>
                     </>
                  )}
                  <dt className="text-muted-foreground">{sharedId ? "Updated" : "Time"}</dt>
                  <dd>{fullMessageTime(a.ts)}</dd>
                  {a.placement !== "inline" && (
                     <>
                        <dt className="text-muted-foreground">Placed</dt>
                        <dd>{PLACED[a.placement]}</dd>
                     </>
                  )}
               </dl>
            </div>
         </ScrollArea>
         {stage}
      </div>
   );
}
