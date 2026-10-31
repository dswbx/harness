import { useEffect, useState, useSyncExternalStore } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { HarnessClient } from "@harness/api";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, Textarea, cn } from "@harness/ui";
import { setGuessInlineCode, setToolDisplay, toolDisplays, useGuessInlineCode, useToolDisplay } from "@harness/frontend-chat";
import { SectionHeader } from "./SectionHeader";
import { ThemePicker } from "./ThemePicker";
import { openExternal } from "./openExternal";
import {
  CUSTOM_FONT_MAX, DEFAULT_APPEARANCE, FLOWS, FONT_SIZE_MAX, FONT_SIZE_MIN, LEADINGS, MODES, MONO_FONTS, SANS_FONTS, TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN, clampFontSize, cleanFont,
  getAppearance, getImportedThemes, getThemes, isDarkMode, onThemesChange, previewAppearance, revertPreview, setAppearance, setImportedThemes,
  type Appearance, type FontOption, type RhythmOption,
} from "./appearance/appearance";
import { fromCss, fromRegistryItem, registryUrl, themeId } from "./appearance/importTheme";

/** Where themes come from: browse, make your own, then copy the link. */
const TWEAKCN = "https://tweakcn.com/editor/theme";
const heading = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <>
      <label htmlFor={htmlFor} className={heading}>{label}</label>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </>
  );
}

/** A titled block of rows. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="border-t pt-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-3">{children}</div>
    </section>
  );
}

function FontRow({ label, id, value, custom, placeholder, fonts, onChange, defaultLabel = "Theme default" }: {
  label: string; id: string; value: string; custom: string; placeholder: string; fonts: FontOption[];
  onChange: (patch: { choice?: string; custom?: string }) => void;
  /** Label of the "theme" choice. */
  defaultLabel?: string;
}) {
  return (
    <Row label={label} htmlFor={id}>
      <Select id={id} className="h-8 w-72 shrink-0 text-xs" value={value} onChange={(e) => onChange({ choice: e.target.value })}>
        <option value="theme">{defaultLabel}</option>
        <option value="system">System</option>
        {fonts.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
        <option value="custom">Custom…</option>
      </Select>
      {value === "custom" && (
        <Input
          className="h-8 max-w-72 text-xs"
          aria-label={`${label} family`}
          placeholder={placeholder}
          maxLength={CUSTOM_FONT_MAX}
          spellCheck={false}
          value={custom}
          onChange={(e) => onChange({ custom: cleanFont(e.target.value) })}
        />
      )}
    </Row>
  );
}

function RhythmRow({ label, id, value, options, onChange }: {
  label: string; id: string; value: string; options: RhythmOption[]; onChange: (id: string) => void;
}) {
  return (
    <Row label={label} htmlFor={id}>
      <Select id={id} className="h-8 w-44 shrink-0 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label} ({o.value})</option>
        ))}
      </Select>
    </Row>
  );
}

/** Chat Frontend: how tool calls look (stored by the Frontend itself). */
function ToolDisplayRow() {
  const current = useToolDisplay();
  return (
    <Row label="Tool calls" htmlFor="tool-display">
      <Select id="tool-display" className="h-8 w-44 shrink-0 text-xs" value={current.id} onChange={(e) => setToolDisplay(e.target.value)}>
        {toolDisplays.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </Select>
    </Row>
  );
}

/** Chat Frontend: highlight unmarked code-like inline code in the message's language (stored by the Frontend itself). */
function GuessInlineCodeRow() {
  const on = useGuessInlineCode();
  return (
    <Row label="Inline code" htmlFor="guess-inline-code">
      <label className="flex items-center gap-2 text-xs">
        <button
          id="guess-inline-code"
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => setGuessInlineCode(!on)}
          className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}
        >
          <span className={cn("absolute top-0.5 size-3 rounded-full bg-background transition-all", on ? "left-3.5" : "left-0.5")} />
        </button>
        <span>Guess the language</span>
        <span className="truncate text-muted-foreground">From the message's code blocks and file names, else TypeScript</span>
      </label>
    </Row>
  );
}

/** px stepper: typing, arrows, +/- buttons, clamped to min..max (FONT_SIZE_MIN..MAX by default), with Reset. */
function SizeField({ id, label, value, fallback, onChange, min = FONT_SIZE_MIN, max = FONT_SIZE_MAX }: {
  id: string; label: string; value: number; fallback: number; onChange: (n: number) => void; min?: number; max?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const set = (n: number) => {
    setText(null);
    if (Number.isFinite(n)) onChange(clampFontSize(n, min, max));
  };
  return (
    <>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="outline" className="size-8" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => set(value - 1)}>
          <Minus />
        </Button>
        <div className="relative">
          <Input
            id={id}
            inputMode="numeric"
            className="h-8 w-16 pl-2 pr-7 text-right text-xs tabular-nums"
            value={text ?? String(value)}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
              setText(v);
              const n = Number(v);
              if (v && n >= min && n <= max) onChange(n);
            }}
            onBlur={() => text !== null && set(text ? Number(text) : value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                set(value + (e.key === "ArrowUp" ? 1 : -1));
              } else if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">px</span>
        </div>
        <Button size="icon" variant="outline" className="size-8" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => set(value + 1)}>
          <Plus />
        </Button>
      </div>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={value === fallback} onClick={() => set(fallback)}>
        Reset
      </Button>
    </>
  );
}

/** Paste a tweakcn link (fetched by the core) or theme CSS; the theme is stored and selected. */
function ImportTheme({ client, onImported }: { client: HarnessClient; onImported: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let url: string | null = null;
  try {
    url = registryUrl(text);
  } catch { /* shown on import */ }
  const isCss = !!text.trim() && !/^\s*https?:/i.test(text);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const u = registryUrl(text);
      const theme = u ? fromRegistryItem(await client.fetchJson(u), u) : fromCss(text, name);
      const all = getImportedThemes();
      const id = themeId(theme.label, (x) => Object.hasOwn(all, x));
      await setImportedThemes({ ...all, [id]: theme });
      onImported(id);
      setOpen(false);
      setText("");
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { setError(null); setOpen(true); }}>Import…</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" data-keep-escape>
          <DialogHeader>
            <DialogTitle>Import theme</DialogTitle>
            <DialogDescription>
              Paste a tweakcn theme link (from Share, or the <code className="font-mono">shadcn add</code> URL in Code), or the theme's CSS (<code className="font-mono">:root</code> and <code className="font-mono">.dark</code>).{" "}
              <a href={TWEAKCN} target="_blank" rel="noreferrer" onClick={(e) => openExternal(e, TWEAKCN)} className="underline underline-offset-2 hover:text-foreground">
                Find or make themes on tweakcn
              </a>
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            aria-label="Theme link or CSS"
            placeholder={"https://tweakcn.com/themes/…\n\nor\n\n:root {\n  --background: oklch(…);\n  …\n}"}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            className="max-h-72 min-h-32 font-mono text-xs"
          />
          {isCss && <Input aria-label="Theme name" placeholder="Theme name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={busy || !text.trim() || (isCss && !name.trim())} onClick={() => void submit()}>
              {busy ? "Importing…" : url ? "Fetch and import" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Imported themes, each removable (the current one falls back to Default). */
function ImportedThemes({ current, onRemoved }: { current: string; onRemoved: () => void }) {
  const themes = useSyncExternalStore(onThemesChange, getThemes).filter((t) => t.imported);
  if (!themes.length) return null;
  const remove = (id: string) => {
    const { [id]: _, ...rest } = getImportedThemes();
    void setImportedThemes(rest);
    if (id === current) onRemoved();
  };
  return (
    <Row label="Imported">
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {themes.map((t) => (
          <span key={t.id} className="inline-flex h-7 items-center gap-1 rounded-md border pl-2 pr-0.5 text-xs">
            {t.label}
            <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" aria-label={`Remove ${t.label}`} onClick={() => remove(t.id)}>
              <X />
            </Button>
          </span>
        ))}
      </div>
    </Row>
  );
}

/** Theme, text, chat and terminal settings in groups. Changes apply and save right away. */
export function AppearancePanel({ client }: { client: HarnessClient }) {
  const [a, setA] = useState<Appearance>(getAppearance);
  const update = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch };
    setA(next);
    setAppearance(next);
  };
  // Leaving the panel mid-preview restores the saved theme.
  useEffect(() => revertPreview, []);
  const isDark = isDarkMode(a.mode, window);

  return (
    <div className="text-sm">
      <SectionHeader title="Appearance" description="Theme, fonts and text sizes for all windows." />

      <div className="grid gap-5">
        <Group title="Theme">
          <Row label="Mode">
            <div role="group" aria-label="Mode" className="inline-flex shrink-0 rounded-md border p-0.5">
              {MODES.map((m) => (
                <button
                  key={m}
                  aria-pressed={a.mode === m}
                  onClick={() => update({ mode: m })}
                  className={cn("rounded px-2.5 py-1 text-xs capitalize", a.mode === m ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}
                >
                  {m}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Theme">
            <ThemePicker
              value={a.theme}
              isDark={isDark}
              onPreview={(theme) => previewAppearance({ ...a, theme })}
              onCommit={(theme) => update({ theme })}
              onRevert={revertPreview}
            />
            <ImportTheme client={client} onImported={(theme) => update({ theme })} />
          </Row>
          <ImportedThemes current={a.theme} onRemoved={() => update({ theme: "default" })} />
        </Group>
        <Group title="Text">
          <FontRow
            label="Font" id="font-sans" value={a.font} custom={a.customFont} placeholder="Avenir Next, sans-serif" fonts={SANS_FONTS}
            onChange={({ choice, custom }) => update(custom === undefined ? { font: choice } : { customFont: custom })}
          />
          <FontRow
            label="Mono font" id="font-mono" value={a.mono} custom={a.customMono} placeholder="Berkeley Mono, monospace" fonts={MONO_FONTS}
            onChange={({ choice, custom }) => update(custom === undefined ? { mono: choice } : { customMono: custom })}
          />
          <Row label="UI font size" htmlFor="font-size">
            <SizeField id="font-size" label="UI font size" value={a.fontSize} fallback={DEFAULT_APPEARANCE.fontSize} onChange={(fontSize) => update({ fontSize })} />
          </Row>
        </Group>
        <Group title="Chat">
          <Row label="Font size" htmlFor="chat-font-size">
            <SizeField id="chat-font-size" label="chat font size" value={a.chatFontSize} fallback={DEFAULT_APPEARANCE.chatFontSize} onChange={(chatFontSize) => update({ chatFontSize })} />
          </Row>
          <RhythmRow label="Leading" id="chat-leading" value={a.leading} options={LEADINGS} onChange={(leading) => update({ leading })} />
          <RhythmRow label="Flow" id="chat-flow" value={a.flow} options={FLOWS} onChange={(flow) => update({ flow })} />
          <ToolDisplayRow />
          <GuessInlineCodeRow />
        </Group>
        <Group title="Terminal">
          <FontRow
            label="Font" id="terminal-font" value={a.terminalFont} custom={a.customTerminalFont} placeholder="Iosevka, monospace" fonts={MONO_FONTS}
            defaultLabel="Mono font"
            onChange={({ choice, custom }) => update(custom === undefined ? { terminalFont: choice } : { customTerminalFont: custom })}
          />
          <Row label="Font size" htmlFor="terminal-font-size">
            <SizeField
              id="terminal-font-size" label="terminal font size" value={a.terminalFontSize} fallback={DEFAULT_APPEARANCE.terminalFontSize}
              min={TERMINAL_FONT_SIZE_MIN} max={TERMINAL_FONT_SIZE_MAX} onChange={(terminalFontSize) => update({ terminalFontSize })}
            />
          </Row>
        </Group>
      </div>
    </div>
  );
}
