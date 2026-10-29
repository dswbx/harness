import { useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { SessionApi, SlashCommand } from "@harness/api";
import { Button, HoverTip, cn } from "@harness/ui";
import { ConfigBar } from "./ConfigBar";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { lineCount } from "./promptMarkdown";
import { matchCommands } from "./commands";
import { errorMessage } from "./errors";
import type { ChatState } from "./reducer";

export function PromptBox({ api, state }: { api: SessionApi; state: ChatState }) {
  const [text, setText] = useState("");
  const [lines, setLines] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<PromptEditorHandle>(null);
  const running = state.turnId !== null;
  const matches = useMemo(() => matchCommands(state.commands, text), [state.commands, text]);
  const pct = state.usage ? Math.min(100, Math.round((state.usage.used / state.usage.size) * 100)) : null;

  const [error, setError] = useState<string | null>(null);
  const readOnly = state.readOnly;

  const send = () => {
    const t = ref.current?.getMarkdown().trim() ?? "";
    if (!t || readOnly) return;
    ref.current?.clear();
    setError(null);
    api.prompt(t).catch((err) => {
      setError(errorMessage(err));
      ref.current?.restore(t);
    });
  };
  const continueWithSummary = () => {
    const t = ref.current?.getMarkdown().trim() ?? "";
    ref.current?.clear();
    setError(null);
    api.continueWithSummary(t || null).catch((err) => {
      setError(errorMessage(err));
      if (t) ref.current?.restore(t);
    });
  };
  const pick = (c: SlashCommand) => ref.current?.setText(`/${c.name} `);

  return (
    <div className="relative border-t p-3">
      {matches.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 max-h-72 w-72 max-w-[calc(100%-1.5rem)] overflow-auto rounded-lg border bg-popover p-1 shadow-md" role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <HoverTip key={c.name} content={c.description} open={i === sel && !!c.description}>
              <button
                ref={i === sel ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                role="option"
                aria-selected={i === sel}
                aria-description={c.description || undefined}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === sel && "bg-accent")}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => pick(c)}
              >
                <span className="truncate">/{c.name}</span>
                {c.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{c.hint}</span>}
              </button>
            </HoverTip>
          ))}
        </div>
      )}
      {readOnly && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
          <span className="flex-1">The Agent can't continue its earlier session. Continue with a summary of this conversation?</span>
          <Button size="sm" onClick={continueWithSummary}>Continue with summary</Button>
        </div>
      )}
      {error && (
        <div role="alert" className="mb-2 whitespace-pre-wrap text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="rounded-xl border bg-card p-2">
        <PromptEditor
          ref={ref}
          placeholder={running ? "Agent is working... (you can still queue a prompt)" : "Message the Agent. Type / for commands."}
          menuOpen={matches.length > 0}
          onMenuKey={(k) => {
            if (k === "down") setSel((sel + 1) % matches.length);
            else if (k === "up") setSel((sel + matches.length - 1) % matches.length);
            else pick(matches[sel]!);
          }}
          onChange={(t, md) => {
            if (t !== text) setSel(0);
            setText(t);
            setLines(lineCount(md));
          }}
          onSubmit={send}
          onOverflowChange={setOverflow}
        />
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <ConfigBar
            options={state.configOptions}
            onChange={(id, value) => {
              setError(null);
              api.setConfigOption(id, value).catch((err) => setError(errorMessage(err)));
            }}
          />
          <div className="flex-1" />
          {overflow && <span className="text-xs tabular-nums text-muted-foreground">{lines} lines</span>}
          {pct != null && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`${state.usage!.used.toLocaleString()} / ${state.usage!.size.toLocaleString()} tokens`}>
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full", pct > 85 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
              </div>
              {pct}%
            </div>
          )}
          {running && (
            <Button size="sm" variant="outline" onClick={() => { setError(null); api.cancel().catch((err) => setError(errorMessage(err))); }}>
              <Square className="size-3" /> Cancel
            </Button>
          )}
          <Button size="icon" className="size-7 rounded-full" disabled={!text.trim() || readOnly} onClick={send} aria-label="Send">
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}
