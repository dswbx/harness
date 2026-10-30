import type { SessionApi } from "@harness/api";
import { RenderUi } from "./RenderUi";
import type { Item } from "./reducer";

type FT = Extract<Item, { type: "frontend_tool" }>;

const raw = (v: unknown) => JSON.stringify(v, null, 2);

export function FrontendToolRow({ item, api }: { item: FT; api: SessionApi }) {
  if (item.render?.ok) return <RenderUi input={item.render.value} api={api} files={item.files} />;
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
