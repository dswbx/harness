import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Tooltip, cn } from "@harness/ui";
import { formatDuration, formatRelativeTime, fullMessageTime, useNow } from "./time";

/**
 * Actions under a message. Shown while the message is hovered or has focus (parent needs `group`).
 * `hidden` (a message still streaming in) keeps its space so the layout doesn't shift when it ends.
 */
export function MessageFooter({ text, ts, durationMs, align = "start", hidden }: { text: string; ts: number; durationMs?: number; align?: "start" | "end"; hidden?: boolean }) {
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
        hidden && "invisible",
      )}
      aria-hidden={hidden}
    >
      <Tooltip content={copied ? "Copied" : "Copy"} delay={100}>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={copy}
          className="grid size-6 place-items-center rounded hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </Tooltip>
      <Tooltip content={fullMessageTime(ts)} align={align} delay={100}>
        <time dateTime={new Date(ts).toISOString()} className="px-1">
          {formatRelativeTime(ts, now)}
        </time>
      </Tooltip>
      {durationMs !== undefined && (
        <Tooltip content="Turn duration" delay={100}>
          <span className="px-1 tabular-nums">· {formatDuration(durationMs)}</span>
        </Tooltip>
      )}
    </div>
  );
}
