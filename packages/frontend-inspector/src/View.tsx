import { useMemo, useState } from "react";
import type { Event, SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import { Badge, Button, EventLog, Input } from "@harness/ui";

import { init, reduce, reduceBatch } from "./reducer";

/** Raw Session Log viewer. Assumes nothing about chat: it renders every Event kind generically. */
export function View({ api }: { api: SessionApi }) {
  const { events } = useSessionEvents(api, reduce, init, reduceBatch);
  const [text, setText] = useState("");
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
      <EventLog events={events} className="min-h-0 flex-1" />

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
