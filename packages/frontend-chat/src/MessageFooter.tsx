import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Tooltip, cn } from "@harness/ui";
import { formatDuration, formatRelativeTime, fullMessageTime, useNow } from "./time";

/** Actions under a message. Shown while the message is hovered or has focus (parent needs `group`). */
export function MessageFooter({ text, ts, durationMs, align = "start" }: { text: string; ts: number; durationMs?: number; align?: "start" | "end" }) {
  const [copied, setCopied] = useState(false);
  const now = useNow();

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});

  return (
    <div
      className={cn(
        "mt-1 flex h-6 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
        align === "end" && "flex-row-reverse",
      )}
    >
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy message"}
        title={copied ? "Copied" : "Copy"}
        onClick={copy}
        className="grid size-6 place-items-center rounded hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <Tooltip content={fullMessageTime(ts)} align={align} fast>
        <time dateTime={new Date(ts).toISOString()} className="px-1">
          {formatRelativeTime(ts, now)}
        </time>
      </Tooltip>
      {durationMs !== undefined && <span className="px-1 tabular-nums" title="Turn duration">· {formatDuration(durationMs)}</span>}
    </div>
  );
}
