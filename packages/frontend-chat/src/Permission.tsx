import { useState } from "react";
import { ShieldQuestion, ClipboardList } from "lucide-react";
import type { SessionApi } from "@harness/api";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@harness/ui";
import { errorMessage } from "./errors";
import { Markdown } from "./Markdown";
import { harnessToolName, permissionTitle, planOf, type Item } from "./reducer";

type Perm = Extract<Item, { type: "permission" }>;

/** Inline permission prompt. A switch_mode request carrying a plan renders as a Plan card (Plan Mode approval). */
export function PermissionCard({ item, api }: { item: Perm; api: SessionApi }) {
  const plan = planOf(item.toolCall);
  const friendly = permissionTitle(item.toolCall);
  const title = friendly ?? item.toolCall.title ?? "Permission requested";
  const [error, setError] = useState<string | null>(null);
  const answer = (optionId: string | null) => {
    setError(null);
    api.resolvePermission(item.requestId, optionId).catch((e) => setError(errorMessage(e)));
  };
  const harness = harnessToolName(item.toolCall.title);
  return (
    <Card className={plan ? "border-primary/40" : "border-amber-500/40"}>
      <CardHeader>
        {plan ? <ClipboardList className="size-4" /> : <ShieldQuestion className="size-4 text-amber-500" />}
        <CardTitle>{plan ? "Plan" : title}</CardTitle>
        {!plan && friendly && item.toolCall.title && <span className="font-mono text-xs text-muted-foreground">{harness ?? item.toolCall.title}</span>}
        {plan && <span className="text-xs text-muted-foreground">{title}</span>}
      </CardHeader>
      <CardContent className="space-y-3">
        {plan && <Markdown className="max-h-96 overflow-auto rounded border bg-background p-3">{plan}</Markdown>}
        <div className="flex flex-wrap gap-2">
          {item.options.map((o) => (
            <Button
              key={o.option_id}
              size="sm"
              variant={o.kind.startsWith("allow") ? "default" : "outline"}
              onClick={() => answer(o.option_id)}
            >
              {o.name}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => answer(null)}>
            Dismiss
          </Button>
        </div>
        {error && <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
