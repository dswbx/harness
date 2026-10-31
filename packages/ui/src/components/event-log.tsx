import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { Badge } from "./badge";
import { Input } from "./input";
import { Select } from "./select";
import { VirtualList } from "./virtual-list";

/** The Event fields the log shows; structural, so `@harness/ui` needs no `@harness/api`. */
export type LogEvent = { seq: number; ts_ms: number; thread_id?: string | null; kind: { type: string } };

/**
 * Raw Session Log viewer: kind filter, text search over the JSON, autoscroll, rows that open to
 * the full Event. Narrow containers drop the time and thread columns. `actions`: header buttons.
 */
export function EventLog({ events, title = "Session Log", actions, className }: {
  events: readonly LogEvent[];
  title?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  const [kind, setKind] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [auto, setAuto] = React.useState(true);
  const [openSeqs, setOpenSeqs] = React.useState<ReadonlySet<number>>(new Set());
  const toggle = React.useCallback(
    (seq: number) => setOpenSeqs((s) => { const n = new Set(s); if (!n.delete(seq)) n.add(seq); return n; }),
    [],
  );

  const kinds = React.useMemo(() => [...new Set(events.map((e) => e.kind.type))].sort(), [events]);
  const q = React.useDeferredValue(query.trim().toLowerCase());
  const shown = React.useMemo(() => {
    const byKind = kind ? events.filter((e) => e.kind.type === kind) : events;
    return q ? byKind.filter((e) => JSON.stringify(e).toLowerCase().includes(q)) : byKind;
  }, [events, kind, q]);

  return (
    <div className={cn("@container flex h-full min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{title}</span>
        <Badge variant="secondary">{shown.length === events.length ? events.length : `${shown.length}/${events.length}`} events</Badge>
        <div className="flex-1" />
        {/* Narrow: filters wrap to their own line below the actions. */}
        <div className="order-last flex w-full items-center gap-2 @2xl:order-none @2xl:w-auto">
          <Input className="h-8 min-w-0 flex-1 @2xl:w-56" value={query} placeholder="Search..." aria-label="Search events" onChange={(e) => setQuery(e.target.value)} />
          <Select className="h-8 w-40 shrink @2xl:w-56" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Autoscroll
          </label>
        </div>
        {actions}
      </div>
      <VirtualList
        count={shown.length}
        getKey={(i) => shown[i]!.seq}
        estimateSize={28}
        stickToBottom={auto}
        className="font-mono text-xs"
        empty={<p className="py-8 text-center text-muted-foreground">{events.length ? "No matching events." : "No events yet."}</p>}
        renderRow={(i) => <Row e={shown[i]!} open={openSeqs.has(shown[i]!.seq)} onToggle={toggle} />}
      />
    </div>
  );
}

const Row = React.memo(function Row({ e, open, onToggle }: { e: LogEvent; open: boolean; onToggle: (seq: number) => void }) {
  const preview = JSON.stringify(e.kind, (k, v) => (k === "type" ? undefined : v));
  return (
    <div className="border-b border-border/50 px-3 py-1 hover:bg-accent/40">
      <button className="flex w-full items-baseline gap-3 text-left" onClick={() => onToggle(e.seq)}>
        <ChevronRight className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")} />
        <span className="w-10 shrink-0 text-right text-muted-foreground">{e.seq}</span>
        <span className="hidden w-24 shrink-0 text-muted-foreground @xl:inline">{new Date(e.ts_ms).toISOString().slice(11, 23)}</span>
        <span className="hidden w-16 shrink-0 truncate text-muted-foreground @2xl:inline" title={e.thread_id ?? "session"}>
          {e.thread_id ? e.thread_id.slice(-6) : "session"}
        </span>
        <span className="shrink-0 font-semibold @xl:w-48">{e.kind.type}</span>
        {!open && <span className="truncate text-muted-foreground">{preview}</span>}
      </button>
      {open && <pre className="mt-1 overflow-x-auto rounded bg-muted p-2">{JSON.stringify(e, null, 2)}</pre>}
    </div>
  );
});
