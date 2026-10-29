import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button, Input, Select, cn } from "@harness/ui";
import { SectionHeader } from "./SectionHeader";
import { ThemePicker } from "./ThemePicker";
import { openExternal } from "./openExternal";
import {
  CUSTOM_FONT_MAX, DEFAULT_APPEARANCE, FONT_SIZE_MAX, FONT_SIZE_MIN, MODES, MONO_FONTS, SANS_FONTS, clampFontSize, cleanFont,
  getAppearance, isDarkMode, previewAppearance, revertPreview, setAppearance, type Appearance, type FontOption,
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

/** Theme preset, color mode, fonts and text size. Changes apply and save right away. */
export function AppearancePanel() {
  const [a, setA] = useState<Appearance>(getAppearance);
  const [sizeText, setSizeText] = useState<string | null>(null);
  const update = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch };
    setA(next);
    setAppearance(next);
  };
  // Leaving the panel mid-preview restores the saved theme.
  useEffect(() => revertPreview, []);
  const isDark = isDarkMode(a.mode, window);
  const setSize = (n: number) => {
    setSizeText(null);
    if (Number.isFinite(n)) update({ fontSize: clampFontSize(n) });
  };

  return (
    <div className="text-sm">
      <SectionHeader title="Appearance" description="Theme, color mode, fonts and text size for all windows.">
        <div role="group" aria-label="Color mode" className="inline-flex shrink-0 rounded-md border p-0.5">
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
      </SectionHeader>

      <div className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-3">
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
        <Row label="Font size" htmlFor="font-size">
          <div className="flex items-center gap-1">
            <Button size="icon" variant="outline" className="size-8" aria-label="Decrease font size" disabled={a.fontSize <= FONT_SIZE_MIN} onClick={() => setSize(a.fontSize - 1)}>
              <Minus />
            </Button>
            <div className="relative">
              <Input
                id="font-size"
                inputMode="numeric"
                className="h-8 w-16 pl-2 pr-7 text-right text-xs tabular-nums"
                value={sizeText ?? String(a.fontSize)}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d]/g, "").slice(0, 2);
                  setSizeText(v);
                  const n = Number(v);
                  if (v && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX) update({ fontSize: n });
                }}
                onBlur={() => sizeText !== null && setSize(sizeText ? Number(sizeText) : a.fontSize)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    setSize(a.fontSize + (e.key === "ArrowUp" ? 1 : -1));
                  } else if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">px</span>
            </div>
            <Button size="icon" variant="outline" className="size-8" aria-label="Increase font size" disabled={a.fontSize >= FONT_SIZE_MAX} onClick={() => setSize(a.fontSize + 1)}>
              <Plus />
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={a.fontSize === DEFAULT_APPEARANCE.fontSize} onClick={() => setSize(DEFAULT_APPEARANCE.fontSize)}>
            Reset
          </Button>
        </Row>
      </div>
    </div>
  );
}
