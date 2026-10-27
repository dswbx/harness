import { memo, useCallback, useMemo, useState } from "react";
import type { Event, SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import { Badge, Button, Input, Select, VirtualList, cn } from "@harness/ui";
import { ChevronRight } from "lucide-react";

import { init, reduce, reduceBatch } from "./reducer";

/** Raw Session Log viewer. Assumes nothing about chat: it renders every Event kind generically. */
export function View({ api }: { api: SessionApi }) {
  const { events } = useSessionEvents(api, reduce, init, reduceBatch);
  const [kind, setKind] = useState("");
  const [auto, setAuto] = useState(true);
  const [text, setText] = useState("");
  const [openSeqs, setOpenSeqs] = useState<ReadonlySet<number>>(new Set());
  const toggle = useCallback(
    (seq: number) => setOpenSeqs((s) => { const n = new Set(s); if (!n.delete(seq)) n.add(seq); return n; }),
    [],
  );

  const kinds = useMemo(() => [...new Set(events.map((e) => e.kind.type))].sort(), [events]);
  const shown = useMemo(() => (kind ? events.filter((e) => e.kind.type === kind) : events), [events, kind]);
  const pending = useMemo(() => {
    const open = new Map<string, Event>();
    for (const e of events) {
      if (e.kind.type === "PermissionRequested") open.set(e.kind.request_id, e);
      if (e.kind.type === "PermissionResolved") open.delete(e.kind.request_id);
    }
    return [...open.values()];
  }, [events]);

  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e) => setError(e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e)));
  };
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    run(api.prompt(t));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">Session Log</span>
        <Badge variant="secondary">{events.length} events</Badge>
        <div className="flex-1" />
        <Select className="h-8 w-56" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Autoscroll
        </label>
      </div>

      <VirtualList
        count={shown.length}
        getKey={(i) => shown[i]!.seq}
        estimateSize={28}
        stickToBottom={auto}
        className="font-mono text-xs"
        renderRow={(i) => <Row e={shown[i]!} open={openSeqs.has(shown[i]!.seq)} onToggle={toggle} />}
      />

      {pending.map((p) => (
        <Permission key={p.seq} e={p} api={api} run={run} />
      ))}

      {error && <p role="alert" className="whitespace-pre-wrap border-t px-3 py-1.5 text-xs text-destructive">{error}</p>}
      <div className="flex gap-2 border-t p-2">
        <Input
          value={text}
          placeholder="Prompt..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <Button onClick={send}>Send</Button>
        <Button variant="outline" onClick={() => run(api.cancel())}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const Row = memo(function Row({ e, open, onToggle }: { e: Event; open: boolean; onToggle: (seq: number) => void }) {
  const preview = JSON.stringify(e.kind, (k, v) => (k === "type" ? undefined : v));
  return (
    <div className="border-b border-border/50 px-3 py-1 hover:bg-accent/40">
      <button className="flex w-full items-baseline gap-3 text-left" onClick={() => onToggle(e.seq)}>
        <ChevronRight className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")} />
        <span className="w-10 shrink-0 text-right text-muted-foreground">{e.seq}</span>
        <span className="w-24 shrink-0 text-muted-foreground">{new Date(e.ts_ms).toISOString().slice(11, 23)}</span>
        <span className="w-16 shrink-0 truncate text-muted-foreground" title={e.thread_id ?? "session"}>
          {e.thread_id ? e.thread_id.slice(-6) : "session"}
        </span>
        <span className="w-48 shrink-0 font-semibold">{e.kind.type}</span>
        {!open && <span className="truncate text-muted-foreground">{preview}</span>}
      </button>
      {open && <pre className="mt-1 overflow-x-auto rounded bg-muted p-2">{JSON.stringify(e, null, 2)}</pre>}
    </div>
  );
});

function Permission({ e, api, run }: { e: Event; api: SessionApi; run: (p: Promise<unknown>) => void }) {
  if (e.kind.type !== "PermissionRequested") return null;
  const k = e.kind;
  const title = (k.tool_call as { title?: string } | null)?.title ?? "Permission requested";
  return (
    <div className="flex flex-wrap items-center gap-2 border-t bg-amber-500/10 px-3 py-2">
      <Badge variant="warning">Permission</Badge>
      <span className="text-sm">{title}</span>
      <div className="flex-1" />
      {k.options.map((o) => (
        <Button key={o.option_id} size="sm" variant="outline" onClick={() => run(api.resolvePermission(k.request_id, o.option_id))}>
          {o.name}
        </Button>
      ))}
      <Button size="sm" variant="ghost" onClick={() => run(api.resolvePermission(k.request_id, null))}>
        Dismiss
      </Button>
    </div>
  );
}
