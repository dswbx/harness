import { useMemo, useState } from "react";
import { applyStatePatch } from "@harness/api";
import { cn } from "@harness/ui";
import { RenderUi } from "./RenderUi";
import { components, type ComponentType, type RawNode } from "./tools";

/** Every `render_ui` component with its live example (ADR 0013). State and messages stay local. */
export function RenderUiGallery({ query = "" }: { query?: string }) {
  const q = query.trim().toLowerCase();
  const names = (Object.keys(components) as ComponentType[]).filter(
    (n) => !q || n.toLowerCase().includes(q) || components[n].description.toLowerCase().includes(q),
  );
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        What Agents can show with <code className="rounded bg-muted px-1 font-mono text-xs">render_ui</code>: inline in the chat, or in a live area (top, bottom, a tab on the right). Examples are interactive; their state stays on this page.
      </p>
      {names.map((n) => <Entry key={n} name={n} />)}
      {names.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No component matches.</p>}
    </div>
  );
}

function Entry({ name }: { name: ComponentType }) {
  const c = components[name] as { description: string; example: { node: unknown; state?: unknown }; bind?: readonly string[]; events?: readonly string[] };
  const [state, setState] = useState<unknown>(c.example.state ?? {});
  const [sent, setSent] = useState<string | null>(null);
  const [json, setJson] = useState(false);
  const env = useMemo(
    () => ({
      state,
      patch: async (ops: Parameters<typeof applyStatePatch>[1]) => setState((s: unknown) => applyStatePatch(s, ops)),
      send: async (text: string) => setSent(text),
      files: {},
    }),
    [state],
  );
  const stateful = c.example.state !== undefined;
  return (
    <section className="rounded-lg border">
      <header className="flex items-baseline gap-2 border-b px-4 py-2.5">
        <h3 className="font-mono text-sm font-medium">{name}</h3>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={c.description}>{c.description}</p>
        <button onClick={() => setJson(!json)} className={cn("shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent", json && "bg-accent text-foreground")}>
          JSON
        </button>
      </header>
      <div className="p-4">
        <RenderUi root={c.example.node as RawNode} env={env} />
      </div>
      {(json || stateful || sent) && (
        <div className="grid gap-2 border-t bg-muted/30 px-4 py-2.5 text-xs">
          {sent && <div><span className="text-muted-foreground">sendMessage: </span>{sent}</div>}
          {stateful && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">State</span>
              <code className="min-w-0 flex-1 truncate font-mono">{JSON.stringify(state)}</code>
              <button className="text-muted-foreground hover:text-foreground" onClick={() => { setState(c.example.state); setSent(null); }}>Reset</button>
            </div>
          )}
          {json && <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono">{JSON.stringify({ root: c.example.node }, null, 2)}</pre>}
        </div>
      )}
    </section>
  );
}
