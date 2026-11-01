import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, ChartColumn, Check, ChevronDown, ChevronLeft, ChevronUp, Copy, LayoutDashboard, Search, Table2, Workflow, GitPullRequest } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, ScrollArea, cn } from "@harness/ui";
import { filterArtifacts, type Artifact, type ArtifactKind } from "./artifacts";
import { Markdown } from "./Markdown";
import { PanelHeader } from "./PanelHeader";
import { RenderUi, type UiEnv } from "./RenderUi";
import { fullMessageTime, useNow } from "./time";
import { uiIcons } from "./uiIcons";

/** Short age for a row: "now", "5m", "2h", "3d". */
function age(ts: number, now: number): string {
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

const PLACED: Record<string, string> = { top: "Top", bottom: "Bottom", left: "Left", right: "Right" };

/** The artifact itself, as the chat shows it, at panel width. */
function Preview({ a, env }: { a: Artifact; env: UiEnv }) {
  if (a.ui) return <RenderUi root={a.ui.root} env={{ ...env, files: a.ui.files }} />;
  return <Markdown>{a.kind === "diagram" ? `\`\`\`mermaid\n${a.source}\n\`\`\`` : a.source}</Markdown>;
}

/**
 * The Artifacts panel: every render_ui item, Mermaid diagram and table of the Session,
 * by Turn, filterable. A click opens one here (inspect); from there, or with Enter, it jumps to the chat.
 */
export function ArtifactsPanel({ artifacts, env, onJump }: {
  artifacts: Artifact[]; env: UiEnv; onJump: (a: Artifact) => void;
}) {
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const shown = useMemo(() => filterArtifacts(artifacts, kind, query).reverse(), [artifacts, kind, query]);
  const current = inspecting ? artifacts.find((a) => a.key === inspecting) ?? null : null;
  if (current) {
    const i = shown.findIndex((a) => a.key === current.key);
    return (
      <Inspect
        a={current}
        env={env}
        position={i < 0 ? null : { i, n: shown.length }}
        onStep={(d) => { const next = shown[i + d]; if (next) { setInspecting(next.key); setSelected(next.key); } }}
        onBack={() => setInspecting(null)}
        onJump={() => onJump(current)}
      />
    );
  }
  const counts = (k: ArtifactKind | "all") => filterArtifacts(artifacts, k, query).length;
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.key !== "ArrowDown" && e.key !== "Enter") return;
    const i = shown.findIndex((a) => a.key === selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
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
        <span className="hidden text-xs text-muted-foreground @[18rem]:inline">{artifacts.length}</span>
        <label className="ml-1 flex h-7.5 min-w-0 flex-1 items-center gap-1.5 rounded-md border pr-0.5 pl-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-3.5 shrink-0" />
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
                  <span className="ml-auto text-xs text-muted-foreground">{counts(k.kind)}</span>
                  <Check className={cn("size-3.5", kind !== k.kind && "invisible")} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </label>
      </PanelHeader>
      <ScrollArea className="min-h-0 flex-1"><div className="px-2 pb-2 outline-none" role="listbox" aria-label="Artifacts" tabIndex={0}>
        {shown.length === 0 && (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">
            {artifacts.length === 0 ? "Cards, diagrams and tables from this Session show here." : "Nothing matches."}
          </p>
        )}
        {groups.map((g) => (
          <div key={`${g.turn}:${g.items[0]!.key}`}>
            <div className="flex gap-1.5 px-1.5 pt-3 pb-1 text-[11px] text-muted-foreground">
              <span className="shrink-0 font-medium tracking-wide whitespace-nowrap uppercase">{g.turn ? `Turn ${g.turn}` : "Start"}</span>
              <span className="truncate">{g.prompt}</span>
            </div>
            {g.items.map((a) => (
              <Row key={a.key} a={a} selected={a.key === selected} onOpen={() => { setSelected(a.key); setInspecting(a.key); }} />
            ))}
          </div>
        ))}
      </div></ScrollArea>
    </div>
  );
}

function Row({ a, selected, onOpen }: { a: Artifact; selected: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow();
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      onClick={onOpen}
      className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 select-none hover:bg-accent/60", selected && "bg-accent ring-1 ring-border ring-inset hover:bg-accent")}
    >
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground/80 [&_svg]:size-4", selected && "bg-background")}>
        <KindIcon a={a} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{a.title}</span>
          {PLACED[a.placement] && <span className="shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground">{PLACED[a.placement]}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{a.sub}</div>
      </div>
      <span className="text-xs text-muted-foreground">{age(a.ts, now)}</span>
    </div>
  );
}

function Inspect({ a, env, position, onStep, onBack, onJump }: {
  a: Artifact; env: UiEnv; position: { i: number; n: number } | null;
  onStep: (d: 1 | -1) => void; onBack: () => void; onJump: () => void;
}) {
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Backspace") { e.preventDefault(); onBack(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); onStep(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Enter") { e.preventDefault(); onJump(); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col outline-none" aria-label={`Artifact: ${a.title}`} tabIndex={-1} onKeyDown={onKey} ref={(el) => el?.focus({ preventScroll: true })}>
      <PanelHeader className="gap-1 pl-1.5">
        <Button size="icon" variant="ghost" className="size-7" aria-label="Back to all artifacts" onClick={onBack}>
          <ChevronLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.title}</span>
        {position && <span className="mr-0.5 text-xs text-muted-foreground">{position.i + 1} of {position.n}</span>}
        <Button size="icon" variant="ghost" className="size-7" aria-label="Previous artifact" disabled={!position || position.i === 0} onClick={() => onStep(-1)}>
          <ChevronUp />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Next artifact" disabled={!position || position.i >= position.n - 1} onClick={() => onStep(1)}>
          <ChevronDown />
        </Button>
      </PanelHeader>
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <div className="inline-flex gap-0.5 rounded-md bg-muted p-0.5" role="tablist">
          {(["preview", "source"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("h-7 rounded px-3 text-[13px] font-medium text-muted-foreground capitalize", tab === t && "bg-background text-foreground shadow-sm")}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="truncate text-xs text-muted-foreground">{a.sub}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1"><div className="p-3.5">
        {tab === "preview" ? (
          <Preview a={a} env={env} />
        ) : (
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">{a.source}</pre>
        )}
        <dl className="mt-4 grid grid-cols-[88px_1fr] gap-y-1.5 px-0.5 text-[13px]">
          <dt className="text-muted-foreground">From</dt>
          <dd>{a.turn ? `Turn ${a.turn}` : "Start"} · {a.ui ? "render_ui" : "Agent message"}</dd>
          {a.prompt && (<><dt className="text-muted-foreground">Prompt</dt><dd className="line-clamp-3">{a.prompt}</dd></>)}
          <dt className="text-muted-foreground">Time</dt>
          <dd>{fullMessageTime(a.ts)}</dd>
          {a.placement !== "inline" && (<><dt className="text-muted-foreground">Placed</dt><dd>{PLACED[a.placement]}</dd></>)}
        </dl>
      </div></ScrollArea>
      <div className="flex gap-2 border-t px-3.5 py-2.5">
        <Button size="sm" onClick={onJump}>
          <ArrowRight /> {a.placement === "left" || a.placement === "right" ? "Open panel" : a.placement === "inline" ? "Jump to message" : "Show"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard.writeText(a.source).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
        >
          <Copy /> {copied ? "Copied" : "Copy source"}
        </Button>
      </div>
    </div>
  );
}
