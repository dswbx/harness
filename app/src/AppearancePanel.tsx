import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button, Input, Select, cn } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { ThemePicker } from "./ThemePicker";
import { openExternal } from "./openExternal";
import {
  CUSTOM_FONT_MAX, DEFAULT_APPEARANCE, FLOWS, FONT_SIZE_MAX, FONT_SIZE_MIN, LEADINGS, MODES, MONO_FONTS, SANS_FONTS, clampFontSize, cleanFont,
  getAppearance, isDarkMode, previewAppearance, revertPreview, setAppearance, type Appearance, type FontOption, type RhythmOption,
} from "./appearance/appearance";

const TWEAKCN = "https://github.com/jnsahaj/tweakcn";
const heading = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <>
      <label htmlFor={htmlFor} className={heading}>{label}</label>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </>
  );
}

function FontRow({ label, id, value, custom, placeholder, fonts, onChange }: {
  label: string; id: string; value: string; custom: string; placeholder: string; fonts: FontOption[];
  onChange: (patch: { choice?: string; custom?: string }) => void;
}) {
  return (
    <Row label={label} htmlFor={id}>
      <Select id={id} className="h-8 w-72 shrink-0 text-xs" value={value} onChange={(e) => onChange({ choice: e.target.value })}>
        <option value="theme">Theme default</option>
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

/** px stepper: typing, arrows, +/- buttons, clamped to FONT_SIZE_MIN..MAX, with Reset. */
function SizeField({ id, label, value, fallback, onChange }: {
  id: string; label: string; value: number; fallback: number; onChange: (n: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const set = (n: number) => {
    setText(null);
    if (Number.isFinite(n)) onChange(clampFontSize(n));
  };
  return (
    <>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="outline" className="size-8" aria-label={`Decrease ${label}`} disabled={value <= FONT_SIZE_MIN} onClick={() => set(value - 1)}>
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
              if (v && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX) onChange(n);
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
        <Button size="icon" variant="outline" className="size-8" aria-label={`Increase ${label}`} disabled={value >= FONT_SIZE_MAX} onClick={() => set(value + 1)}>
          <Plus />
        </Button>
      </div>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={value === fallback} onClick={() => set(fallback)}>
        Reset
      </Button>
    </>
  );
}

/** Theme preset, color mode, fonts and text size. Changes apply and save right away. */
export function AppearancePanel() {
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
      <SectionHeader title="Appearance" description="Theme, color mode, fonts and text sizes for all windows." />

      <div className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-3">
        <Row label="Mode">
          <div role="group" aria-label="Mode" className="inline-flex shrink-0 rounded-md border p-0.5">
            {MODES.map((m) => (
              <button
                key={m}
                aria-pressed={a.mode === m}
                onClick={() => update({ mode: m })}
                className={cn("rounded px-2.5 py-1 text-xs capitalize", a.mode === m ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/50")}
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
          <a href={TWEAKCN} target="_blank" rel="noreferrer" onClick={(e) => openExternal(e, TWEAKCN)} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Themes from tweakcn
          </a>
        </Row>
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
        <Row label="Chat font size" htmlFor="chat-font-size">
          <SizeField id="chat-font-size" label="chat font size" value={a.chatFontSize} fallback={DEFAULT_APPEARANCE.chatFontSize} onChange={(chatFontSize) => update({ chatFontSize })} />
        </Row>
        <RhythmRow label="Chat leading" id="chat-leading" value={a.leading} options={LEADINGS} onChange={(leading) => update({ leading })} />
        <RhythmRow label="Chat flow" id="chat-flow" value={a.flow} options={FLOWS} onChange={(flow) => update({ flow })} />
      </div>
    </div>
  );
}
