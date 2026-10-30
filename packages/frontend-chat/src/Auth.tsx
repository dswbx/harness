import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { SessionApi } from "@harness/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Tooltip } from "@harness/ui";
import type { Item } from "./reducer";

type Auth = Extract<Item, { type: "auth" }>;

/** Shown when the Agent needs the user to sign in before it can start a session. */
export function AuthCard({ item, api }: { item: Auth; api: SessionApi }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (m: Auth["methods"][number]) => {
    setBusy(m.id);
    setResult(null);
    try {
      if (m.kind === "terminal") await api.openAuthTerminal(m.id);
      else await api.authenticate(m.id);
      setResult({ ok: true, text: m.kind === "terminal" ? "Terminal opened. Finish signing in there." : "Signed in." });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <KeyRound className="size-4 text-amber-500" />
        <CardTitle>Sign in required</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{item.message}</p>
        {item.methods.length === 0 ? (
          <p className="text-muted-foreground">
            Sign in to this Agent outside the Harness (e.g. run its CLI login), then send your message again.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {item.methods.map((m) => (
                <Tooltip key={m.id} content={m.description}>
                  <Button size="sm" disabled={busy !== null} onClick={() => void run(m)}>
                    {m.kind === "terminal" ? `Open Terminal: ${m.name}` : m.name}
                  </Button>
                </Tooltip>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">After signing in, send your message again.</p>
          </>
        )}
        {result && (
          <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-xs text-emerald-600" : "text-xs text-destructive"}>
            {result.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
