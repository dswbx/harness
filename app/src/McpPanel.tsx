import { useCallback, useEffect, useState } from "react";
import { Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import type { HarnessClient, McpServerDef } from "@harness/api";
import { Badge, Button, Input, Select, Tooltip } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { filterServers, fromForm, summary, type Form, type Row } from "./settings";


const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

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

/** The MCP Library: MCP servers the user can give to Agents when creating a Session. */
export function McpPanel({
  client, onChanged, query,
}: {
  client: HarnessClient;
  onChanged?: () => void;
  query: string;
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
    void load();
  }, [load]);

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
  const shown = filterServers(servers, query);
  const valid = form && form.name.trim() && (form.kind === "stdio" ? form.command.trim() : form.url.trim());

  return (
    <div>
      <SectionHeader
        title="MCP servers"
        description="Servers you can give to an Agent when creating a Session. The Harness MCP is always included. Secret values are stored in the Keychain."
      >
        {!form && <Button size="sm" className="shrink-0" onClick={() => { setError(null); setForm(emptyForm()); }}><Plus /> Add server</Button>}
      </SectionHeader>

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
                <Tooltip content="Store the value in the Keychain">
                  <label className="flex shrink-0 items-center gap-1 text-xs">
                    <input type="checkbox" checked={r.secret} onChange={(e) => patchRow(i, { secret: e.target.checked, stored: false })} />
                    <Lock className="size-3" /> secret
                  </label>
                </Tooltip>
                <Button size="sm" variant="ghost" aria-label="Remove row" onClick={() => patch({ rows: form.rows.filter((_, j) => j !== i) })}>
                  <X />
                </Button>
              </div>
            ))}
          </div>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setForm(null); setError(null); }}>Cancel</Button>
            <Button disabled={busy || !valid} onClick={() => void save()}>Save</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 text-sm">
          {shown.length === 0 && <p className="text-muted-foreground">{servers.length === 0 ? "No MCP servers yet." : "No matching servers."}</p>}
          <ul className="grid gap-2">
            {shown.map((s) => (
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
        </div>
      )}
    </div>
  );
}
