import { useCallback, useEffect, useState } from "react";
import { Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import type { HarnessClient, McpServerDef } from "@harness/api";
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select,
} from "@harness/ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

type Row = { key: string; value: string; secret: boolean; /** Secret already stored in the Keychain. */ stored: boolean };
type Form = { id: string; name: string; kind: "stdio" | "http"; command: string; args: string; url: string; rows: Row[] };

const emptyForm = (): Form => ({ id: "", name: "", kind: "stdio", command: "", args: "", url: "", rows: [] });

function toForm(s: McpServerDef): Form {
  const t = s.transport;
  const plain = t.type === "stdio" ? (t.env ?? {}) : (t.headers ?? {});
  const secretKeys = s.secret_keys ?? [];
  const rows: Row[] = [
    ...Object.entries(plain).filter(([k]) => !secretKeys.includes(k)).map(([key, value]) => ({ key, value, secret: false, stored: false })),
    ...secretKeys.map((key) => ({ key, value: "", secret: true, stored: true })),
  ];
  return {
    id: s.id ?? "", name: s.name, kind: t.type,
    command: t.type === "stdio" ? t.command : "", args: t.type === "stdio" ? (t.args ?? []).join(" ") : "",
    url: t.type === "http" ? t.url : "", rows,
  };
}

/** Form -> command payload. Secret values go to `secrets`, never into the definition. */
export function fromForm(f: Form): { server: McpServerDef; secrets: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const r of f.rows) {
    const key = r.key.trim();
    if (!key) continue;
    if (r.secret) {
      secretKeys.push(key);
      if (r.value) secrets[key] = r.value;
    } else plain[key] = r.value;
  }
  const transport: McpServerDef["transport"] =
    f.kind === "stdio"
      ? { type: "stdio", command: f.command.trim(), args: f.args.split(/\s+/).filter(Boolean), env: plain }
      : { type: "http", url: f.url.trim(), headers: plain };
  return { server: { id: f.id, name: f.name.trim(), transport, secret_keys: secretKeys }, secrets };
}

function summary(s: McpServerDef) {
  return s.transport.type === "stdio" ? `${s.transport.command} ${(s.transport.args ?? []).join(" ")}`.trim() : s.transport.url;
}

/** The MCP Library: MCP servers the user can give to Agents when creating a Session. */
export function McpDialog({
  client, open, onOpenChange, onChanged,
}: {
  client: HarnessClient;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged?: () => void;
}) {
  const [servers, setServers] = useState<McpServerDef[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toRemove, setToRemove] = useState<McpServerDef | null>(null);

  const load = useCallback(async () => {
    try {
      setServers(await client.listMcpServers());
    } catch (e) {
      setError(errText(e));
    }
  }, [client]);

  useEffect(() => {
    if (open) {
      setError(null);
      setForm(null);
      void load();
    }
  }, [open, load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const { server, secrets } = fromForm(form);
      await client.saveMcpServer(server, secrets);
      setForm(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!toRemove?.id) return;
    try {
      await client.removeMcpServer(toRemove.id);
      setToRemove(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(errText(e));
      setToRemove(null);
    }
  };

  const patch = (p: Partial<Form>) => setForm((f) => f && { ...f, ...p });
  const patchRow = (i: number, p: Partial<Row>) => setForm((f) => f && { ...f, rows: f.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const rowLabel = form?.kind === "http" ? "Headers" : "Environment";
  const valid = form && form.name.trim() && (form.kind === "stdio" ? form.command.trim() : form.url.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>MCP servers</DialogTitle>
          <DialogDescription>
            Servers you can give to an Agent when creating a Session. The Harness MCP is always included. Secret values are stored in the Keychain.
          </DialogDescription>
        </DialogHeader>

        {form ? (
          <div className="grid gap-3 text-sm">
            <label className="grid gap-1">
              Name
              <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="GitHub" />
            </label>
            <label className="grid gap-1">
              Transport
              <Select value={form.kind} onChange={(e) => patch({ kind: e.target.value as Form["kind"] })}>
                <option value="stdio">stdio (local command)</option>
                <option value="http">http (URL)</option>
              </Select>
            </label>
            {form.kind === "stdio" ? (
              <>
                <label className="grid gap-1">
                  Command
                  <Input value={form.command} onChange={(e) => patch({ command: e.target.value })} placeholder="npx" />
                </label>
                <label className="grid gap-1">
                  Arguments (space separated)
                  <Input value={form.args} onChange={(e) => patch({ args: e.target.value })} placeholder="-y @modelcontextprotocol/server-github" />
                </label>
              </>
            ) : (
              <label className="grid gap-1">
                URL
                <Input value={form.url} onChange={(e) => patch({ url: e.target.value })} placeholder="https://example.com/mcp" />
              </label>
            )}
            <div className="grid gap-1">
              <div className="flex items-center justify-between">
                <span>{rowLabel} <span className="text-xs text-muted-foreground">KEY and value</span></span>
                <Button size="sm" variant="outline" onClick={() => patch({ rows: [...form.rows, { key: "", value: "", secret: false, stored: false }] })}>
                  <Plus /> Add
                </Button>
              </div>
              {form.rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="w-2/5" aria-label="Key" value={r.key} onChange={(e) => patchRow(i, { key: e.target.value })} placeholder={form.kind === "http" ? "Authorization" : "TOKEN"} />
                  <Input
                    aria-label="Value"
                    type={r.secret ? "password" : "text"}
                    value={r.value}
                    onChange={(e) => patchRow(i, { value: e.target.value })}
                    placeholder={r.secret ? (r.stored ? "stored in Keychain" : "value (goes to Keychain)") : "value"}
                    autoComplete="off"
                  />
                  <label className="flex shrink-0 items-center gap-1 text-xs" title="Store the value in the Keychain">
                    <input type="checkbox" checked={r.secret} onChange={(e) => patchRow(i, { secret: e.target.checked, stored: false })} />
                    <Lock className="size-3" /> secret
                  </label>
                  <Button size="sm" variant="ghost" aria-label="Remove row" onClick={() => patch({ rows: form.rows.filter((_, j) => j !== i) })}>
                    <X />
                  </Button>
                </div>
              ))}
            </div>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => { setForm(null); setError(null); }}>Cancel</Button>
              <Button disabled={busy || !valid} onClick={() => void save()}>Save</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-3 text-sm">
            {servers.length === 0 && <p className="text-muted-foreground">No MCP servers yet.</p>}
            <ul className="grid gap-2">
              {servers.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-md border p-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <Badge variant="secondary">{s.transport.type}</Badge>
                      {(s.secret_keys?.length ?? 0) > 0 && <Badge variant="outline"><Lock className="size-3" />{s.secret_keys!.length}</Badge>}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground" title={summary(s)}>{summary(s)}</div>
                  </div>
                  <Button size="sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => { setError(null); setForm(toForm(s)); }}>
                    <Pencil />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setToRemove(s)}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            {toRemove && (
              <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 p-2">
                <span className="flex-1">Remove "{toRemove.name}" and its stored secrets?</span>
                <Button size="sm" variant="outline" onClick={() => setToRemove(null)}>Cancel</Button>
                <Button size="sm" variant="destructive" onClick={() => void remove()}>Remove</Button>
              </div>
            )}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <DialogFooter>
              <Button onClick={() => { setError(null); setForm(emptyForm()); }}><Plus /> Add server</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
