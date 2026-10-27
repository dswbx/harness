import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@harness/ui";
import { Markdown } from "./Markdown";
import type { JsonRenderInput } from "./tools";
import type { Item } from "./reducer";

type FT = Extract<Item, { type: "frontend_tool" }>;

const tones = {
  info: { icon: Info, box: "border-sky-500/40 bg-sky-500/5", fg: "text-sky-600 dark:text-sky-400" },
  success: { icon: CheckCircle2, box: "border-emerald-500/40 bg-emerald-500/5", fg: "text-emerald-600 dark:text-emerald-400" },
  warning: { icon: AlertTriangle, box: "border-amber-500/40 bg-amber-500/5", fg: "text-amber-600 dark:text-amber-400" },
  error: { icon: XCircle, box: "border-destructive/40 bg-destructive/5", fg: "text-destructive" },
} as const;

export function JsonRenderCard({ input }: { input: JsonRenderInput }) {
  const t = tones[input.tone ?? "info"];
  const Icon = t.icon;
  return (
    <div className={cn("rounded-lg border p-3 text-sm", t.box)}>
      <div className="flex items-center gap-2 font-medium">
        <Icon className={cn("size-4 shrink-0", t.fg)} />
        {input.title}
      </div>
      {input.body && <Markdown className="mt-2">{input.body}</Markdown>}
      {input.items && input.items.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {input.items.map((it, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{it.label}</dt>
              <dd className="min-w-0 break-words">{it.value ?? ""}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

const raw = (v: unknown) => JSON.stringify(v, null, 2);

export function FrontendToolRow({ item }: { item: FT }) {
  if (item.render?.ok) return <JsonRenderCard input={item.render.value} />;
  if (item.render && !item.render.ok) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-xs">
        <div className="font-medium text-destructive">Invalid {item.tool} input</div>
        <ul className="mt-1 list-disc pl-4 text-muted-foreground">
          {item.render.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2">{raw(item.input)}</pre>
      </div>
    );
  }
  return (
    <details className="rounded-lg border bg-card text-sm">
      <summary className="cursor-pointer px-3 py-2 text-xs">Frontend tool <span className="font-mono">{item.tool}</span></summary>
      <pre className="max-h-64 overflow-auto border-t bg-muted p-2 text-xs">{raw(item.input)}</pre>
    </details>
  );
}
