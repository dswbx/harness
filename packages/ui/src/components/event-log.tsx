import * as React from "react";
import { ArrowDownToLine, ChevronRight, ListFilter, Search } from "lucide-react";
import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { ScrollArea } from "./scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Tooltip } from "./tooltip";
import { VirtualList } from "./virtual-list";

/** The Event fields the log shows; structural, so `@harness/ui` needs no `@harness/api`. */
export type LogEvent = { seq: number; ts_ms: number; thread_id?: string | null; kind: { type: string } };

/** Dot colors for families, picked by name so a family keeps its color as the log grows. */
const DOTS = ["bg-sky-400", "bg-amber-400", "bg-pink-400", "bg-violet-400", "bg-emerald-400", "bg-red-500", "bg-zinc-400"];
const dotFor = (name: string) => DOTS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % DOTS.length]!;

/** "1,204" up to 9,999, then "12.3k". */
function compact(n: number): string {
  return n < 10_000 ? n.toLocaleString("en-US") : `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
}

/** "session" for the main Session, else the thread id's tail. */
const threadName = (id: string | null | undefined) => (id ? id.slice(-6) : "session");

/**
 * Raw Session Log viewer on one header line: title, count, search over the JSON, a filter popover
 * (kinds by `family`, multi-select; thread), autoscroll; rows open to the full Event. Narrow
 * containers drop the time and thread columns. `actions`: header buttons; `header` puts the controls
 * in the host's own header row instead (with `title={null}`).
 */
export function EventLog({ events, title = "Session Log", actions, header, family = () => "Events", className }: {
  events: readonly LogEvent[];
  title?: React.ReactNode | null;
  actions?: React.ReactNode;
  header?: (controls: React.ReactNode) => React.ReactNode;
  /** Groups kinds in the filter (e.g. `eventFamily` from `@harness/api`). */
  family?: (type: string) => string;
  className?: string;
}) {
  const [kinds, setKinds] = React.useState<ReadonlySet<string>>(new Set());
  const [thread, setThread] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [auto, setAuto] = React.useState(true);
  const [openSeqs, setOpenSeqs] = React.useState<ReadonlySet<number>>(new Set());
  const toggle = React.useCallback(
    (seq: number) => setOpenSeqs((s) => { const n = new Set(s); if (!n.delete(seq)) n.add(seq); return n; }),
    [],
  );

  const threads = React.useMemo(() => [...new Set(events.map((e) => threadName(e.thread_id)))], [events]);
  const q = React.useDeferredValue(query.trim().toLowerCase());
  // Counts in the filter follow thread and search, not the kind selection itself.
  const scoped = React.useMemo(() => {
    const byThread = thread ? events.filter((e) => threadName(e.thread_id) === thread) : events;
    return q ? byThread.filter((e) => JSON.stringify(e).toLowerCase().includes(q)) : byThread;
  }, [events, thread, q]);
  const groups = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.kind.type, 0);
    for (const e of scoped) counts.set(e.kind.type, counts.get(e.kind.type)! + 1);
    const byFamily = new Map<string, { kind: string; n: number }[]>();
    for (const [kind, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      const f = family(kind);
      byFamily.set(f, [...(byFamily.get(f) ?? []), { kind, n }]);
    }
    return [...byFamily].sort(([a], [b]) => a.localeCompare(b)).map(([name, ks]) => ({ name, kinds: ks, n: ks.reduce((s, k) => s + k.n, 0), dot: dotFor(name) }));
  }, [events, scoped, family]);
  const dotOf = React.useMemo(() => new Map(groups.flatMap((g) => g.kinds.map((k) => [k.kind, g.dot] as const))), [groups]);
  const shown = React.useMemo(() => (kinds.size ? scoped.filter((e) => kinds.has(e.kind.type)) : scoped), [scoped, kinds]);

  const active = [
    ...groups.flatMap((g) => {
      const on = g.kinds.filter((k) => kinds.has(k.kind));
      return on.length === 0 ? [] : [on.length === g.kinds.length ? g.name : on.map((k) => k.kind).join(", ")];
    }),
    ...(thread ? [`thread ${thread}`] : []),
  ];
  const setMany = (ks: string[], on: boolean) => setKinds((s) => { const n = new Set(s); for (const k of ks) on ? n.add(k) : n.delete(k); return n; });

  const controls = (
    <>
        {title !== null && <span className="shrink-0 text-sm font-medium">{title}</span>}
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {shown.length === events.length ? compact(events.length) : `${compact(shown.length)}/${compact(events.length)}`}
        </span>
        {/* Right-aligned at a fixed width, so a changing count never moves the search or the buttons. */}
        <div className="ml-auto flex min-w-0 flex-1 justify-end pl-1">
          <label className="flex h-7.5 w-full max-w-60 min-w-0 items-center gap-1.5 rounded-md border px-2 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
            <Search className="size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search events"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        <Popover>
          <Tooltip content={active.length ? active.join(" · ") : "Filter"} side="bottom">
            <PopoverTrigger
              aria-label={active.length ? `Filters, ${active.length} active` : "Filter"}
              className={cn(
                "relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent [&_svg]:size-4",
                active.length > 0 && "bg-accent text-accent-foreground",
              )}
            >
              <ListFilter />
              {active.length > 0 && (
                <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{active.length}</span>
              )}
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent align="end" className="w-64 p-0 text-[13px]">
            <ScrollArea className="max-h-[min(32rem,var(--radix-popover-content-available-height))]" viewportClassName="max-h-[inherit] p-1">
              <div className="flex items-center justify-between px-2 pt-1 pb-1">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">KIND</span>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                  disabled={!active.length}
                  onClick={() => { setKinds(new Set()); setThread(null); }}
                >
                  Clear all
                </button>
              </div>
              {groups.map((g) => <Family key={g.name} g={g} kinds={kinds} setMany={setMany} />)}
              {threads.length > 1 && (
                <>
                  <div className="my-1 h-px bg-border" />
                  <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
                    <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">THREAD</span>
                    {/* Select items need a value: "all" stands for no thread filter (thread names are 6-char ids or "session"). */}
                    <Select value={thread ?? "all"} onValueChange={(v) => setThread(v === "all" ? null : v)}>
                      <SelectTrigger className="h-7 min-w-0 flex-1 font-mono text-xs" aria-label="Thread"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" className="font-mono text-xs">All</SelectItem>
                        {threads.map((t) => <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </ScrollArea>
          </PopoverContent>
        </Popover>
        <Tooltip content={auto ? "Autoscroll on" : "Autoscroll off"} side="bottom">
          <button
            aria-label="Autoscroll"
            aria-pressed={auto}
            onClick={() => setAuto((a) => !a)}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground [&_svg]:size-4",
              auto && "text-foreground",
            )}
          >
            <ArrowDownToLine />
          </button>
        </Tooltip>
        {actions}
    </>
  );
  return (
    <div className={cn("@container flex h-full min-h-0 flex-col", className)}>
      {header ? header(controls) : <div className="flex shrink-0 items-center gap-1.5 border-b py-2 pr-2 pl-3">{controls}</div>}
      <VirtualList
        count={shown.length}
        getKey={(i) => shown[i]!.seq}
        estimateSize={28}
        paddingStart={0}
        stickToBottom={auto}
        className="font-mono text-xs"
        empty={<p className="py-8 text-center text-muted-foreground">{events.length ? "No matching events." : "No events yet."}</p>}
        renderRow={(i) => <Row e={shown[i]!} dot={dotOf.get(shown[i]!.kind.type)} open={openSeqs.has(shown[i]!.seq)} onToggle={toggle} />}
      />
    </div>
  );
}

/** A family in the filter: its checkbox selects all its kinds; expand it for single kinds. */
function Family({ g, kinds, setMany }: {
  g: { name: string; kinds: { kind: string; n: number }[]; n: number; dot: string };
  kinds: ReadonlySet<string>;
  setMany: (ks: string[], on: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const on = g.kinds.filter((k) => kinds.has(k.kind)).length;
  const all = on === g.kinds.length;
  return (
    <div>
      <div className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-accent">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          aria-label={g.name}
          checked={all}
          ref={(el) => { if (el) el.indeterminate = on > 0 && !all; }}
          onChange={() => setMany(g.kinds.map((k) => k.kind), !all)}
        />
        <span className={cn("size-2 shrink-0 rounded-full", g.dot)} />
        <button className="flex min-w-0 flex-1 items-center gap-1 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="truncate">{g.name}</span>
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{g.n}</span>
        </button>
      </div>
      {open && g.kinds.map((k) => (
        <label key={k.kind} className="flex h-6 items-center gap-2 rounded-md pr-2 pl-7 font-mono text-[11.5px] hover:bg-accent">
          <input type="checkbox" className="size-3 accent-primary" checked={kinds.has(k.kind)} onChange={(e) => setMany([k.kind], e.target.checked)} />
          <span className="min-w-0 flex-1 truncate">{k.kind}</span>
          <span className="text-muted-foreground tabular-nums">{k.n}</span>
        </label>
      ))}
    </div>
  );
}

const Row = React.memo(function Row({ e, dot, open, onToggle }: { e: LogEvent; dot?: string; open: boolean; onToggle: (seq: number) => void }) {
  const preview = JSON.stringify(e.kind, (k, v) => (k === "type" ? undefined : v));
  return (
    <div className="border-b border-border/50 px-3 py-1 hover:bg-accent/40">
      <button className="flex w-full items-baseline gap-3 text-left" onClick={() => onToggle(e.seq)}>
        <ChevronRight className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")} />
        <span className="w-10 shrink-0 text-right text-muted-foreground">{e.seq}</span>
        <span className="hidden w-24 shrink-0 text-muted-foreground @xl:inline">{new Date(e.ts_ms).toISOString().slice(11, 23)}</span>
        <span className="hidden w-16 shrink-0 truncate text-muted-foreground @2xl:inline" title={e.thread_id ?? "session"}>
          {threadName(e.thread_id)}
        </span>
        <span className="flex shrink-0 items-baseline gap-2 font-semibold @xl:w-48">
          <span className={cn("size-1.5 shrink-0 self-center rounded-full", dot ?? "bg-muted-foreground")} />
          {e.kind.type}
        </span>
        {!open && <span className="truncate text-muted-foreground">{preview}</span>}
      </button>
      {open && <pre className="mt-1 overflow-x-auto rounded bg-muted p-2">{JSON.stringify(e, null, 2)}</pre>}
    </div>
  );
});
